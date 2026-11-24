'use strict';
// Tauri köprüsü: arayüzün kullandığı window.kesit API'sini Tauri komutlarıyla sağlar.
// Electron sürümündeki main.js mantığının karşılığı. Kesim planları ffcore.js'te (ortak).
(function () {
  const T = window.__TAURI__;
  const { invoke, Channel, convertFileSrc } = T.core;
  const P = window.KesitPath;
  const C = window.KesitCore;
  const appWindow = T.window.getCurrentWindow();

  const VIDEO_ERR_UNREADABLE = 'Bu dosya okunamadı. Bir video dosyası olduğundan emin ol.';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fileUrl = (p) => convertFileSrc(p);

  // ---- Basit olay yayıncısı ----
  const subs = {};
  const on = (name) => (cb) => {
    (subs[name] = subs[name] || new Set()).add(cb);
    return () => subs[name].delete(cb);
  };
  const emit = (name, ...a) => { for (const cb of subs[name] || []) { try { cb(...a); } catch (e) { console.error(e); } } };

  // ---- ffmpeg ----
  let jobSeq = 1;

  // ffmpeg'i çalıştırır; hata olursa Node sürümündeki gibi { message, stderr, killed } taşıyan Error fırlatır.
  async function run(args, { duration = 0, onProgress, onJob } = {}) {
    const job = jobSeq++;
    if (onJob) onJob(job);
    const ch = new Channel();
    ch.onmessage = (us) => { if (onProgress && duration > 0) onProgress(Math.min(1, us / 1e6 / duration)); };
    const r = await invoke('ff_run', { args, job, onProgress: ch });
    if (r.code !== 0) {
      const err = new Error(C.lastError(r.stderr) || `ffmpeg hata kodu ${r.code}`);
      err.killed = r.killed;
      err.stderr = r.stderr;
      throw err;
    }
    return r;
  }
  const kill = (job) => (job ? invoke('ff_kill', { job }).catch(() => {}) : Promise.resolve());
  const capture = (args, { binary = false, timeoutMs = 30000 } = {}) =>
    invoke('ff_capture', { args, binary, timeoutMs });

  async function probeInfo(file) {
    const { stderr } = await capture(['-hide_banner', '-i', file]);
    if (C.probeError(stderr)) throw new Error(VIDEO_ERR_UNREADABLE);
    const info = C.parseProbe(stderr);
    if (!info.hasVideo) throw new Error('Bu dosyada video bulunamadı.');
    return info;
  }

  // ---- Dosya yardımcıları ----
  const exists = (p) => invoke('fs_exists', { path: p });
  const rename = (from, to) => invoke('fs_rename', { from, to });
  const remove = (p) => invoke('fs_remove', { path: p }).catch(() => {});
  const setHidden = (p, hidden) => invoke('set_hidden', { path: p, hidden }).catch(() => {});
  const trash = (p) => invoke('trash_item', { path: p });
  const mkdtemp = (prefix) => invoke('fs_mkdtemp', { prefix });
  const errObj = (e) => (e instanceof Error ? e : new Error(String(e)));

  async function uniquePath(dir, base, ext) {
    let p = P.join(dir, `${base}${ext}`);
    let i = 2;
    while (await exists(p)) p = P.join(dir, `${base}_${i++}${ext}`);
    return p;
  }

  // Windows'ta dosya kısa süre kilitli kalabilir; birkaç kez dener.
  async function retry(fn, tries = 15, wait = 200) {
    for (let i = 0; ; i++) {
      try { return await fn(); } catch (e) {
        if (i >= tries - 1) throw errObj(e);
        await sleep(wait);
      }
    }
  }

  // Çizim katmanı (saydam PNG, data URL) ffmpeg'e dosya olarak verilir.
  async function writeOverlay(dataUrl, dir) {
    const m = /^data:image\/png;base64,(.+)$/.exec(dataUrl || '');
    if (!m) throw new Error('Çizim katmanı okunamadı.');
    const p = P.join(dir, 'cizimler.png');
    await invoke('fs_write_base64', { path: p, data: m[1] });
    return p;
  }

  // ---- Geri alınabilir kaydetme (main.js ile aynı akış) ----
  let pendingBackup = null; // { original, backup }

  async function commitBackup() {
    const pb = pendingBackup;
    pendingBackup = null;
    if (!pb) return { backupKept: null };
    try {
      await retry(() => trash(pb.backup), 5);
      return { backupKept: null };
    } catch (_) {
      await setHidden(pb.backup, false);
      return { backupKept: pb.backup };
    }
  }

  async function replaceOriginal(original, temp) {
    await commitBackup();
    const dir = P.dirname(original), ext = P.extname(original);
    const backup = await uniquePath(dir, `.${P.basename(original, ext)}.kesit-yedek`, ext);
    await retry(() => rename(original, backup));
    try {
      await retry(() => rename(temp, original), 5);
    } catch (e) {
      await rename(backup, original).catch(() => {});
      throw e;
    }
    await setHidden(backup, true);
    pendingBackup = { original, backup };
  }

  async function undoSave() {
    const pb = pendingBackup;
    if (!pb || !(await exists(pb.backup))) return { ok: false, error: 'Geri alınacak bir kaydetme yok.' };
    const ext = P.extname(pb.original);
    const edited = await uniquePath(P.dirname(pb.original), `.${P.basename(pb.original, ext)}.kesit-duzenlenen`, ext);
    try {
      await retry(() => rename(pb.original, edited));
      try {
        await retry(() => rename(pb.backup, pb.original), 5);
      } catch (e) {
        await rename(edited, pb.original).catch(() => {});
        throw e;
      }
    } catch (e) {
      return { ok: false, error: C.friendlyError(errObj(e)) };
    }
    pendingBackup = null;
    await setHidden(pb.original, false);
    try { await retry(() => trash(edited), 5); } catch (_) { await remove(edited); }
    return { ok: true, file: pb.original };
  }

  // ---- Önizleme kopyası ----
  let proxyJob = 0;
  let proxyToken = 0;

  // ---- Dışa aktarma ----
  let exportJob = 0;
  let exportCanceled = false;

  async function exportVideo(opts) {
    const overwrite = !!opts.overwrite;
    if (overwrite) {
      const ext = P.extname(opts.input).toLowerCase();
      const q = opts.crop || opts.resize ? 'precise' : opts.quality;
      if (q === 'precise' && ext === '.webm') {
        return { ok: false, error: 'WebM dosyasının üzerine hassas modda yazılamıyor. Farklı kaydet ile MP4 olarak kaydet.' };
      }
      const base = P.basename(opts.input, P.extname(opts.input));
      opts = { ...opts, output: P.join(P.dirname(opts.input), `.${base}.kesit-gecici-${Date.now()}${P.extname(opts.input)}`) };
    } else if (P.same(opts.output, opts.input)) {
      return { ok: false, error: 'Farklı kaydette kaynak dosya seçilemez. Üzerine yazmak için Kaydet\'i kullan.' };
    }
    const tmpDir = await mkdtemp('is-');
    exportCanceled = false;
    let plan;
    try {
      if (opts.overlay) opts = { ...opts, overlay: await writeOverlay(opts.overlay, tmpDir) };
      plan = C.buildExportPlan({ ...opts, tmpDir });
    } catch (e) {
      invoke('fs_remove_dir', { path: tmpDir }).catch(() => {});
      return { ok: false, error: errObj(e).message };
    }
    const total = plan.steps.reduce((s, x) => s + x.duration, 0) || 1;
    let done = 0;
    try {
      for (const step of plan.steps) {
        if (exportCanceled) throw Object.assign(new Error('İptal edildi'), { killed: true });
        if (step.writeFile) await invoke('fs_write_text', { path: step.writeFile.path, text: step.writeFile.content });
        emit('export-progress', { p: done / total, label: step.label });
        await run(step.args, {
          duration: step.duration,
          onProgress: (p) => emit('export-progress', { p: (done + p * step.duration) / total, label: step.label }),
          onJob: (j) => { exportJob = j; }
        });
        done += step.duration;
      }
      emit('export-progress', { p: 1, label: 'Bitti' });
      if (overwrite) {
        emit('export-progress', { p: 1, label: 'Dosya değiştiriliyor' });
        try {
          await replaceOriginal(opts.input, opts.output);
          return { ok: true, output: opts.input, overwritten: true, undoable: true, outW: plan.outW, outH: plan.outH, duration: plan.outDuration };
        } catch (e) {
          return { ok: false, error: `${C.friendlyError(errObj(e))} Yeni video hazır, şurada duruyor: ${opts.output}`, keepOutput: true };
        }
      }
      return { ok: true, output: opts.output, outW: plan.outW, outH: plan.outH, duration: plan.outDuration };
    } catch (e) {
      await remove(opts.output);
      if (exportCanceled || (e && e.killed)) return { ok: false, canceled: true };
      return { ok: false, error: C.friendlyError(errObj(e)) };
    } finally {
      exportJob = 0;
      invoke('fs_remove_dir', { path: tmpDir }).catch(() => {});
    }
  }

  // ---- Yakınlaştırma ----
  const ZOOM_MIN = 0.8, ZOOM_MAX = 1.5;
  let settings = {};
  const settingsReady = invoke('get_settings').then((s) => { settings = s || {}; }).catch(() => {});
  async function applyZoom(z, announce) {
    z = Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)) * 10) / 10;
    await invoke('set_zoom', { zoom: z }).catch(() => {});
    if (settings.zoom !== z) {
      settings.zoom = z;
      invoke('set_settings', { value: settings }).catch(() => {});
    }
    if (announce) emit('zoom-changed', z);
    return z;
  }
  settingsReady.then(() => { if (settings.zoom && settings.zoom !== 1) applyZoom(settings.zoom, false); });

  // ---- Pencere başlığı: document.title değişince pencereye yansıt ----
  const syncTitle = () => appWindow.setTitle(document.title || 'Kesit').catch(() => {});
  document.addEventListener('DOMContentLoaded', () => {
    const t = document.querySelector('title');
    if (t) new MutationObserver(syncTitle).observe(t, { childList: true, characterData: true, subtree: true });
    syncTitle();
  });

  // ---- Sürükle bırak (dosya yolu yalnızca yerel olaydan gelir) ----
  T.event.listen('tauri://drag-enter', () => document.body.classList.add('dragging'));
  T.event.listen('tauri://drag-leave', () => document.body.classList.remove('dragging'));
  const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);
  T.event.listen('tauri://drag-drop', (e) => {
    document.body.classList.remove('dragging');
    const p = ((e.payload && e.payload.paths) || [])[0];
    if (!p) return;
    emit(IMAGE_EXT.has(P.extname(p).toLowerCase()) ? 'open-image' : 'open-file', p);
  });
  T.event.listen('open-file', (e) => { if (e.payload) emit('open-file', e.payload); });

  // ---- Kapanırken bekleyen yedeği Geri Dönüşüm Kutusu'na gönder ----
  let beforeClose = null; // arayüz: kaydedilmemiş değişiklikleri sorar, false dönerse kapanmaz
  appWindow.onCloseRequested(async (event) => {
    if (beforeClose && !(await beforeClose())) { event.preventDefault(); return; }
    if (exportJob) await kill(exportJob);
    if (proxyJob) await kill(proxyJob);
    if (pendingBackup) await commitBackup();
  });

  window.kesit = {
    nativeDrop: true,
    initialFile: () => invoke('initial_file'),
    openDialog: () => invoke('pick_video'),

    probe: async (file) => {
      try {
        const info = await probeInfo(file);
        const st = await invoke('fs_stat', { path: file });
        if (!st) throw new Error('Dosya bulunamadı; taşınmış ya da silinmiş olabilir.');
        return { ok: true, info, file, name: P.basename(file), size: st.size, url: fileUrl(file) };
      } catch (e) {
        return { ok: false, error: C.friendlyError(errObj(e)) };
      }
    },

    thumbs: async ({ file, duration, count, height }) => {
      const times = Array.from({ length: count }, (_, i) => Math.min(duration - 0.05, ((i + 0.5) / count) * duration));
      const out = new Array(count).fill(null);
      let next = 0;
      const worker = async () => {
        while (next < count) {
          const i = next++;
          try {
            const { stdout } = await capture(C.thumbArgs(file, Math.max(0, times[i]), height), { binary: true, timeoutMs: 20000 });
            if (stdout.length > 140) out[i] = 'data:image/jpeg;base64,' + stdout;
          } catch (_) { /* bu kareyi atla */ }
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      return out;
    },

    proxy: async ({ file, info }) => {
      await kill(proxyJob);
      const token = ++proxyToken;
      const root = await invoke('temp_root');
      const out = P.join(root, `onizleme-${token}.mp4`);
      try {
        await run(C.proxyArgs(file, out, info), {
          duration: info.duration,
          onProgress: (p) => { if (token === proxyToken) emit('proxy-progress', p); },
          onJob: (j) => { proxyJob = j; }
        });
        if (token !== proxyToken) return { ok: false, canceled: true };
        return { ok: true, url: fileUrl(out) };
      } catch (e) {
        return { ok: false, canceled: token !== proxyToken || !!(e && e.killed), error: C.friendlyError(errObj(e)) };
      }
    },
    cancelProxy: async () => { proxyToken++; await kill(proxyJob); },

    saveDialog: async ({ input, suffix, ext, kind }) => {
      const dir = P.dirname(input);
      const base = P.basename(input, P.extname(input)) + suffix;
      const png = kind === 'png';
      let p = await invoke('pick_save', {
        title: png ? 'Kareyi kaydet' : 'Videoyu dışa aktar',
        defaultPath: await uniquePath(dir, base, ext),
        filterName: png ? 'PNG görseli' : 'Video',
        ext
      });
      if (!p) return null;
      if (!P.extname(p)) p += ext;
      return p;
    },

    exportVideo,
    cancelExport: async () => { exportCanceled = true; await kill(exportJob); },

    saveFrame: async (opts) => {
      let dir = null;
      try {
        if (opts.overlay) { dir = await mkdtemp('kare-'); opts = { ...opts, overlay: await writeOverlay(opts.overlay, dir) }; }
        await run(C.frameArgs(opts));
        return { ok: true, output: opts.output };
      } catch (e) {
        return { ok: false, error: C.friendlyError(errObj(e)) };
      } finally {
        if (dir) invoke('fs_remove_dir', { path: dir }).catch(() => {});
      }
    },

    undoSave,
    commitSave: () => commitBackup(),
    clipboardImage: async () => null, // arayüz yapıştırma olayını kullanır
    showInFolder: (p) => invoke('reveal', { path: p }).catch(() => {}),
    openPath: (p) => invoke('open_path', { path: p }).then(() => '', (e) => String(e)),
    pathForFile: () => '',

    onOpenFile: on('open-file'),
    onOpenImage: on('open-image'),
    onBeforeClose: (fn) => { beforeClose = fn; },
    pickImage: () => invoke('pick_image'),
    readImage: async (p) => {
      const r = await fetch(fileUrl(p));
      if (!r.ok) throw new Error('Görsel okunamadı');
      return r.blob();
    },
    clipboardTarget: ({ input, ext }) => invoke('clipboard_target', { name: P.basename(input, P.extname(input)) + '_kesit' + ext }),
    copyFileToClipboard: (path) => invoke('clipboard_copy_file', { path }).then(() => ({ ok: true }), (e) => ({ ok: false, error: String(e) })),
    fileSize: async (path) => { const st = await invoke('fs_stat', { path }); return st ? st.size : 0; },
    isWindows: /Windows/.test(navigator.userAgent),
    classicMenuGet: () => invoke('classic_menu_get'),
    classicMenuSet: (on) => invoke('classic_menu_set', { on }).then(() => ({ ok: true }), (e) => ({ ok: false, error: String(e) })),
    restartExplorer: () => invoke('restart_explorer').catch(() => {}),
    appVersion: () => T.app.getVersion(),
    quit: () => appWindow.close(),
    openUrl: (url) => invoke('open_url', { url }).catch(() => {}),
    checkUpdate: async () => { await settingsReady; return invoke('update_check', { preview: !!settings.preview }); },
    getPreview: async () => { await settingsReady; return !!settings.preview; },
    setPreview: async (on) => { await settingsReady; settings.preview = !!on; await invoke('set_settings', { value: settings }).catch(() => {}); },
    installUpdate: async (onProgress) => {
      const ch = new Channel();
      ch.onmessage = (p) => onProgress && onProgress(p);
      try { await invoke('update_install', { onProgress: ch }); return { ok: true }; }
      catch (e) { return { ok: false, error: `İnternet bağlantını kontrol edip tekrar dene. (Ayrıntı: ${String(e).slice(0, 140)})` }; }
    },
    onZoomChanged: on('zoom-changed'),
    getZoom: async () => { await settingsReady; return settings.zoom || 1; },
    zoomStep: async (step) => { await settingsReady; return applyZoom(step === 0 ? 1 : (settings.zoom || 1) + step * 0.1, true); },
    onExportProgress: on('export-progress'),
    onProxyProgress: on('proxy-progress')
  };
})();
