// Kesit'in Tauri sürümü için uçtan uca sınama. Sayfaya debug sürümünde enjekte edilir:
//   KESIT_SELFTEST=<derlenmiş betik> target/debug/kesit
// tests/run-selftest.sh betiğin başına MEDIA ve WORK değişkenlerini ekler.
(async () => {
  const { invoke } = window.__TAURI__.core;
  const results = [];
  let fail = 0;
  const report = (text, done = false) => invoke('selftest_report', { text, done });
  const ok = (name, cond, extra) => {
    if (!cond) fail++;
    results.push({ name, ok: !!cond, extra });
    return report(`${cond ? 'OK  ' : 'FAIL'} ${name}${extra !== undefined ? ' — ' + JSON.stringify(extra) : ''}`);
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 15000, step = 100) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { try { const v = await fn(); if (v) return v; } catch (_) {} await sleep(step); }
    return null;
  };
  const sep = MEDIA.includes('\\') ? '\\' : '/';
  const media = (n) => MEDIA + sep + n;
  const work = (n) => WORK + sep + n;
  const copy = async (src, dst) => {
    const r = await invoke('ff_capture', { args: ['-y', '-hide_banner', '-i', src, '-map', '0', '-c', 'copy', dst], binary: false, timeoutMs: 30000 });
    if (r.code !== 0) throw new Error('kopyalanamadı ' + r.stderr.slice(-200));
  };

  try {
    await until(() => window.__kesit && window.kesit, 5000);
    const api = window.kesit;
    const K = window.__kesit;
    const P = window.KesitPath;
    const v = document.getElementById('video') || document.querySelector('video');

    // --- Yol yardımcıları ---
    await ok('pathx windows', P.join('C:\\a\\b', 'c.mp4') === 'C:\\a\\b\\c.mp4' && P.dirname('C:\\a\\b.mp4') === 'C:\\a' &&
      P.dirname('C:\\b.mp4') === 'C:\\' && P.basename('C:\\a\\b.mp4', '.mp4') === 'b' && P.extname('C:\\a.b\\c') === '' &&
      P.same('C:\\A\\x.MP4', 'c:/a/x.mp4'));
    await ok('pathx posix', P.join('/tmp/x', 'y.txt') === '/tmp/x/y.txt' && P.dirname('/a.mp4') === '/' && P.extname('/x/.gizli') === '' &&
      !P.same('/a/X.mp4', '/a/x.mp4'));

    // --- Aç, oynat, küçük resimler ---
    await copy(media('land.mp4'), work('land.mp4'));
    const probe = await api.probe(work('land.mp4'));
    await ok('probe', probe.ok && Math.abs(probe.info.duration - 10) < 0.1 && probe.info.width === 1920 && probe.size > 1000, probe.ok ? probe.url : probe.error);
    await K.openFile(work('land.mp4'));
    // Linux'taki WebKitGTK, asset:// gibi özel şemalardan video akıtamıyor (Tauri'nin bilinen kısıtı).
    // Hedef Windows (WebView2, http://asset.localhost); oynatma sınamaları orada çalışır.
    const canPlay = !/Linux/.test(navigator.userAgent) && v.canPlayType('video/mp4; codecs="avc1.640028"') !== '';
    const skip = (name, why) => report(`SKIP ${name} — ${why}`);
    if (canPlay) {
      const ready = await until(() => v.readyState >= 2 && v.videoWidth === 1920, 15000);
      await ok('video asset protokolüyle yüklendi', ready, { rs: v.readyState, w: v.videoWidth, err: v.error && v.error.code });
      v.currentTime = 7.5;
      await ok('ileri sarma', await until(() => !v.seeking && Math.abs(v.currentTime - 7.5) < 0.2 && v.readyState >= 2, 8000), v.currentTime);
    } else {
      await skip('video oynatma', 'Linux WebKitGTK özel şemadan video oynatmıyor');
    }
    // Asset protokolü parçalı istekleri (Range) desteklemeli; video ileri sarma buna dayanır.
    const rr = await fetch(probe.url, { headers: { Range: 'bytes=100-199' } });
    const rb = await rr.arrayBuffer();
    await ok('asset protokolü Range yanıtı', rr.status === 206 && rb.byteLength === 100 && /video\/mp4/.test(rr.headers.get('content-type') || ''),
      { s: rr.status, n: rb.byteLength, ct: rr.headers.get('content-type') });
    const thumbs = await until(() => [...document.querySelectorAll('#track img, .strip img')].filter((i) => i.src.startsWith('data:image/jpeg')).length >= 3, 20000);
    await ok('küçük resimler', thumbs);
    await ok('pencere başlığı', document.title.startsWith('land.mp4'), document.title);

    // --- Üzerine kaydet + geri al ---
    K.setIn(2); K.setOut(6);
    await sleep(200);
    document.getElementById('btnExport').click();
    const saved = await until(async () => {
      const t = document.getElementById('toast');
      return !t.hidden && /Kaydedildi|kaydedildi/.test(t.textContent) ? t.textContent : null;
    }, 30000);
    await ok('Kaydet (üzerine yaz)', saved, saved);
    const after = await api.probe(work('land.mp4'));
    await ok('kaydedilen süre 4 sn', after.ok && Math.abs(after.info.duration - 4) < 0.15, after.ok && after.info.duration);
    const backups = await invoke('ff_capture', { args: ['-hide_banner', '-i', work('.land.kesit-yedek.mp4')], binary: false });
    await ok('gizli yedek duruyor', /Duration: 00:00:10/.test(backups.stderr));
    const undo = await api.undoSave();
    const back = await api.probe(work('land.mp4'));
    await ok('Geri al eski hali getirdi', undo.ok && back.ok && Math.abs(back.info.duration - 10) < 0.1, undo);
    await ok('yedek kalmadı', !(await invoke('fs_exists', { path: work('.land.kesit-yedek.mp4') })));

    // --- Farklı kaydet: kırpma + çizim katmanı ---
    const ovl = await (async () => {
      const c = document.createElement('canvas'); c.width = 1920; c.height = 1080;
      const g = c.getContext('2d'); g.strokeStyle = '#ff3b30'; g.lineWidth = 40; g.strokeRect(100, 100, 600, 400);
      return c.toDataURL('image/png');
    })();
    const out1 = work('kirpik.mp4');
    let lastP = 0;
    const offP = api.onExportProgress(({ p }) => { lastP = p; });
    const r1 = await api.exportVideo({
      input: work('land.mp4'), output: out1, overwrite: false, info: probe.info, start: 1, end: 4, mode: 'keep', quality: 'precise',
      crop: { x: 0.25, y: 0, w: 0.5, h: 1, ratio: null }, mute: false, resize: false, overlay: ovl
    });
    offP();
    const p1 = await api.probe(out1);
    await ok('kırpma + çizim dışa aktarma', r1.ok && p1.ok && p1.info.width === 960 && p1.info.height === 1080 && Math.abs(p1.info.duration - 3) < 0.15,
      r1.ok ? { w: p1.info && p1.info.width, d: p1.info && p1.info.duration } : r1.error);
    await ok('ilerleme bildirildi', lastP >= 0.99, lastP);
    // Çizimin piksel kontrolü: (100,100)+kırpma 480 → kırpılmış karede x≈0..220 kırmızı kenar
    const px = await invoke('ff_capture', { args: ['-hide_banner', '-ss', '0.5', '-i', out1, '-frames:v', '1', '-vf', 'crop=2:2:20:110,format=rgb24', '-f', 'rawvideo', 'pipe:1'], binary: true });
    const bytes = Uint8Array.from(atob(px.stdout), (c) => c.charCodeAt(0));
    await ok('çizim videoya işlendi', bytes[0] > 200 && bytes[1] < 110 && bytes[2] < 110, [...bytes.slice(0, 3)]);

    // --- Çıkar modu (hızlı, concat listesi) ---
    const out2 = work('cikar.mp4');
    const r2 = await api.exportVideo({
      input: work('land.mp4'), output: out2, overwrite: false, info: probe.info, start: 3, end: 5, mode: 'remove', quality: 'fast',
      crop: null, mute: true, resize: false, overlay: null
    });
    const p2 = await api.probe(out2);
    await ok('çıkar + hızlı + sessiz', r2.ok && p2.ok && p2.info.duration > 7 && p2.info.duration < 9.2 && !p2.info.hasAudio, r2.ok ? p2.info && p2.info.duration : r2.error);

    // --- Aynı dosyaya farklı kaydet engeli ---
    const r3 = await api.exportVideo({ input: work('land.mp4'), output: work('land.mp4'), overwrite: false, info: probe.info, start: 0, end: 2, mode: 'keep', quality: 'fast' });
    await ok('kaynağın üzerine farklı kaydet engellendi', !r3.ok && /kaynak/.test(r3.error));

    // --- İptal ---
    const pr = api.exportVideo({ input: work('land.mp4'), output: work('iptal.mp4'), overwrite: false, info: probe.info, start: 0, end: 10, mode: 'keep', quality: 'precise', resize: true });
    await sleep(700);
    await api.cancelExport();
    const r4 = await pr;
    await ok('iptal', !r4.ok && r4.canceled && !(await invoke('fs_exists', { path: work('iptal.mp4') })), r4);

    // --- Kare kaydet ---
    const png = work('kare.png');
    const r5 = await api.saveFrame({ input: work('land.mp4'), time: 2, info: probe.info, crop: null, output: png, overlay: ovl });
    const st = await invoke('fs_stat', { path: png });
    await ok('kareyi PNG kaydet', r5.ok && st && st.size > 10000, r5.ok ? st : r5.error);

    // --- Türkçe karakterli, tırnaklı dosya adı + önizleme kopyası ---
    const tr = work("Çekim şık 'özel' #1.mov");
    await copy(media("Çekim şık 'özel' #1.mov"), tr);
    const p6 = await api.probe(tr);
    await ok('özel karakterli dosya', p6.ok && p6.name === "Çekim şık 'özel' #1.mov", p6.ok ? p6.url : p6.error);
    const pxy = await api.proxy({ file: tr, info: p6.info });
    await ok('önizleme kopyası', pxy.ok && pxy.url, pxy);
    if (pxy.ok && canPlay) {
      v.src = pxy.url; v.load();
      await ok('önizleme kopyası oynatılabiliyor', await until(() => v.readyState >= 2, 10000), v.readyState);
    }

    // --- Yakınlaştırma ---
    const z = await api.zoomStep(1);
    await ok('yakınlaştırma', Math.abs(z - 1.1) < 0.01 && Math.abs((await api.getZoom()) - 1.1) < 0.01, z);
    await api.zoomStep(0);

    // --- Bozuk dosya ---
    await invoke('fs_write_text', { path: work('bozuk.mp4'), text: 'bu bir video değil' });
    const p7 = await api.probe(work('bozuk.mp4'));
    await ok('bozuk dosya anlaşılır hata', !p7.ok && /okunamadı|bozuk/.test(p7.error), p7.error);
  } catch (e) {
    await ok('beklenmeyen hata', false, String(e && e.stack || e));
  }
  await report(JSON.stringify({ pass: results.filter((r) => r.ok).length, fail }), true);
})();
