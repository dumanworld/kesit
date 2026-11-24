'use strict';
(() => {
  const api = window.kesit;
  const G = window.KesitGeometry;
  const $ = (id) => document.getElementById(id);

  // Tema: açık (varsayılan) ya da koyu; Görünüm menüsünden değişir, hatırlanır.
  let theme = 'light';
  try { if (localStorage.getItem('kesit.theme') === 'dark') theme = 'dark'; } catch (_) { /* depolama yok */ }
  // Windows başlık çubuğu da aynı renge boyanır (--bg zemin, --text yazı)
  const colorRef = (css) => {
    const m = /^#([0-9a-f]{6})$/i.exec(css.trim());
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return ((n & 0xff) << 16) | (n & 0xff00) | ((n >> 16) & 0xff); // 0x00BBGGRR
  };
  const applyTheme = () => {
    document.documentElement.dataset.theme = theme;
    const cs = getComputedStyle(document.documentElement);
    const bg = colorRef(cs.getPropertyValue('--bg')), fg = colorRef(cs.getPropertyValue('--text'));
    if (api.setTitlebar && bg !== null && fg !== null) api.setTitlebar(theme === 'dark', bg, fg);
  };
  applyTheme();
  function toggleTheme() {
    theme = theme === 'dark' ? 'light' : 'dark';
    applyTheme();
    try { localStorage.setItem('kesit.theme', theme); } catch (_) { /* depolama yok */ }
  }

  const el = {
    app: $('app'), stage: $('stage'), viewport: $('viewport'), video: $('video'),
    frameLayer: $('frameLayer'), crop: $('crop'), cropLabel: $('cropLabel'),
    stageMsg: $('stageMsg'), stageMsgBar: $('stageMsgBar'), stageMsgTitle: $('stageMsgTitle'), stageMsgText: $('stageMsgText'),
    fProxy: $('fProxy'), fastHint: $('fastHint'), optFastWrap: $('optFastWrap'), optFast: $('optFast'),
    btnMenu: $('btnMenu'), menu: $('menu'), sumFlags: $('sumFlags'),
    optMute: $('optMute'), optMuteWrap: $('optMuteWrap'), muteHint: $('muteHint'), optResize: $('optResize'),
    sumDur: $('sumDur'), sumSize: $('sumSize'), btnExport: $('btnExport'), btnSaveAs: $('btnSaveAs'), btnFrame: $('btnFrame'),
    btnPlay: $('btnPlay'), tNow: $('tNow'), tTotal: $('tTotal'),
    inTime: $('inTime'), outTime: $('outTime'),
    btnPreview: $('btnPreview'),
    ruler: $('ruler'), track: $('track'), strip: $('strip'), shadeL: $('shadeL'), shadeR: $('shadeR'),
    sel: $('sel'), hIn: $('hIn'), hOut: $('hOut'), playhead: $('playhead'),
    exportModal: $('exportModal'), exLabel: $('exLabel'), exBar: $('exBar'), exPct: $('exPct'), btnCancel: $('btnCancel'),
    toast: $('toast'), toastText: $('toastText'), toastActions: $('toastActions'), toastClose: $('toastClose'),
    btnAppMenu: $('btnAppMenu'), appMenu: $('appMenu')
  };
  const v = el.video;

  const RATIOS = { orig: null, free: null, '9:16': 9 / 16, '4:5': 4 / 5, '1:1': 1, '16:9': 16 / 9 };

  const state = {
    file: null, info: null, duration: 0, srcExt: '.mp4',
    inT: 0, outT: 0, now: 0, segs: [], cropEdit: false, cutEdit: false, // segs: kalacak parçalar [[başlangıç, bitiş], …], sıralı ve çakışmasız
    mode: 'keep', quality: 'precise', ratioKey: 'orig', crop: null, mute: false, resize: false,
    proxy: false, proxyFor: null, loadToken: 0, loadTimer: null,
    drag: null, cropDrag: null, pendingSeek: null, preview: null, raf: null,
    exporting: false
  };

  // ---------- Yardımcılar ----------
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const pad = (n) => String(n).padStart(2, '0');

  function fmtTime(t) {
    if (!isFinite(t) || t < 0) t = 0;
    const cs = Math.round(t * 100);
    const total = Math.floor(cs / 100), c = cs % 100;
    const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
    return (h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`) + `.${pad(c)}`;
  }
  function fmtShort(t, step) {
    const m = Math.floor(t / 60), s = t - m * 60;
    if (step < 1) return `${m}:${s.toFixed(1).padStart(4, '0')}`;
    return `${m}:${pad(Math.round(s))}`;
  }
  function parseTime(str) {
    const s = String(str).trim().replace(/,/g, '.');
    if (!s) return NaN;
    const parts = s.split(':');
    if (parts.length > 3 || parts.some((p) => !/^\d*\.?\d*$/.test(p) || p === '' || p === '.')) return NaN;
    return parts.reduce((acc, p) => acc * 60 + parseFloat(p), 0);
  }
  const fps = () => (state.info && state.info.fps) || 30;
  const snap = (t) => clamp(Math.round(t * fps()) / fps(), 0, state.duration);
  const minGap = () => 1 / fps();

  function videoDims() {
    const vw = v.videoWidth || (state.info && state.info.width) || 16;
    const vh = v.videoHeight || (state.info && state.info.height) || 9;
    return { vw, vh, va: vw / vh };
  }
  function effectiveQuality() {
    return state.crop || state.resize || (state.annos && state.annos.length) ? 'precise' : state.quality;
  }
  // Kaydet'in yapacak bir işi var mı? (değişmemiş dosyayı yeniden kodlayıp üzerine yazmasın)
  function hasEdits() {
    if (!state.info) return false;
    const half = 0.5 / fps();
    const sg = state.segs;
    const trimmed = !(sg.length === 1 && sg[0][0] <= half && sg[0][1] >= state.duration - half);
    return trimmed || !!state.crop || state.resize || state.annos.length > 0 || (state.mute && state.info.hasAudio);
  }
  function outputDuration() {
    return state.segs.reduce((s, [a, b]) => s + (b - a), 0);
  }
  // Parça listesini düzenler: sıralar, sınırlar, çakışan ya da bitişik parçaları birleştirir, çok kısaları atar.
  function normSegs(list) {
    const D = state.duration, g = minGap();
    const xs = list.map(([a, b]) => [clamp(Math.min(a, b), 0, D), clamp(Math.max(a, b), 0, D)])
      .filter(([a, b]) => b - a >= g).sort((p, q) => p[0] - q[0]);
    const out = [];
    for (const [a, b] of xs) {
      const last = out[out.length - 1];
      if (last && a <= last[1] + g / 2) last[1] = Math.max(last[1], b);
      else out.push([a, b]);
    }
    return out;
  }
  const segAt = (t) => state.segs.findIndex(([a, b]) => t >= a && t < b);
  // Bir aralığı tutulan parçalardan çıkarır
  function subtractRange(lo, hi) {
    const out = [];
    for (const [a, b] of state.segs) {
      if (hi <= a || lo >= b) { out.push([a, b]); continue; }
      if (lo > a) out.push([a, lo]);
      if (hi < b) out.push([hi, b]);
    }
    state.segs = normSegs(out);
  }
  function addRange(lo, hi) { state.segs = normSegs([...state.segs, [lo, hi]]); }

  // ---------- Bildirim ----------
  let toastTimer = null;
  let toastOnHide = null; // bildirim kapanınca bir kez çağrılır: (neden) => {}
  function hideToast(reason) {
    clearTimeout(toastTimer);
    el.toast.hidden = true;
    const fn = toastOnHide;
    toastOnHide = null;
    if (fn) fn(reason);
  }
  function toast(msg, kind = 'ok', actions = [], ms, onHide) {
    hideToast('replaced');
    el.toastText.textContent = msg;
    el.toast.classList.toggle('error', kind === 'error');
    el.toastActions.innerHTML = '';
    for (const a of actions) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'btn ghost small'; b.textContent = a.label;
      b.addEventListener('click', () => { a.fn(); });
      if (a.primary) b.classList.add('toast-primary');
      el.toastActions.appendChild(b);
    }
    el.toast.hidden = false;
    toastOnHide = onHide || null;
    toastTimer = setTimeout(() => hideToast('timeout'), ms || (kind === 'error' ? 12000 : actions.length ? 10000 : 4000));
  }
  el.toastClose.addEventListener('click', () => hideToast('closed'));

  // ---------- Dosya açma ----------
  async function openDialog() {
    if (state.exporting || asking) return;
    const p = await api.openDialog();
    if (p) requestOpen(p);
  }

  // ---------- Kaydedilmemiş değişiklikler ----------
  // Başka dosya açılırken ya da pencere kapanırken sorar. Sonuç: devam edilsin mi?
  let asking = null; // açık sorunun çözücüsü
  function askSave() {
    return new Promise((resolve) => {
      const name = (state.file || '').split(/[\\/]/).pop();
      $('askText').textContent = `"${name}" üzerindeki değişiklikler kaydedilmedi. Kaydet, aynı klasöre yeni bir dosya olarak kaydeder; orijinal değişmez.`;
      const before = document.activeElement;
      $('askModal').hidden = false;
      setBackgroundInert(true);
      $('askSave').focus();
      asking = (choice) => {
        asking = null;
        $('askModal').hidden = true;
        setBackgroundInert(false);
        if (choice === 'cancel' && before && document.contains(before)) before.focus({ preventScroll: true });
        resolve(choice);
      };
    });
  }
  $('askSave').addEventListener('click', () => asking && asking('save'));
  $('askDiscard').addEventListener('click', () => asking && asking('discard'));
  $('askCancel').addEventListener('click', () => asking && asking('cancel'));
  $('askModal').addEventListener('pointerdown', (e) => { if (e.target === e.currentTarget && asking) asking('cancel'); });

  async function confirmLeave() {
    if (asking) return false;
    if (state.exporting) { toast('Kaydetme sürüyor. Bitmesini bekle ya da iptal et'); return false; }
    if (!hasUnsaved()) return true;
    v.pause();
    const choice = await askSave();
    if (choice === 'cancel') return false;
    if (choice === 'save') return !!(await doExport('version'));
    return true;
  }
  async function requestOpen(file) {
    if (file && (await confirmLeave())) openFile(file);
  }

  async function openFile(file) {
    if (!file || state.exporting) return;
    const token = ++state.loadToken;
    const r = await api.probe(file);
    if (token !== state.loadToken) return;
    if (!r.ok) { toast(r.error, 'error'); return; }

    api.cancelProxy();
    state.proxyFor = null;
    hideStageMsg();
    cancelPreview();
    state.file = r.file;
    state.info = r.info;
    state.fileSize = r.size || 0;
    state.duration = r.info.duration;
    const m = r.file.match(/(\.[^./\\]+)$/);
    state.srcExt = m ? m[1].toLowerCase() : '.mp4';
    state.inT = 0;
    state.outT = state.duration;
    state.segs = [[0, state.duration]];
    state.now = 0;
    clearAnnos();

    el.app.dataset.state = 'loaded';
    document.querySelectorAll('.fb-center').forEach((n) => { n.inert = false; });
    [el.btnPlay, el.inTime, el.outTime, el.btnFrame, el.btnPreview, el.optResize, $('btnMute'), ...TRANSPORT()]
      .forEach((n) => { n.disabled = false; });
    el.tTotal.textContent = fmtTime(r.info.duration);
    $('fHdr').hidden = !r.info.hdr;
    document.title = `${r.name} – Kesit`;

    const hasAudio = r.info.hasAudio;
    el.optMute.disabled = !hasAudio;
    el.optMuteWrap.classList.toggle('disabled', !hasAudio);
    el.muteHint.textContent = 'Bu videoda ses yok';
    el.muteHint.hidden = hasAudio;
    if (!hasAudio) { el.optMute.checked = false; state.mute = false; }

    loadVideo(r.url, false);
    // Seçili kadraj oranı dosyalar arasında korunur.
    setRatio(state.ratioKey, false);
    renderAll();
    resetHistory();
    requestThumbs(token);
  }

  function loadVideo(url, isProxy) {
    clearTimeout(state.loadTimer);
    v.pause();
    state.proxy = isProxy;
    el.fProxy.hidden = !isProxy;
    v.src = url;
    v.load();
    if (!isProxy) {
      const token = state.loadToken;
      state.loadTimer = setTimeout(() => {
        if (token === state.loadToken && !state.proxy && v.readyState < 2) startProxy();
      }, 8000);
    }
  }

  async function startProxy() {
    const token = state.loadToken;
    if (state.proxy || state.proxyFor === token || !state.file) return;
    state.proxyFor = token;
    clearTimeout(state.loadTimer);
    v.removeAttribute('src');
    v.load();
    showStageMsg(0);
    const r = await api.proxy({ file: state.file, info: state.info });
    if (state.proxyFor === token) state.proxyFor = null;
    if (token !== state.loadToken) return;
    hideStageMsg();
    if (r.ok) loadVideo(r.url, true);
    else if (!r.canceled) toast(`Önizleme oluşturulamadı. ${r.error}`, 'error');
  }
  function showStageMsg(p) {
    el.stageMsg.hidden = false;
    el.stageMsgBar.style.transform = `scaleX(${clamp(p, 0, 1)})`;
  }
  function hideStageMsg() { el.stageMsg.hidden = true; }
  api.onProxyProgress((p) => { if (!el.stageMsg.hidden) showStageMsg(p); });

  v.addEventListener('loadedmetadata', () => {
    if (!state.proxy && state.info && state.info.hasVideo && v.videoWidth === 0) { startProxy(); return; }
    // Kadraj kutusu tarayıcının gördüğü en-boy oranına göre yeniden hesaplanır.
    if (state.crop) state.crop = clampCrop(state.crop);
    v.currentTime = state.now;
    layoutFrame();
  });
  v.addEventListener('loadeddata', () => { clearTimeout(state.loadTimer); });
  v.addEventListener('error', () => {
    if (!v.getAttribute('src')) return;
    if (!state.proxy) startProxy();
    else toast('Bu video önizlenemiyor, kaydetmeyi yine de deneyebilirsin', 'error');
  });

  async function requestThumbs(token) {
    el.strip.innerHTML = '';
    const info = state.info;
    const trackW = el.track.clientWidth || 800;
    const thumbW = el.track.clientHeight * (info.width / info.height);
    const count = clamp(Math.ceil(trackW / Math.max(24, thumbW)), 4, 40);
    const imgs = await api.thumbs({ file: state.file, duration: state.duration, count, height: 120 });
    if (token !== state.loadToken) return;
    const frag = document.createDocumentFragment();
    for (const src of imgs) {
      if (src) {
        const img = document.createElement('img');
        img.src = src; img.alt = ''; img.draggable = false;
        frag.appendChild(img);
      } else {
        const ph = document.createElement('div');
        ph.className = 'ph';
        frag.appendChild(ph);
      }
    }
    el.strip.appendChild(frag);
  }

  // ---------- Oynatma ----------
  function updatePlayBtn() {
    const playing = !v.paused && !v.ended;
    el.btnPlay.classList.toggle('playing', playing);
    el.btnPlay.setAttribute('aria-label', playing ? 'Durdur' : 'Oynat');
  }
  // Oynat düğmesi kesilmiş hâli oynatır: yalnızca tutulan parçalar, aradaki boşluklar atlanır.
  function playResult(from) {
    if (!state.info || !state.segs.length) return;
    const sg = state.segs, end = 0.03;
    let start = from;
    const inSeg = sg.find(([a, b]) => start >= a && start < b - end);
    if (!inSeg) {
      const next = sg.find(([a]) => a > start);
      start = next ? next[0] : sg[0][0];
    }
    seekTo(start);
    const pv = { segs: sg.map((x) => x.slice()) };
    state.preview = pv;
    v.play().then(() => { state.preview = pv; }).catch(() => {});
  }
  function togglePlay() {
    if (!state.info) return;
    if (v.paused || v.ended) playResult(state.now);
    else v.pause();
  }
  // Oynat'ın yanındaki düğmeler: başa / sona (kesilmiş sonucun başı ve sonu), 5 sn geri / ileri
  const TRANSPORT = () => ['btnToStart', 'btnBack', 'btnFwd', 'btnToEnd'].map($);
  const resultStart = () => (state.segs.length ? state.segs[0][0] : 0);
  const resultEnd = () => (state.segs.length ? state.segs[state.segs.length - 1][1] : 0);
  const blurClick = (id, fn) => $(id).addEventListener('click', (e) => { if (e.detail > 0) e.currentTarget.blur(); if (state.info) fn(); });
  blurClick('btnToStart', () => seekTo(resultStart()));
  blurClick('btnToEnd', () => { v.pause(); seekTo(resultEnd()); });
  blurClick('btnBack', () => seekTo(snap(state.now - 5)));
  blurClick('btnFwd', () => seekTo(snap(state.now + 5)));

  // Önizleme ses düzeyi: yalnızca editörde dinlerken; kaydedilen dosyayı etkilemez.
  const volume = $('volume');
  try { const sv = localStorage.getItem('kesit.volume'); if (sv != null) volume.value = sv; } catch (_) { /* depolama yok */ }
  const applyVolume = () => {
    v.volume = volume.value / 100;
    volume.style.setProperty('--fill', `${volume.value}%`);
    const wrap = volume.closest('.volume');
    wrap.classList.toggle('silent', +volume.value === 0);
    wrap.classList.toggle('low', +volume.value > 0 && +volume.value < 50);
    $('btnVol').setAttribute('aria-label', +volume.value === 0 ? 'Önizleme sesini aç' : 'Önizleme sesini kapat');
  };
  applyVolume();
  volume.addEventListener('input', applyVolume);
  volume.addEventListener('change', () => { try { localStorage.setItem('kesit.volume', volume.value); } catch (_) { /* depolama yok */ } volume.blur(); });
  volume.addEventListener('keydown', (e) => e.stopPropagation());
  // Hoparlör simgesi: önizleme sesini kapatır / eski düzeye döndürür
  let lastVolume = +volume.value || 100;
  $('btnVol').addEventListener('click', (e) => {
    if (e.detail > 0) e.currentTarget.blur();
    if (+volume.value > 0) { lastVolume = +volume.value; volume.value = 0; } else volume.value = lastVolume || 100;
    applyVolume();
    try { localStorage.setItem('kesit.volume', volume.value); } catch (_) { /* depolama yok */ }
  });
  volume.addEventListener('input', () => { if (+volume.value > 0) lastVolume = +volume.value; });

  // Videodaki konumu, kesilmiş sonuçtaki konuma çevirir (saatte gösterilir).
  function resultTime(t) {
    return state.segs.reduce((s, [a, b]) => s + clamp(t - a, 0, b - a), 0);
  }
  function tick() {
    state.raf = null;
    if (v.paused) return;
    const t = v.currentTime;
    const pv = state.preview;
    if (pv) {
      const i = pv.segs.findIndex(([, b]) => t < b - 0.03);
      if (i < 0) {
        const stop = pv.segs[pv.segs.length - 1][1];
        state.preview = null;
        v.pause();
        seekTo(stop);
      } else if (t < pv.segs[i][0] - 0.03) {
        v.currentTime = pv.segs[i][0];
      }
    }
    if (!state.drag) state.now = v.currentTime;
    renderPlayhead();
    state.raf = requestAnimationFrame(tick);
  }
  v.addEventListener('play', () => { updatePlayBtn(); if (!state.raf) state.raf = requestAnimationFrame(tick); });
  v.addEventListener('pause', () => { updatePlayBtn(); state.preview = null; });
  v.addEventListener('ended', updatePlayBtn);
  v.addEventListener('seeked', () => {
    if (state.pendingSeek != null) {
      const t = state.pendingSeek;
      state.pendingSeek = null;
      v.currentTime = t;
      return;
    }
    if (!state.drag && v.paused) { state.now = v.currentTime; renderPlayhead(); }
  });

  function seekTo(t) {
    t = clamp(t, 0, state.duration);
    state.now = t;
    if (v.readyState >= 1) {
      if (v.seeking) state.pendingSeek = t;
      else v.currentTime = t;
    }
    renderPlayhead();
  }
  function cancelPreview() { state.preview = null; }

  function previewResult() { if (state.info) playResult(resultStart()); }

  // ---------- Başlangıç / bitiş ----------
  // I: oynatma noktasındaki parçanın başını buraya alır (boşluktaysa sonraki parçayı buraya kadar uzatır).
  function setIn(t = state.now) {
    t = snap(t);
    const sg = state.segs.map((x) => x.slice());
    const i = sg.findIndex(([a, b]) => t >= a && t < b);
    if (i >= 0) sg[i][0] = Math.min(t, sg[i][1] - minGap());
    else {
      const j = sg.findIndex(([a]) => a > t);
      if (j >= 0) sg[j][0] = t; else sg.push([t, state.duration]);
    }
    state.segs = normSegs(sg);
    renderAll();
  }
  // O: oynatma noktasındaki parçanın sonunu buraya alır (boşluktaysa önceki parçayı buraya kadar uzatır).
  function setOut(t = state.now) {
    t = snap(t);
    const sg = state.segs.map((x) => x.slice());
    const i = sg.findIndex(([a, b]) => t > a && t <= b);
    if (i >= 0) sg[i][1] = Math.max(t, sg[i][0] + minGap());
    else {
      let j = -1;
      sg.forEach(([, b], k) => { if (b < t) j = k; });
      if (j >= 0) sg[j][1] = t; else sg.unshift([0, t]);
    }
    state.segs = normSegs(sg);
    renderAll();
  }
  function bindTimeInput(input, which) {
    const apply = () => {
      const t = parseTime(input.value);
      if (!isFinite(t) || t < 0 || t > state.duration + 0.01) {
        input.classList.remove('invalid'); void input.offsetWidth; input.classList.add('invalid');
        renderMarks();
        return;
      }
      input.classList.remove('invalid');
      if (which === 'in') setIn(t); else setOut(t);
      seekTo(t);
    };
    input.addEventListener('change', apply);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); apply(); input.blur(); }
      if (e.key === 'Escape') { renderMarks(); input.blur(); }
    });
    input.addEventListener('focus', () => input.select());
  }
  bindTimeInput(el.inTime, 'in');
  bindTimeInput(el.outTime, 'out');

  // ---------- Zaman çizelgesi ----------
  const pct = (t) => `${(state.duration ? (t / state.duration) * 100 : 0).toFixed(4)}%`;

  function setSliderAria(node, value, max) {
    node.setAttribute('aria-valuemax', max.toFixed(2));
    node.setAttribute('aria-valuenow', value.toFixed(2));
    node.setAttribute('aria-valuetext', fmtTime(value));
  }
  function renderPlayhead() {
    el.playhead.style.left = pct(state.now);
    el.tNow.textContent = fmtTime(resultTime(state.now));
    const pill = $('phTime');
    pill.textContent = fmtTime(state.now);
    // Başta ve sonda balon şeridin dışına taşmasın: yarı genişliği kadar içeri kaydır
    const tw = el.track.clientWidth, x = tw * (state.duration ? state.now / state.duration : 0), half = pill.offsetWidth / 2;
    const shift = tw ? Math.max(half - x, 0) - Math.max(x + half - tw, 0) : 0;
    pill.style.transform = `translateX(calc(-50% + ${shift}px))`;
    setSliderAria(el.playhead, state.now, state.duration);
  }
  // Film şeridi: tutulan parçalar açık, atılan aralıklar soluk; her parçanın iki ucunda tutamaç
  function renderMarks() {
    const frag = document.createDocumentFragment();
    const D = state.duration;
    let prev = 0;
    const gap = (a, b) => {
      if (b - a <= 0) return;
      const g = document.createElement('div');
      g.className = 'gap';
      g.style.left = pct(a); g.style.width = pct(b - a);
      frag.appendChild(g);
    };
    state.segs.forEach(([a, b], i) => {
      gap(prev, a);
      prev = b;
      for (const side of ['in', 'out']) {
        const h = document.createElement('div');
        h.className = `handle ${side}`;
        h.dataset.i = i; h.dataset.side = side;
        h.style.left = pct(side === 'in' ? a : b);
        h.tabIndex = 0;
        h.setAttribute('role', 'slider');
        h.setAttribute('aria-label', `${i + 1}. parça ${side === 'in' ? 'başı' : 'sonu'}`);
        setSliderAria(h, side === 'in' ? a : b, D);
        h.title = side === 'in' ? 'Parçanın başı (sürükle)' : 'Parçanın sonu (sürükle)';
        h.appendChild(document.createElement('i'));
        frag.appendChild(h);
      }
    });
    gap(prev, D);
    $('segs').replaceChildren(frag);
  }
  function renderRuler() {
    const D = state.duration;
    const w = el.track.clientWidth;
    if (!D || !w) { el.ruler.replaceChildren($('rulerHover')); return; }
    const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
    const step = steps.find((s) => (s / D) * w >= 72) || 3600;
    const frag = document.createDocumentFragment();
    for (let t = 0; t <= D - step * 0.4; t += step) {
      const s = document.createElement('span');
      s.style.left = `${((t / D) * 100).toFixed(3)}%`;
      s.textContent = fmtShort(t, step);
      frag.appendChild(s);
    }
    el.ruler.replaceChildren(frag, $('rulerHover'));
  }
  function renderSummary() {
    if (!state.info) return;
    const q = effectiveQuality();
    const dur = outputDuration();
    el.sumDur.textContent = (q === 'fast' ? '≈ ' : '') + fmtTime(dur);
    el.tTotal.textContent = el.sumDur.textContent;
    const vf = G.videoFilter({ info: state.info, crop: state.crop, resize: state.resize });
    el.sumSize.textContent = `${vf.outW}×${vf.outH}`;
    const edits = hasEdits();
    el.btnExport.disabled = dur < 0.05 || !edits;
    $('btnExportLabel').textContent = edits ? 'Kaydet' : 'Değişiklik yok';
    el.btnSaveAs.disabled = dur < 0.05;
    $('btnSaveMenu').disabled = dur < 0.05;
    $('btnSaveVersion').disabled = $('btnOverwrite').disabled = dur < 0.05 || !edits;
    const est = estimateSize();
    const tooBig = est > CLIP_MAX;
    $('sumBytes').textContent = est ? `≈ ${fmtBytes(est)}` : '';
    $('btnCopy').disabled = dur < 0.05 || tooBig;
    $('btnCopy').title = tooBig
      ? `Panoya kopyalamak için çok büyük (≈ ${fmtBytes(est)}). Kısalt ya da küçült`
      : `Panoya kopyala, ≈ ${fmtBytes(est)} (Ctrl Shift C)`;
    // Açık seçenekler kaydetmeden önce görünür kalsın (menü kapalıyken bile)
    const flags = [];
    if (q === 'fast') flags.push('Hızlı');
    if (state.mute && state.info.hasAudio) flags.push('Sessiz');
    if (state.resize && vf.outW === 1080) flags.push('1080 px');
    el.sumFlags.textContent = flags.map((f, i) => (i ? f.toLocaleLowerCase('tr') : f)).join(', ');
    scheduleCommit(); // her düzenleme sonunda geçmişe yazılır (sürüklerken değil)
  }
  function renderOptions() {
    document.querySelectorAll('.ratio').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.ratio === state.ratioKey)));
    const cropped = !!state.crop;
    $('ratioLabel').textContent = cropped ? ({ free: 'Kırpıldı' }[state.ratioKey] || state.ratioKey) : 'Kırp';
    $('btnCrop').classList.toggle('active', state.cropEdit);
    $('btnCrop').classList.toggle('cropped', cropped && !state.cropEdit);
    $('btnRatio').classList.toggle('active', state.cropEdit);
    $('btnRatio').hidden = !state.cropEdit; // oran oku yalnız kırparken görünür
    if (!state.cropEdit) closeRatioMenu(false);
    $('btnCrop').setAttribute('aria-pressed', String(state.cropEdit));
    $('btnCrop').title = state.cropEdit ? 'Kırpmayı bitir' : 'Kırp: kırpma çerçevesini düzenle';
    $('btnCut').classList.toggle('active', state.cutEdit);
    $('btnCut').setAttribute('aria-pressed', String(state.cutEdit));
    $('btnCut').title = state.cutEdit ? 'Kesmeyi bitir' : 'Kes: film şeridinde sürükleyerek aralık kes ya da geri ekle';
    const muted = state.mute && state.info && state.info.hasAudio;
    $('btnMute').classList.toggle('muted', !!muted);
    $('btnMute').setAttribute('aria-pressed', String(!!muted));
    $('btnMute').setAttribute('aria-label', muted ? 'Ses kapalı' : 'Ses açık');
    $('btnMute').title = !state.info || state.info.hasAudio
      ? (muted ? 'Ses kaldırılacak: tıkla, ses kalsın' : 'Ses açık: tıkla, kaydederken ses kaldırılsın')
      : 'Bu videoda ses yok';
    const forced = !!(state.crop || state.resize || state.annos.length);
    el.optFast.disabled = forced;
    el.optFast.checked = effectiveQuality() === 'fast';
    el.optFastWrap.classList.toggle('disabled', forced);
    el.fastHint.textContent = forced
      ? 'Kadraj, küçültme ya da çizim varken kullanılamaz'
      : 'Yeniden kodlamaz; kesim birkaç kare kayabilir';
  }
  function renderAll() {
    renderRuler();
    renderMarks();
    renderPlayhead();
    renderSummary();
    renderOptions();
    layoutFrame();
  }

  function xToTime(clientX) {
    const r = el.track.getBoundingClientRect();
    return clamp((clientX - r.left) / r.width, 0, 1) * state.duration;
  }
  // Film şeridinde sürükleme:
  //  - tutulan bir parçanın içinden sürüklemek o aralığı keser,
  //  - atılmış (soluk) bir aralıktan sürüklemek yeni bir parça açar,
  //  - tutamaçlar parçanın ucunu taşır, sürüklemeden tıklamak oynatma noktasını oraya alır.
  // Üstteki saniye cetveli videoda gezmek içindir.
  const pending = $('pending');
  el.track.addEventListener('pointerdown', (e) => {
    if (!state.info || e.button !== 0) return;
    const h = e.target.closest('.handle');
    const t0 = xToTime(e.clientX);
    if (h && h.dataset.i != null) {
      state.drag = { kind: 'edge', i: +h.dataset.i, side: h.dataset.side }; // uç tutamaçları Kes kapalıyken de çalışır
    } else if (!state.cutEdit) {
      state.drag = { kind: 'seek' }; // Kes kapalıyken şeridin geri kalanı videoda gezer
    } else {
      state.drag = { kind: 'range', t0, x0: e.clientX, keep: segAt(t0) >= 0, moved: false };
    }
    state.dragWasPlaying = !v.paused;
    cancelPreview();
    v.pause();
    el.track.setPointerCapture(e.pointerId);
    el.track.parentElement.classList.add('scrubbing');
    if (state.drag.kind !== 'range') applyDrag(e.clientX);
  });
  el.ruler.addEventListener('pointerdown', (e) => {
    if (!state.info || e.button !== 0) return;
    state.drag = { kind: 'seek' };
    state.dragWasPlaying = !v.paused;
    cancelPreview();
    v.pause();
    el.ruler.setPointerCapture(e.pointerId);
    el.track.parentElement.classList.add('scrubbing');
    applyDrag(e.clientX);
  });
  const rulerHover = $('rulerHover');
  el.ruler.addEventListener('pointermove', (e) => {
    if (state.drag && state.drag.kind === 'seek') applyDrag(e.clientX);
    if (!state.info) return;
    const t = xToTime(e.clientX);
    // Sürüklerken ya da oynatma başının hemen yanındayken tek balon yeter: imleç etiketi gizlenir
    const near = Math.abs(e.clientX - el.playhead.getBoundingClientRect().left) < 44;
    rulerHover.hidden = !!state.drag || near;
    if (rulerHover.hidden) return;
    rulerHover.style.left = pct(t);
    rulerHover.firstChild.textContent = fmtTime(t);
  });
  el.ruler.addEventListener('pointerleave', () => { rulerHover.hidden = true; });
  el.track.addEventListener('pointermove', (e) => { if (state.drag) applyDrag(e.clientX); });
  const endDrag = (e) => {
    const d = state.drag;
    if (!d) return;
    state.drag = null;
    el.track.parentElement.classList.remove('scrubbing');
    if (!el.track.matches(':hover')) el.track.classList.remove('peek');
    pending.hidden = true;
    $('edgeTip').hidden = true;
    if (d.kind === 'range') {
      if (d.moved) {
        const t1 = xToTime(e.clientX);
        const lo = snap(Math.min(d.t0, t1)), hi = snap(Math.max(d.t0, t1));
        if (d.keep) subtractRange(lo, hi); else addRange(lo, hi);
        renderAll();
      } else {
        seekTo(d.t0);
      }
    } else if (d.kind === 'edge') {
      state.segs = normSegs(state.segs);
      renderAll();
    }
    if (d.kind !== 'seek' && (d.kind !== 'range' || d.moved)) scheduleCommit();
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (_) {}
    if ((d.kind === 'seek' || (d.kind === 'range' && !d.moved)) && state.dragWasPlaying) togglePlay();
    if (document.activeElement && document.activeElement.classList.contains('handle')) document.activeElement.blur();
  };
  el.track.addEventListener('pointerup', endDrag);
  el.track.addEventListener('pointercancel', endDrag);
  el.ruler.addEventListener('pointerup', endDrag);
  el.ruler.addEventListener('pointercancel', endDrag);

  // Parça uçları klavyeyle: oklar bir kare, Shift ya da Page tuşları bir saniye.
  $('segs').addEventListener('keydown', (e) => {
    const h = e.target.closest('.handle');
    if (!h || !state.info) return;
    const i = +h.dataset.i, side = h.dataset.side;
    const fr = 1 / fps(), big = e.shiftKey ? 1 : fr;
    const seg = state.segs[i];
    let t = side === 'in' ? seg[0] : seg[1];
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') t -= big;
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') t += big;
    else if (e.key === 'PageDown') t -= 1;
    else if (e.key === 'PageUp') t += 1;
    else return;
    e.preventDefault();
    e.stopPropagation();
    cancelPreview();
    v.pause();
    moveEdge(i, side, t);
    seekTo(side === 'in' ? state.segs[i][0] : state.segs[i][1]);
    renderMarks();
    renderSummary();
    const again = $('segs').querySelector(`.handle[data-i="${i}"][data-side="${side}"]`);
    if (again) again.focus();
  });
  // Bir parçanın ucunu taşır; komşu parçanın üstüne geçemez.
  function moveEdge(i, side, t) {
    const sg = state.segs, g = minGap();
    const [a, b] = sg[i];
    if (side === 'in') {
      const lo = i > 0 ? sg[i - 1][1] : 0;
      sg[i][0] = clamp(snap(t), lo, b - g);
    } else {
      const hi = i < sg.length - 1 ? sg[i + 1][0] : state.duration;
      sg[i][1] = clamp(snap(t), a + g, hi);
    }
  }

  function applyDrag(clientX) {
    const d = state.drag;
    const t = xToTime(clientX);
    if (d.kind === 'edge') {
      moveEdge(d.i, d.side, t);
      const et = d.side === 'in' ? state.segs[d.i][0] : state.segs[d.i][1];
      seekTo(et);
      const tip = $('edgeTip');
      tip.hidden = false;
      tip.className = `edge-tip ${d.side}`;
      tip.style.left = pct(et);
      tip.textContent = `${d.side === 'in' ? 'Baş' : 'Son'} ${fmtTime(et)}`;
    } else if (d.kind === 'range') {
      if (!d.moved && Math.abs(clientX - d.x0) < 4) return;
      d.moved = true;
      const lo = Math.min(d.t0, t), hi = Math.max(d.t0, t);
      pending.hidden = false;
      pending.className = `pending ${d.keep ? 'cut' : 'add'}`;
      pending.style.left = pct(lo);
      pending.style.width = pct(hi - lo);
      seekTo(t);
      return;
    } else {
      seekTo(t);
    }
    renderMarks();
    renderSummary();
  }

  // ---------- Kadraj ----------
  const FULL = { x: 0, y: 0, w: 1, h: 1, ratio: null };
  const MIN = 0.05; // en küçük kadraj, video boyutunun %5'i

  function defaultCrop(r) {
    if (!r) return { x: 0.1, y: 0.1, w: 0.8, h: 0.8, ratio: null };
    const { va } = videoDims();
    let w, h;
    if (va > r) { h = 1; w = r / va; } else { w = 1; h = va / r; }
    return { x: (1 - w) / 2, y: (1 - h) / 2, w, h, ratio: r };
  }
  function clampCrop(c) {
    if (!c) return c;
    let w = Math.min(1, c.w), h = Math.min(1, c.h);
    if (c.ratio) {
      const k = videoDims().va / c.ratio; // h = w * k
      h = w * k;
      if (h > 1) { h = 1; w = h / k; }
      if (w > 1) { w = 1; h = w * k; }
    }
    const cx = c.x + c.w / 2, cy = c.y + c.h / 2;
    return { ratio: c.ratio, w, h, x: clamp(cx - w / 2, 0, 1 - w), y: clamp(cy - h / 2, 0, 1 - h) };
  }
  let lastRatio = 'free';
  function setRatio(key, keepExisting) {
    const prevKey = state.ratioKey;
    if (key !== 'orig') lastRatio = key;
    state.ratioKey = key;
    const r = RATIOS[key];
    if (key === 'orig') state.crop = null;
    else if (key === 'free') {
      // Bir orandan Serbest'e geçince mevcut çerçeve korunur.
      state.crop = state.crop && prevKey !== 'orig' ? { ...state.crop, ratio: null } : defaultCrop(null);
    } else if (!(keepExisting && state.crop && state.crop.ratio === r)) state.crop = defaultCrop(r);
    else state.crop = clampCrop(state.crop);
    if (!state.info) return;
    renderAll();
  }
  function layoutFrame() {
    if (!state.info) { el.frameLayer.hidden = true; return; }
    const W = el.viewport.clientWidth, H = el.viewport.clientHeight;
    const { va } = videoDims();
    let w, h, left, top;
    // "Yalnız kırpılan alan": kırpma varken ve düzenlenmiyorken kırpılan kısım pencereyi doldurur
    const focus = !!(state.cropView && state.crop && !state.cropEdit);
    if (focus) {
      const c0 = state.crop;
      const s = Math.min(W / (c0.w * va), H / c0.h);
      w = va * s; h = s;
      left = (W - c0.w * w) / 2 - c0.x * w; top = (H - c0.h * h) / 2 - c0.y * h;
    } else {
      if (W / H > va) { h = H; w = h * va; } else { w = W; h = w / va; }
      left = (W - w) / 2; top = (H - h) / 2;
    }
    el.viewport.classList.toggle('crop-focus', focus);
    if (focus) {
      const c0 = state.crop, x0 = (W - c0.w * w) / 2, y0 = (H - c0.h * h) / 2;
      el.viewport.style.clipPath = `inset(${y0}px ${W - x0 - c0.w * w}px ${H - y0 - c0.h * h}px ${x0}px round 2px)`;
    } else el.viewport.style.clipPath = '';
    Object.assign(v.style, focus
      ? { left: `${left}px`, top: `${top}px`, width: `${w}px`, height: `${h}px` }
      : { left: '', top: '', width: '', height: '' });
    Object.assign(el.frameLayer.style, {
      left: `${left}px`, top: `${top}px`, width: `${w}px`, height: `${h}px`
    });
    el.frameLayer.hidden = false;
    positionAnno(left, top, w, h);
    const cv = $('btnCropView');
    cv.disabled = !state.crop;
    cv.setAttribute('aria-pressed', String(!!state.cropView));
    cv.classList.toggle('active', !!state.cropView);
    // Kırp düğmesi yalnızca düzenlemeyi açar: açıkken tutamaçlar ve ızgara görünür.
    // Kapalıyken kırpma (varsa) karartmayla gösterilir ama çerçeve tıklamaları videoya bırakır.
    const ghost = !state.crop;
    const c = state.crop || FULL;
    const edit = state.cropEdit;
    el.crop.classList.toggle('ghost', ghost);
    el.crop.classList.toggle('locked', !edit);
    const peek = !edit && !!state.cropPeek && !state.tool && !state.cropView;
    el.crop.classList.toggle('peek', peek);
    el.crop.hidden = false; // tutamaçlar CSS geçişiyle belirip kaybolur
    el.crop.tabIndex = edit && !ghost ? 0 : -1;
    $('btnCropReset').hidden = ghost;
    const P = (n) => `${n * 100}%`;
    Object.assign(el.crop.style, { left: P(c.x), top: P(c.y), width: P(c.w), height: P(c.h) });
    Object.assign($('dimT').style, { left: 0, top: 0, width: '100%', height: P(c.y) });
    Object.assign($('dimB').style, { left: 0, top: P(c.y + c.h), width: '100%', bottom: 0 });
    Object.assign($('dimL').style, { left: 0, top: P(c.y), width: P(c.x), height: P(c.h) });
    Object.assign($('dimR').style, { left: P(c.x + c.w), top: P(c.y), right: 0, height: P(c.h) });
    if (ghost) return;
    const vf = G.videoFilter({ info: state.info, crop: c, resize: false });
    const b = document.createElement('b'); b.textContent = state.ratioKey === 'free' ? 'Serbest' : state.ratioKey;
    const s = document.createElement('span'); s.textContent = `${vf.outW}×${vf.outH}`;
    el.cropLabel.replaceChildren(b, s);
    el.crop.setAttribute('aria-label', `Kadraj ${b.textContent}, ${vf.outW}×${vf.outH}`);
  }

  el.crop.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !state.info) return;
    const handle = e.target.dataset.corner || e.target.dataset.edge || null;
    if (!state.crop && !handle) return; // kadraj yokken yalnızca tutamaçlar çalışır
    // Üstüne gelince görünen tutamaçlardan biri tutulunca kırpma açılır
    if (handle && !state.cropEdit) setCropEdit(true);
    // Çizim aracı seçiliyken ya da bir çizimin üstündeyken kadrajın içi çizime bırakılır
    if (!handle && (state.tool || hitTest(toVideo(e)))) return;
    e.stopPropagation();
    const r = el.frameLayer.getBoundingClientRect();
    state.cropDrag = {
      handle,
      sx: e.clientX, sy: e.clientY, o: { ...(state.crop || FULL) },
      left: r.left, top: r.top, rw: r.width, rh: r.height, moved: false
    };
    el.crop.setPointerCapture(e.pointerId);
  });

  // Serbest boyutlandırma: tutulan kenarlar imleci izler, diğerleri sabit kalır.
  function resizeFree(o, handle, px, py) {
    let x1 = o.x, y1 = o.y, x2 = o.x + o.w, y2 = o.y + o.h;
    if (handle.includes('w')) x1 = clamp(px, 0, x2 - MIN);
    if (handle.includes('e')) x2 = clamp(px, x1 + MIN, 1);
    if (handle.includes('n')) y1 = clamp(py, 0, y2 - MIN);
    if (handle.includes('s')) y2 = clamp(py, y1 + MIN, 1);
    return { ratio: null, x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }
  // Oranlı boyutlandırma: karşı kenar/köşe sabit, oran korunur.
  function resizeLocked(o, handle, px, py) {
    const k = videoDims().va / o.ratio; // h = w * k
    const west = handle.includes('w'), east = handle.includes('e');
    const north = handle.includes('n'), south = handle.includes('s');
    if ((west || east) && (north || south)) {
      const ax = west ? o.x + o.w : o.x, ay = north ? o.y + o.h : o.y;
      let w = Math.max(0, west ? ax - px : px - ax);
      let h = Math.max(0, north ? ay - py : py - ay);
      if (h > w * k) w = h / k; else h = w * k;
      const maxW = west ? ax : 1 - ax, maxH = north ? ay : 1 - ay;
      if (w > maxW) { w = maxW; h = w * k; }
      if (h > maxH) { h = maxH; w = h / k; }
      const minW = Math.min(0.1, maxW);
      if (w < minW && minW * k <= maxH) { w = minW; h = minW * k; }
      return { ratio: o.ratio, w, h, x: west ? ax - w : ax, y: north ? ay - h : ay };
    }
    if (west || east) {
      const ax = west ? o.x + o.w : o.x, cy = o.y + o.h / 2;
      let w = Math.max(0, west ? ax - px : px - ax);
      w = clamp(w, Math.min(0.1, 1 / k), Math.min(west ? ax : 1 - ax, 1 / k));
      const h = w * k;
      return { ratio: o.ratio, w, h, x: west ? ax - w : ax, y: clamp(cy - h / 2, 0, 1 - h) };
    }
    const ay = north ? o.y + o.h : o.y, cx = o.x + o.w / 2;
    let h = Math.max(0, north ? ay - py : py - ay);
    h = clamp(h, Math.min(0.1, k), Math.min(north ? ay : 1 - ay, k));
    const w = h / k;
    return { ratio: o.ratio, w, h, x: clamp(cx - w / 2, 0, 1 - w), y: north ? ay - h : ay };
  }

  el.crop.addEventListener('pointermove', (e) => {
    const d = state.cropDrag;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 2) return;
    if (!d.moved && !state.crop) {
      // Kadraj yokken kenardan sürüklemek serbest kırpmayı başlatır.
      state.ratioKey = 'free';
      state.crop = { ...FULL };
      renderOptions();
      renderSummary();
    }
    d.moved = true;
    const o = d.o;
    const px = (e.clientX - d.left) / d.rw, py = (e.clientY - d.top) / d.rh;
    if (!d.handle) {
      const dx = (e.clientX - d.sx) / d.rw, dy = (e.clientY - d.sy) / d.rh;
      state.crop = { ...o, x: clamp(o.x + dx, 0, 1 - o.w), y: clamp(o.y + dy, 0, 1 - o.h) };
    } else {
      state.crop = o.ratio ? resizeLocked(o, d.handle, px, py) : resizeFree(o, d.handle, px, py);
    }
    layoutFrame();
    renderSummary();
  });
  const endCrop = (e) => {
    if (!state.cropDrag) return;
    state.cropMoved = state.cropDrag.moved;
    state.cropDrag = null;
    scheduleCommit();
    if (document.activeElement === el.crop) el.crop.blur();
    try { el.crop.releasePointerCapture(e.pointerId); } catch (_) {}
  };
  el.crop.addEventListener('pointerup', endCrop);
  el.crop.addEventListener('pointercancel', endCrop);
  // Kadrajın içine sürüklemeden tıklamak oynat/durdur olarak videoya geçer; sürükleme sonrası tıklama yutulur.
  el.crop.addEventListener('click', (e) => {
    if (state.cropMoved || e.target !== el.crop) e.stopPropagation();
    state.cropMoved = false;
  });
  function resetCrop() {
    if (!state.crop) return;
    state.crop = defaultCrop(state.crop.ratio);
    if (!state.crop.ratio) state.crop = { ...FULL };
    renderAll();
  }
  el.crop.addEventListener('dblclick', (e) => {
    if (!state.crop) return;
    e.stopPropagation();
    resetCrop();
  });
  $('btnCropReset').addEventListener('click', (e) => { if (e.detail > 0) e.currentTarget.blur(); resetCrop(); closeRatioMenu(e.detail === 0); });

  // Klavyeyle kadraj: oklar taşır (Shift 10 px), Alt + oklar boyutlandırır.
  el.crop.addEventListener('keydown', (e) => {
    if (!state.crop || !state.info) return;
    const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (!dir) return;
    e.preventDefault();
    e.stopPropagation();
    const W = state.info.width, H = state.info.height;
    const step = e.shiftKey ? 10 : 1;
    const c = state.crop;
    if (!e.altKey) {
      state.crop = { ...c, x: clamp(c.x + (dir[0] * step) / W, 0, 1 - c.w), y: clamp(c.y + (dir[1] * step) / H, 0, 1 - c.h) };
    } else if (c.ratio) {
      // Oranlı: sağ/aşağı büyütür, sol/yukarı küçültür; merkez korunur.
      const k = videoDims().va / c.ratio;
      const grow = dir[0] + dir[1] > 0 ? 1 : -1;
      const maxW = Math.min(1, 1 / k);
      const w = clamp(c.w + (grow * step * 2) / W, Math.min(0.1, maxW), maxW);
      const h = w * k;
      const cx = c.x + c.w / 2, cy = c.y + c.h / 2;
      state.crop = { ratio: c.ratio, w, h, x: clamp(cx - w / 2, 0, 1 - w), y: clamp(cy - h / 2, 0, 1 - h) };
    } else {
      // Serbest: sol/sağ genişliği, yukarı/aşağı yüksekliği değiştirir (sol üst köşe sabit).
      const w = clamp(c.w + (dir[0] * step) / W, MIN, 1 - c.x);
      const h = clamp(c.h + (dir[1] * step) / H, MIN, 1 - c.y);
      state.crop = { ...c, w, h };
    }
    layoutFrame();
    renderSummary();
  });
  el.viewport.addEventListener('click', () => {
    if (state.annoClickGuard) { state.annoClickGuard = false; return; } // çizim/taşıma sonrası oynatma
    if (state.info) togglePlay();
  });

  // ---------- Panel ----------
  document.querySelectorAll('.ratio').forEach((b) => b.addEventListener('click', () => { setRatio(b.dataset.ratio, false); setCropEdit(b.dataset.ratio !== 'orig'); closeRatioMenu(b.matches(':focus-visible')); }));

  // Kırp düğmesi kırpmayı açıp kapatır; yanındaki ok oranları açar.
  // Düğmelere ek olarak, fare üstüne gelince tutamaçlar hemen görünür:
  //  - film şeridinde parçaların uç tutamaçları (sürükleyince ucu taşır; tıklamak yine oynatma noktasını alır,
  //    aralık kesme / ekleme yalnızca Kes açıkken çalışır),
  //  - videonun görüntüsünün üstünde kırpma tutamaçları (tutup sürükleyince kırpma açılır).
  el.track.addEventListener('pointerenter', () => el.track.classList.add('peek'));
  el.track.addEventListener('pointerleave', () => { if (!state.drag) el.track.classList.remove('peek'); });
  const stageEl = $('stage');
  const setPeek = (on) => { if (state.cropPeek !== on) { state.cropPeek = on; layoutFrame(); } };
  const PEEK_PAD = 10; // tutamaçlar görüntünün kenarından biraz taşar
  stageEl.addEventListener('pointermove', (e) => {
    if (state.cropDrag) return;
    const r = el.frameLayer.getBoundingClientRect();
    setPeek(!el.frameLayer.hidden && e.clientX >= r.left - PEEK_PAD && e.clientX <= r.right + PEEK_PAD && e.clientY >= r.top - PEEK_PAD && e.clientY <= r.bottom + PEEK_PAD);
  });
  stageEl.addEventListener('pointerleave', () => { if (!state.cropDrag) setPeek(false); });
  function toggleCropView() {
    state.cropView = !state.cropView;
    try { localStorage.setItem('kesit.cropView', state.cropView ? '1' : '0'); } catch {}
    layoutFrame();
  }
  try { state.cropView = localStorage.getItem('kesit.cropView') === '1'; } catch {}
  $('btnCropView').addEventListener('click', (e) => { if (e.detail > 0) e.currentTarget.blur(); toggleCropView(); });
  function setCropEdit(on) {
    on = !!on && !!state.info;
    if (state.cropEdit === on) return;
    state.cropEdit = on;
    if (on && state.tool) setTool(state.tool); // kırparken çizim aracı kapanır
    if (on) setCutEdit(false);
    renderOptions();
    layoutFrame();
  }
  function setCutEdit(on) {
    on = !!on && !!state.info;
    if (state.cutEdit === on) return;
    state.cutEdit = on;
    if (on && state.tool) setTool(state.tool);
    if (on) setCropEdit(false);
    el.track.classList.toggle('cutting', on);
    renderOptions();
  }
  $('btnCut').addEventListener('click', (e) => {
    if (e.detail > 0) e.currentTarget.blur();
    setCutEdit(!state.cutEdit);
  });
  // Kesme açıkken film şeridi dışına tıklamak onu kapatır (cetvel ve oynatma düğmeleri hariç).
  document.addEventListener('pointerdown', (e) => {
    if (!state.cutEdit) return;
    if (e.target.closest('.timeline, #btnCut, .appmenu-wrap, .modal, .toast')) return;
    if (e.target.closest('.viewport')) state.annoClickGuard = true;
    setCutEdit(false);
  }, true);
  $('btnCrop').addEventListener('click', (e) => {
    if (e.detail > 0) e.currentTarget.blur();
    setCropEdit(!state.cropEdit);
  });
  // Kırpma düzenlenirken başka bir yere tıklamak düzenlemeyi kapatır (kırpma ayarı korunur).
  document.addEventListener('pointerdown', (e) => {
    if (!state.cropEdit) return;
    if (e.target.closest('.crop, .ratio-wrap, .appmenu-wrap, .modal, .toast')) return;
    if (e.target.closest('.viewport')) state.annoClickGuard = true; // bu tıklama oynatmayı başlatmasın
    setCropEdit(false);
  }, true);
  // Ses düğmesi: kaydederken sesi kaldır / bırak
  $('btnMute').addEventListener('click', (e) => {
    if (e.detail > 0) e.currentTarget.blur();
    if (!state.info || !state.info.hasAudio) return;
    el.optMute.checked = !el.optMute.checked;
    el.optMute.dispatchEvent(new Event('change'));
  });
  // Kadraj seçici: üstte tek düğme, oranlar tıklayınca açılan menüde
  const ratioMenu = $('ratioMenu'), btnRatio = $('btnRatio');
  // Oran oku yalnız kırpma açıkken Kırp'ın yanında görünür; oranlar açılır menüde
  function openRatioMenu(focus) {
    ratioMenu.hidden = false;
    btnRatio.setAttribute('aria-expanded', 'true');
    if (focus) (ratioMenu.querySelector('.ratio[aria-checked="true"]') || ratioMenu.querySelector('.ratio')).focus();
  }
  function closeRatioMenu(returnFocus) {
    if (ratioMenu.hidden) return;
    ratioMenu.hidden = true;
    btnRatio.setAttribute('aria-expanded', 'false');
    if (returnFocus && !btnRatio.hidden) btnRatio.focus();
  }
  document.addEventListener('pointerdown', (e) => { if (!e.target.closest('.ratio-wrap')) closeRatioMenu(false); });
  ratioMenu.addEventListener('focusout', (e) => { if (e.relatedTarget && !e.relatedTarget.closest('.ratio-wrap')) closeRatioMenu(false); });
  btnRatio.addEventListener('click', (e) => {
    if (ratioMenu.hidden) openRatioMenu(e.detail === 0); else closeRatioMenu(e.detail === 0);
    if (e.detail > 0) btnRatio.blur();
  });
  ratioMenu.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeRatioMenu(true); return; }
    if (['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft'].includes(e.key)) {
      const items = [...ratioMenu.querySelectorAll('button:not([hidden])')];
      const i = items.indexOf(document.activeElement);
      items[(i + (e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length].focus();
      e.preventDefault();
    }
    if (e.key !== 'Tab') e.stopPropagation();
  });

  el.optFast.addEventListener('change', () => { state.quality = el.optFast.checked ? 'fast' : 'precise'; renderAll(); });
  el.optMute.addEventListener('change', () => { state.mute = el.optMute.checked; renderAll(); });
  el.optResize.addEventListener('change', () => { state.resize = el.optResize.checked; renderAll(); });


  // ---------- Çizimler: ok, daire, yapıştırılan yuvarlak görsel ----------
  // Koordinatlar videonun piksel uzayında tutulur (state.info.width × height); böylece kaydederken
  // aynı çizim fonksiyonu tam çözünürlükte saydam bir PNG üretir ve ffmpeg bunu kareye bindirir.
  const RED = '#ff3b30';
  const imgCache = new Map();
  const annoCanvas = $('annoCanvas'), annoHandles = $('annoHandles');
  let annoSeq = 0;
  state.annos = [];
  state.sel = null;
  state.tool = null;
  state.adrag = null;

  const vdim = () => ({ W: state.info.width, H: state.info.height });
  const strokeW = () => { const { W, H } = vdim(); return Math.max(4, Math.round(Math.min(W, H) * 0.008)); };
  function getImg(src) {
    let im = imgCache.get(src);
    if (!im) { im = new Image(); im.onload = () => drawAnnos(); im.src = src; imgCache.set(src, im); }
    return im;
  }

  function drawArrow(ctx, a, sw) {
    const dx = a.x2 - a.x1, dy = a.y2 - a.y1, len = Math.hypot(dx, dy);
    if (len < 1) return;
    const ux = dx / len, uy = dy / len;
    const head = Math.min(len * 0.6, sw * 4.5), hw = head * 0.72;
    const bx = a.x2 - ux * head, by = a.y2 - uy * head;
    ctx.strokeStyle = RED; ctx.fillStyle = RED; ctx.lineWidth = sw; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(a.x1, a.y1); ctx.lineTo(bx + ux, by + uy); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(a.x2, a.y2); ctx.lineTo(bx - uy * hw, by + ux * hw); ctx.lineTo(bx + uy * hw, by - ux * hw); ctx.closePath();
    ctx.fill(); ctx.lineWidth = Math.max(1, sw / 3); ctx.stroke();
  }
  function drawEllipse(ctx, a, sw) {
    const rx = Math.abs(a.x2 - a.x1) / 2, ry = Math.abs(a.y2 - a.y1) / 2;
    if (rx < 1 || ry < 1) return;
    ctx.strokeStyle = RED; ctx.lineWidth = sw;
    ctx.beginPath(); ctx.ellipse((a.x1 + a.x2) / 2, (a.y1 + a.y2) / 2, rx, ry, 0, 0, Math.PI * 2); ctx.stroke();
  }
  function drawImageCircle(ctx, a, sw) {
    const im = getImg(a.src);
    const bw = Math.max(sw, Math.round(a.r * 0.06));
    ctx.save();
    ctx.beginPath(); ctx.arc(a.cx, a.cy, a.r, 0, Math.PI * 2); ctx.clip();
    if (im.complete && im.naturalWidth) {
      const s = Math.max((2 * a.r) / im.naturalWidth, (2 * a.r) / im.naturalHeight);
      const w = im.naturalWidth * s, h = im.naturalHeight * s;
      ctx.drawImage(im, a.cx - w / 2, a.cy - h / 2, w, h);
    } else { ctx.fillStyle = '#1b1b1d'; ctx.fill(); }
    ctx.restore();
    ctx.strokeStyle = RED; ctx.lineWidth = bw;
    ctx.beginPath(); ctx.arc(a.cx, a.cy, a.r - bw / 2, 0, Math.PI * 2); ctx.stroke();
  }
  function drawScene(ctx, list) {
    const sw = strokeW();
    for (const a of list) {
      ctx.save();
      if (a.type === 'arrow') drawArrow(ctx, a, sw);
      else if (a.type === 'ellipse') drawEllipse(ctx, a, sw);
      else if (a.type === 'image') drawImageCircle(ctx, a, sw);
      ctx.restore();
    }
  }

  // Tuvali ve tutamaç katmanını videonun ekrandaki dikdörtgenine yerleştirir
  function positionAnno(left, top, w, h) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    for (const n of [annoCanvas, annoHandles]) Object.assign(n.style, { left: `${left}px`, top: `${top}px`, width: `${w}px`, height: `${h}px` });
    const cw = Math.max(1, Math.round(w * dpr)), ch = Math.max(1, Math.round(h * dpr));
    if (annoCanvas.width !== cw || annoCanvas.height !== ch) { annoCanvas.width = cw; annoCanvas.height = ch; }
    annoCanvas.hidden = false;
    annoHandles.hidden = false;
    drawAnnos();
  }
  function drawAnnos() {
    const ctx = annoCanvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, annoCanvas.width, annoCanvas.height);
    if (!state.info) return;
    const s = annoCanvas.width / state.info.width;
    ctx.setTransform(s, 0, 0, s, 0, 0);
    drawScene(ctx, state.annos);
    renderHandles();
  }

  function bbox(a) {
    if (a.type === 'image') return { x1: a.cx - a.r, y1: a.cy - a.r, x2: a.cx + a.r, y2: a.cy + a.r };
    return { x1: Math.min(a.x1, a.x2), y1: Math.min(a.y1, a.y2), x2: Math.max(a.x1, a.x2), y2: Math.max(a.y1, a.y2) };
  }
  function renderHandles() {
    annoHandles.replaceChildren();
    const a = state.annos.find((x) => x.id === state.sel);
    if (!a || !state.info) return;
    const { W } = vdim();
    const k = annoHandles.clientWidth / W; // video pikseli → ekran pikseli
    const put = (cls, x, y, h) => {
      const n = document.createElement(cls === 'adel' ? 'button' : 'div');
      n.className = cls;
      n.style.left = `${x * k}px`; n.style.top = `${y * k}px`;
      if (h) n.dataset.h = h;
      annoHandles.appendChild(n);
      return n;
    };
    const b = bbox(a);
    if (a.type !== 'arrow') {
      const box = document.createElement('div');
      box.className = 'abox';
      Object.assign(box.style, { left: `${b.x1 * k}px`, top: `${b.y1 * k}px`, width: `${(b.x2 - b.x1) * k}px`, height: `${(b.y2 - b.y1) * k}px` });
      annoHandles.appendChild(box);
    }
    if (a.type === 'arrow') { put('ahandle', a.x1, a.y1, 'p1'); put('ahandle', a.x2, a.y2, 'p2'); }
    else if (a.type === 'ellipse') { put('ahandle', b.x1, b.y1, 'nw'); put('ahandle', b.x2, b.y1, 'ne'); put('ahandle', b.x1, b.y2, 'sw'); put('ahandle', b.x2, b.y2, 'se'); }
    else { put('ahandle', a.cx + a.r * Math.SQRT1_2, a.cy + a.r * Math.SQRT1_2, 'r'); }
    const del = put('adel', b.x2 + 14 / k, b.y1 - 14 / k);
    del.type = 'button'; del.textContent = '×'; del.title = 'Sil (Delete)'; del.setAttribute('aria-label', 'Çizimi sil');
  }

  function toVideo(e) {
    const r = annoCanvas.getBoundingClientRect();
    const { W, H } = vdim();
    return {
      x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H,
      inside: e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom,
      tol: (10 * W) / r.width // 10 ekran pikseli
    };
  }
  function hitTest(p) {
    for (let i = state.annos.length - 1; i >= 0; i--) {
      const a = state.annos[i];
      if (a.type === 'arrow') {
        const dx = a.x2 - a.x1, dy = a.y2 - a.y1, l2 = dx * dx + dy * dy || 1;
        const t = clamp(((p.x - a.x1) * dx + (p.y - a.y1) * dy) / l2, 0, 1);
        if (Math.hypot(p.x - (a.x1 + t * dx), p.y - (a.y1 + t * dy)) <= Math.max(p.tol, strokeW() * 1.5)) return a;
      } else if (a.type === 'ellipse') {
        const b = bbox(a), rx = (b.x2 - b.x1) / 2 + p.tol, ry = (b.y2 - b.y1) / 2 + p.tol;
        const nx = (p.x - (b.x1 + b.x2) / 2) / rx, ny = (p.y - (b.y1 + b.y2) / 2) / ry;
        if (nx * nx + ny * ny <= 1) return a;
      } else if (Math.hypot(p.x - a.cx, p.y - a.cy) <= a.r) return a;
    }
    return null;
  }

  function annosChanged() { drawAnnos(); renderSummary(); renderOptions(); }
  function selectAnno(id) { state.sel = id; drawAnnos(); }
  function deleteSelected() {
    if (!state.sel) return false;
    state.annos = state.annos.filter((a) => a.id !== state.sel);
    state.sel = null;
    annosChanged();
    return true;
  }
  function setTool(t) {
    state.tool = state.tool === t ? null : t;
    if (state.tool && state.cropEdit) { state.cropEdit = false; renderOptions(); layoutFrame(); }
    if (state.tool && state.cutEdit) { state.cutEdit = false; el.track.classList.remove('cutting'); renderOptions(); }
    document.querySelectorAll('.tool[data-tool]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === state.tool)));
    el.app.classList.toggle('drawing', !!state.tool);
    if (state.tool) { state.sel = null; drawAnnos(); }
  }
  // Görseli en fazla 1600 px'e küçültüp PNG veri adresine çevirir
  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const im = new Image();
      im.onload = () => {
        const k = Math.min(1, 1600 / Math.max(im.naturalWidth, im.naturalHeight));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(im.naturalWidth * k)); c.height = Math.max(1, Math.round(im.naturalHeight * k));
        c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/png'));
      };
      im.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Görsel okunamadı')); };
      im.src = url;
    });
  }
  // Panodaki görseli okur: önce web pano API'si, olmazsa ana süreç
  async function readClipboardImage() {
    try {
      const items = await navigator.clipboard.read();
      for (const it of items) {
        const type = it.types.find((t) => t.startsWith('image/'));
        if (type) return await blobToDataUrl(await it.getType(type));
      }
    } catch (_) { /* izin yok ya da görsel yok */ }
    const r = await api.clipboardImage().catch(() => null);
    return r ? r.dataUrl : null;
  }
  function addImage(src) {
    const { W, H } = vdim();
    const a = { id: ++annoSeq, type: 'image', cx: W / 2, cy: H / 2, r: Math.round(Math.min(W, H) * 0.16), src };
    getImg(a.src);
    state.annos.push(a);
    state.sel = a.id;
    if (state.tool) setTool(state.tool);
    annosChanged();
  }
  async function pasteImage() {
    if (!state.info) return;
    const src = await readClipboardImage();
    if (!src) { toast('Panoda görsel yok; bir görseli kopyalayıp tekrar dene', 'error'); return; }
    addImage(src);
  }
  // Ctrl+V: tarayıcının yapıştırma olayı (izin gerektirmez, ekran görüntüleri dahil)
  document.addEventListener('paste', async (e) => {
    if (!state.info || state.exporting) return;
    if (e.target && e.target.tagName === 'INPUT' && e.target.type === 'text') return; // süre kutusuna metin yapıştırma
    const items = [...((e.clipboardData && e.clipboardData.items) || [])];
    const item = items.find((i) => i.kind === 'file' && i.type.startsWith('image/'));
    if (!item) { e.preventDefault(); pasteImage(); return; }
    e.preventDefault();
    try { addImage(await blobToDataUrl(item.getAsFile())); }
    catch (_) { toast('Panodaki görsel okunamadı', 'error'); }
  });
  function clearAnnos() { state.annos = []; state.sel = null; state.adrag = null; if (state.tool) setTool(state.tool); drawAnnos(); }

  document.querySelectorAll('.tool[data-tool]').forEach((b) => b.addEventListener('click', (e) => { if (e.detail > 0) b.blur(); setTool(b.dataset.tool); }));
  // Bilgisayardan görsel: Görsel düğmesi ya da görsel dosyasını pencereye bırakmak
  async function addImageFile(path) {
    if (state.exporting) return;
    if (!state.info) { toast('Görsel eklemek için önce bir video aç', 'error'); return; }
    try { addImage(await blobToDataUrl(await api.readImage(path))); }
    catch (_) { toast('Görsel açılamadı. PNG, JPG ya da WebP bir dosya dene', 'error'); }
  }
  async function pickImage() {
    if (!state.info || state.exporting) return;
    const p = await api.pickImage();
    if (p) addImageFile(p);
  }
  $('btnPaste').addEventListener('click', (e) => { if (e.detail > 0) e.currentTarget.blur(); setCropEdit(false); pickImage(); });

  // Videonun üzerindeki basışlar: önce çizim katmanı bakar (yakalama evresi); işi yoksa kadraja / oynatmaya geçer.
  el.viewport.addEventListener('pointerdown', (e) => {
    if (!state.info || e.button !== 0 || e.target.closest('.ahandle, .adel')) return;
    const p = toVideo(e);
    if (!p.inside) return;
    if (state.tool) {
      const a = { id: ++annoSeq, type: state.tool, x1: p.x, y1: p.y, x2: p.x, y2: p.y };
      state.annos.push(a);
      state.sel = null;
      state.adrag = { mode: 'draw', id: a.id };
    } else {
      const hit = hitTest(p);
      if (!hit) { if (state.sel) selectAnno(null); return; }
      state.sel = hit.id;
      state.adrag = { mode: 'move', id: hit.id, sx: p.x, sy: p.y, o: { ...hit } };
      drawAnnos();
    }
    e.stopPropagation();
    e.preventDefault();
    state.annoClickGuard = true;
    el.viewport.setPointerCapture(e.pointerId);
  }, true);

  annoHandles.addEventListener('pointerdown', (e) => {
    const h = e.target.closest('.ahandle');
    if (!h || e.button !== 0) return;
    const a = state.annos.find((x) => x.id === state.sel);
    if (!a) return;
    e.stopPropagation();
    e.preventDefault();
    state.annoClickGuard = true;
    state.adrag = { mode: 'handle', id: a.id, h: h.dataset.h, o: { ...a } };
    el.viewport.setPointerCapture(e.pointerId);
  });
  annoHandles.addEventListener('click', (e) => {
    if (e.target.closest('.adel')) { e.stopPropagation(); deleteSelected(); }
  });

  el.viewport.addEventListener('pointermove', (e) => {
    const d = state.adrag;
    if (!d) return;
    const a = state.annos.find((x) => x.id === d.id);
    if (!a) return;
    const p = toVideo(e);
    const { W, H } = vdim();
    const cx = clamp(p.x, 0, W), cy = clamp(p.y, 0, H);
    if (d.mode === 'draw') {
      a.x2 = cx; a.y2 = cy;
      if (a.type === 'ellipse' && e.shiftKey) { // tam daire
        const s = Math.max(Math.abs(a.x2 - a.x1), Math.abs(a.y2 - a.y1));
        a.x2 = a.x1 + Math.sign(a.x2 - a.x1 || 1) * s; a.y2 = a.y1 + Math.sign(a.y2 - a.y1 || 1) * s;
      }
    } else if (d.mode === 'move') {
      const dx = p.x - d.sx, dy = p.y - d.sy, o = d.o;
      if (a.type === 'image') { a.cx = clamp(o.cx + dx, 0, W); a.cy = clamp(o.cy + dy, 0, H); }
      else { a.x1 = o.x1 + dx; a.x2 = o.x2 + dx; a.y1 = o.y1 + dy; a.y2 = o.y2 + dy; }
    } else if (d.mode === 'handle') {
      const o = d.o;
      if (a.type === 'arrow') { if (d.h === 'p1') { a.x1 = cx; a.y1 = cy; } else { a.x2 = cx; a.y2 = cy; } }
      else if (a.type === 'image') { a.r = Math.max(16, Math.hypot(p.x - o.cx, p.y - o.cy)); }
      else {
        const b = bbox(o);
        let x1 = b.x1, y1 = b.y1, x2 = b.x2, y2 = b.y2;
        if (d.h.includes('w')) x1 = cx; else x2 = cx;
        if (d.h.includes('n')) y1 = cy; else y2 = cy;
        if (e.shiftKey) { // karşı köşe sabit, tam daire
          const s = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1));
          if (d.h.includes('w')) x1 = x2 - s; else x2 = x1 + s;
          if (d.h.includes('n')) y1 = y2 - s; else y2 = y1 + s;
        }
        Object.assign(a, { x1, y1, x2, y2 });
      }
    }
    drawAnnos();
  });
  const endAnnoDrag = (e) => {
    const d = state.adrag;
    if (!d) return;
    state.adrag = null;
    try { el.viewport.releasePointerCapture(e.pointerId); } catch (_) {}
    const a = state.annos.find((x) => x.id === d.id);
    if (d.mode === 'draw' && a) {
      const tiny = strokeW() * 2;
      const small = a.type === 'arrow' ? Math.hypot(a.x2 - a.x1, a.y2 - a.y1) < tiny * 2
        : Math.abs(a.x2 - a.x1) < tiny || Math.abs(a.y2 - a.y1) < tiny;
      if (small) state.annos = state.annos.filter((x) => x !== a);
      else {
        if (a.type === 'ellipse') Object.assign(a, bbox(a));
        state.sel = a.id;
      }
      setTool(state.tool); // tek seferlik: çizimden sonra seçim kipine dön
    }
    annosChanged();
  };
  el.viewport.addEventListener('pointerup', endAnnoDrag);
  el.viewport.addEventListener('pointercancel', endAnnoDrag);

  // Kaydetme için tam çözünürlükte saydam PNG
  async function annoPng() {
    if (!state.annos.length) return null;
    await Promise.all(state.annos.filter((a) => a.type === 'image').map((a) => getImg(a.src).decode().catch(() => {})));
    const { W, H } = vdim();
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    drawScene(c.getContext('2d'), state.annos);
    return c.toDataURL('image/png');
  }


  // ---------- Geri al / yinele (Ctrl+Z, Ctrl+Y, Ctrl+Shift+Z) ----------
  // Düzenlenebilir durumun anlık görüntüleri tutulur. Bir sürükleme ya da tuş dizisi tek adım sayılır.
  const hist = { stack: [], i: -1, timer: null, restoring: false };
  function snapshot() {
    return {
      segs: state.segs.map((x) => x.slice()), ratioKey: state.ratioKey,
      crop: state.crop ? { ...state.crop } : null, annos: (state.annos || []).map((a) => ({ ...a })),
      mute: state.mute, resize: state.resize, quality: state.quality
    };
  }
  const snapKey = (s) => JSON.stringify({ ...s, annos: s.annos.map((a) => ({ ...a, src: a.src ? `${a.id}:${a.src.length}` : undefined })) });
  function commitHistory() {
    clearTimeout(hist.timer);
    hist.timer = null;
    if (!state.info || hist.restoring) return;
    const s = snapshot(), k = snapKey(s);
    if (hist.i >= 0 && hist.stack[hist.i].k === k) return;
    hist.stack = hist.stack.slice(0, hist.i + 1);
    hist.stack.push({ s, k });
    if (hist.stack.length > 100) hist.stack.shift();
    hist.i = hist.stack.length - 1;
    renderHistoryButtons();
  }
  function scheduleCommit() {
    if (hist.restoring || state.drag || state.cropDrag || state.adrag) return;
    clearTimeout(hist.timer);
    hist.timer = setTimeout(commitHistory, 300);
    renderHistoryButtons();
  }
  function resetHistory() { clearTimeout(hist.timer); hist.timer = null; hist.stack = []; hist.i = -1; savedKey = null; commitHistory(); renderHistoryButtons(); }
  const canUndo = () => !!state.info && (hist.i > 0 || (!!hist.timer && hist.i >= 0 && snapKey(snapshot()) !== hist.stack[hist.i].k));
  const canRedo = () => !!state.info && hist.i < hist.stack.length - 1;
  function renderHistoryButtons() {
    $('btnUndo').disabled = !canUndo();
    $('btnRedo').disabled = !canRedo();
  }
  // Farklı kaydet sonrası aynı düzenleme "kaydedilmiş" sayılır; yeni bir değişiklik yapılana kadar sorulmaz.
  let savedKey = null;
  const markSaved = () => { savedKey = snapKey(snapshot()); };
  const hasUnsaved = () => hasEdits() && snapKey(snapshot()) !== savedKey;
  function restoreSnapshot(s) {
    hist.restoring = true;
    Object.assign(state, {
      segs: s.segs.map((x) => x.slice()), ratioKey: s.ratioKey,
      crop: s.crop ? { ...s.crop } : null, annos: s.annos.map((a) => ({ ...a })),
      mute: s.mute, resize: s.resize, quality: s.quality
    });
    if (!state.annos.some((a) => a.id === state.sel)) state.sel = null;
    el.optMute.checked = state.mute;
    el.optResize.checked = state.resize;
    renderAll();
    drawAnnos();
    hist.restoring = false;
  }
  function undo() {
    if (state.drag || state.cropDrag || state.adrag) return;
    commitHistory(); // bekleyen son değişiklik kaybolmasın
    if (hist.i <= 0) { toast('Geri alınacak değişiklik yok', 'ok', [], 1600); return; }
    hist.i--;
    restoreSnapshot(hist.stack[hist.i].s);
    renderHistoryButtons();
  }
  function redo() {
    if (state.drag || state.cropDrag || state.adrag) return;
    commitHistory();
    if (hist.i >= hist.stack.length - 1) return;
    hist.i++;
    restoreSnapshot(hist.stack[hist.i].s);
    renderHistoryButtons();
  }

  // ---------- Panoya kopyalama için boyut tahmini ----------
  // Kaynağın bit hızı üzerinden kaba bir tahmin: süre ve (kırpma/küçültmede) piksel oranıyla ölçeklenir.
  const CLIP_MAX = 500 * 1024 * 1024;
  function estimateSize() {
    if (!state.info || !state.fileSize || !state.duration) return 0;
    let est = state.fileSize * (outputDuration() / state.duration);
    if (effectiveQuality() === 'precise' && (state.crop || state.resize)) {
      const vf = G.videoFilter({ info: state.info, crop: state.crop, resize: state.resize });
      est *= Math.min(1, (vf.outW * vf.outH) / (state.info.width * state.info.height || 1));
    }
    return est;
  }
  function fmtBytes(n) {
    if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
    const mb = n / 1024 / 1024;
    return mb < 1000 ? `${mb.toLocaleString('tr', { maximumFractionDigits: mb < 10 ? 1 : 0 })} MB` : `${(mb / 1024).toLocaleString('tr', { maximumFractionDigits: 1 })} GB`;
  }
  // Videoyu panoya dosya olarak koyar; değişiklik yoksa orijinali, varsa geçici bir çıktıyı.
  async function copyToClipboard() {
    if (!state.info || state.exporting) return;
    if (estimateSize() > CLIP_MAX) { toast(`Panoya kopyalamak için çok büyük (≈ ${fmtBytes(estimateSize())}). Kısalt ya da küçült`, 'error'); return; }
    if (!hasEdits()) return finishCopy(state.file);
    return doExport('clipboard');
  }
  async function finishCopy(path) {
    const c = await api.copyFileToClipboard(path);
    if (!c.ok) { toast(`Panoya kopyalanamadı. ${c.error}`, 'error'); return false; }
    const size = await api.fileSize(path).catch(() => 0);
    toast(`Panoya kopyalandı${size ? ` (${fmtBytes(size)})` : ''}. Ctrl+V ile yapıştırabilirsin`);
    return true;
  }

  // ---------- Dışa aktarma ----------
  // Kaydetme penceresi açıkken arkadaki her şey odak ve ekran okuyucu dışında kalır.
  const BACKGROUND = () => [document.querySelector('.framebar'), document.querySelector('.stage'), document.querySelector('.transport')];
  function setBackgroundInert(on) { BACKGROUND().forEach((n) => { n.inert = on; }); }
  // Odak, pencere açılmadan önce neredeyse oraya döner (fareyle tıklandıysa hiçbir yere: Boşluk yine oynatsın).
  let focusBeforeSave = null;
  function restoreFocusAfterSave() {
    const t = focusBeforeSave;
    focusBeforeSave = null;
    if (t && t !== document.body && document.contains(t) && !t.disabled) t.focus({ preventScroll: true });
    else if (document.activeElement) document.activeElement.blur();
  }

  async function doExport(overwrite) {
    // overwrite: true = üzerine yaz, false = Farklı kaydet, 'clipboard' = panoya, 'version' = yanına yeni sürüm
    const toClipboard = overwrite === 'clipboard';
    const asVersion = overwrite === 'version';
    if (toClipboard || asVersion) overwrite = false;
    if (!state.info || state.exporting) return;
    if ((overwrite || asVersion) && !hasEdits()) { toast('Kaydedilecek değişiklik yok'); return; }
    if (outputDuration() < 0.05) { toast('Çıktıda kalacak bir bölüm yok, başlangıç ve bitişi kontrol et', 'error'); return; }
    const quality = effectiveQuality();
    v.pause();
    let output = null;
    if (!overwrite) {
      const ext = quality === 'fast' ? state.srcExt : '.mp4';
      output = toClipboard
        ? await api.clipboardTarget({ input: state.file, ext })
        : asVersion
          ? await api.nextVersionPath({ input: state.file, suffix: '_kesit', ext })
          : await api.saveDialog({ input: state.file, suffix: '_kesit', ext, kind: 'video' });
      if (!output) return;
    }
    const file = state.file;
    if (overwrite) {
      // Windows dosyayı açıkken değiştirmeye izin vermez: önizlemeyi bırak.
      api.cancelProxy();
      state.proxyFor = null;
      clearTimeout(state.loadTimer);
      v.removeAttribute('src');
      v.load();
    }
    state.exporting = true;
    el.exBar.style.transform = 'scaleX(0)';
    el.exPct.textContent = '%0';
    el.exLabel.textContent = 'Hazırlanıyor';
    $('exTitle').textContent = toClipboard ? 'Panoya hazırlanıyor' : 'Kaydediliyor';
    el.btnCancel.hidden = false;
    focusBeforeSave = document.activeElement;
    el.exportModal.hidden = false;
    setBackgroundInert(true);
    el.btnCancel.disabled = false;
    el.btnCancel.focus();
    const overlay = await annoPng();
    const r = await api.exportVideo({
      input: file, output, overwrite, info: state.info,
      segments: state.segs.map((x) => x.slice()), quality,
      crop: state.crop, mute: state.mute, resize: state.resize, overlay
    });
    state.exporting = false;
    el.exportModal.hidden = true;
    setBackgroundInert(false);
    restoreFocusAfterSave();
    if (overwrite) {
      // Kaydedilen (ya da değişmeyen) dosyayı yeniden aç.
      await openFile(file);
      if (r.ok) {
        toast('Kaydedildi', 'ok', [
          { label: 'Geri al', primary: true, fn: () => undoSave(file) },
          { label: 'Klasörde göster', fn: () => api.showInFolder(file) }
        ], 15000, (reason) => commitSave(reason));
      } else if (r.canceled) {
        toast('Kaydetme iptal edildi, dosya değişmedi');
      } else {
        toast(`Kaydedilemedi. ${r.error}`, 'error');
      }
      return !!r.ok;
    }
    if (toClipboard) {
      if (r.ok) return finishCopy(output);
      if (r.canceled) toast('Kopyalama iptal edildi');
      else toast(`Panoya kopyalanamadı. ${r.error}`, 'error');
      return false;
    }
    if (r.ok) {
      markSaved();
      const name = output.split(/[\\/]/).pop();
      toast(`Kaydedildi: ${name}`, 'ok', [
        { label: 'Klasörde göster', fn: () => api.showInFolder(output) },
        { label: 'Aç', fn: () => api.openPath(output) }
      ]);
    } else if (r.canceled) {
      toast('Kaydetme iptal edildi');
    } else {
      toast(`Kaydedilemedi. ${r.error}`, 'error');
    }
    return !!r.ok;
  }
  api.onExportProgress(({ p, label }) => {
    const n = Math.round(clamp(p, 0, 1) * 100);
    el.exBar.style.transform = `scaleX(${n / 100})`;
    el.exPct.textContent = `%${n}`;
    if (label) el.exLabel.textContent = label === 'Bitti' ? 'Tamamlanıyor' : label;
  });
  el.btnCancel.addEventListener('click', () => {
    el.btnCancel.disabled = true;
    el.exLabel.textContent = 'İptal ediliyor';
    api.cancelExport();
  });

  // Bildirim kapanınca yedek Geri Dönüşüm Kutusu'na gider; artık geri alınamaz.
  async function commitSave(reason) {
    const r = await api.commitSave();
    if (r && r.backupKept && reason !== 'replaced') {
      toast(`Eski hali Geri Dönüşüm Kutusu'na gönderilemedi, şurada duruyor: ${r.backupKept.split(/[\\/]/).pop()}`, 'ok', [
        { label: 'Klasörde göster', fn: () => api.showInFolder(r.backupKept) }
      ]);
    }
  }

  async function undoSave(file) {
    toastOnHide = null; // geri alırken yedeği çöpe atma
    hideToast('undo');
    if (state.file === file) {
      // Windows açık dosyanın yerini değiştirmeye izin vermez: önizlemeyi bırak.
      api.cancelProxy();
      state.proxyFor = null;
      clearTimeout(state.loadTimer);
      v.removeAttribute('src');
      v.load();
    }
    const r = await api.undoSave();
    await openFile(file);
    if (r.ok) toast('Geri alındı, orijinal dosya yerinde');
    else toast(`Geri alınamadı. ${r.error}`, 'error');
  }

  async function saveFrame() {
    if (!state.info || state.exporting) return;
    v.pause();
    const t = state.now;
    const stamp = fmtTime(t).replace(/[:.]/g, '-');
    const output = await api.saveDialog({ input: state.file, suffix: `_kare_${stamp}`, ext: '.png', kind: 'png' });
    if (!output) return;
    const r = await api.saveFrame({ input: state.file, time: t, info: state.info, crop: state.crop, output, overlay: await annoPng() });
    if (r.ok) {
      toast(`Kare kaydedildi: ${output.split(/[\\/]/).pop()}`, 'ok', [
        { label: 'Klasörde göster', fn: () => api.showInFolder(output) },
        { label: 'Aç', fn: () => api.openPath(output) }
      ]);
    } else {
      toast(`Kare kaydedilemedi. ${r.error}`, 'error');
    }
  }

  // ---------- Butonlar ----------
  const onClick = (btn, fn) => btn.addEventListener('click', (e) => {
    if (e.detail > 0) btn.blur(); // fareyle tıklandıysa Boşluk tuşu oynatmaya kalsın
    fn();
  });
  onClick($('mOpen'), () => { closeMenu(); openDialog(); });
  onClick($('btnOpen2'), openDialog);
  onClick(el.btnPlay, togglePlay);
  onClick(el.btnPreview, () => { closeMenu(); previewResult(); });
  onClick(el.btnExport, () => doExport('version'));
  onClick(el.btnSaveAs, () => doExport(false));
  // Kaydet'in yanındaki ok: yeni dosya / orijinalin üstüne / farklı kaydet
  const saveMenu = $('saveMenu'), btnSaveMenu = $('btnSaveMenu');
  function openSaveMenu(focus) {
    saveMenu.hidden = false;
    btnSaveMenu.setAttribute('aria-expanded', 'true');
    if (focus) { const f = saveMenu.querySelector('.mitem:not(:disabled)'); if (f) f.focus(); }
  }
  function closeSaveMenu(returnFocus) {
    if (saveMenu.hidden) return;
    saveMenu.hidden = true;
    btnSaveMenu.setAttribute('aria-expanded', 'false');
    if (returnFocus) btnSaveMenu.focus();
  }
  btnSaveMenu.addEventListener('click', (e) => {
    if (saveMenu.hidden) openSaveMenu(e.detail === 0); else closeSaveMenu(e.detail === 0);
    if (e.detail > 0) btnSaveMenu.blur();
  });
  saveMenu.addEventListener('click', (e) => { if (e.target.closest('.mitem')) closeSaveMenu(false); }, true);
  document.addEventListener('pointerdown', (e) => { if (!e.target.closest('.save-wrap')) closeSaveMenu(false); });
  saveMenu.addEventListener('keydown', (e) => {
    const items = [...saveMenu.querySelectorAll('.mitem:not(:disabled)')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); closeSaveMenu(true); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]; if (n) n.focus();
    } else if (e.key === 'Tab') closeSaveMenu(false);
    e.stopPropagation();
  });
  // Fareyle açılmış menüler Esc ile de kapansın (odak menüde olmasa bile)
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!saveMenu.hidden) { e.preventDefault(); e.stopPropagation(); closeSaveMenu(false); }
    else if (!ratioMenu.hidden) { e.preventDefault(); e.stopPropagation(); closeRatioMenu(false); }
  }, true);
  onClick($('btnSaveVersion'), () => doExport('version'));
  onClick($('btnOverwrite'), () => doExport(true));
  onClick(el.btnFrame, () => { closeMenu(); saveFrame(); });
  document.querySelectorAll('.ratio').forEach((b) => b.addEventListener('mouseup', () => b.blur()));
  document.querySelectorAll('.mcheck').forEach((l) => l.addEventListener('mouseup', () => setTimeout(() => document.activeElement && document.activeElement.blur(), 0)));

  // ---------- "Diğer" menüsü ----------
  function openMenu(focusFirst) {
    el.menu.hidden = false;
    el.btnMenu.setAttribute('aria-expanded', 'true');
    if (focusFirst) el.menu.querySelector('button, input:not(:disabled)').focus();
  }
  function closeMenu(returnFocus) {
    if (el.menu.hidden) return;
    el.menu.hidden = true;
    el.btnMenu.setAttribute('aria-expanded', 'false');
    if (returnFocus) el.btnMenu.focus();
  }
  el.btnMenu.addEventListener('click', (e) => {
    if (el.menu.hidden) openMenu(e.detail === 0); else closeMenu(e.detail === 0);
    if (e.detail > 0) el.btnMenu.blur();
  });
  document.addEventListener('pointerdown', (e) => {
    if (!el.menu.hidden && !e.target.closest('.menu-wrap')) closeMenu(false);
  });
  el.menu.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(true); return; }
    // Menü içindeyken oklar ve harfler videoyu etkilemesin; Tab ile gezilir
    if (e.key !== 'Tab') e.stopPropagation();
  });
  el.menu.addEventListener('focusout', (e) => {
    if (!el.menu.hidden && e.relatedTarget && !e.relatedTarget.closest('.menu-wrap')) closeMenu(false);
  });

  // ---------- Klavye ----------
  document.addEventListener('keydown', (e) => {
    const tag = e.target.tagName;
    const typing = tag === 'INPUT' && e.target.type === 'text';
    const onControl = tag === 'BUTTON' || tag === 'INPUT';
    const ctrl = e.ctrlKey || e.metaKey;
    const k = (e.key || '').toLocaleLowerCase('tr');

    if (asking) { // soru açıkken yalnızca pencerenin düğmeleri çalışır
      if (e.key === 'Escape') { e.preventDefault(); asking('cancel'); }
      return;
    }
    if (updating) { e.preventDefault(); return; }
    if (!el.appMenu.hidden) return; // menü kendi tuşlarını işler
    if (!$('infoModal').hidden) return;
    if (e.key === 'F10') { e.preventDefault(); openAppMenu(true); return; }
    if (ctrl && (k === 'w' || e.code === 'KeyW')) { e.preventDefault(); closeFile(); return; }
    if (ctrl && (k === 'o' || e.code === 'KeyO')) { e.preventDefault(); openDialog(); return; }
    // Yakınlaştırma (yazı yazarken de çalışır)
    if (ctrl && !e.altKey) {
      const step = (e.key === '+' || e.key === '=' || e.code === 'NumpadAdd') ? 1
        : (e.key === '-' || e.code === 'NumpadSubtract') ? -1
        : (e.key === '0' || e.code === 'Numpad0') ? 0 : null;
      if (step !== null) { e.preventDefault(); api.zoomStep(step); return; }
    }
    if (typing) return;
    if (!state.info || state.exporting) {
      if (e.key === 'Escape' && state.exporting) api.cancelExport();
      return;
    }
    if (ctrl && (k === 's' || e.code === 'KeyS')) { e.preventDefault(); doExport(e.shiftKey ? false : 'version'); return; }
    if (ctrl && e.shiftKey && (k === 'c' || e.code === 'KeyC')) { e.preventDefault(); copyToClipboard(); return; }
    if (ctrl && !e.altKey && (k === 'z' || e.code === 'KeyZ')) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (ctrl && !e.altKey && (k === 'y' || e.code === 'KeyY')) { e.preventDefault(); redo(); return; }
    if (ctrl || e.altKey) return;

    if (e.key === ' ' || e.key === 'Enter') {
      if (onControl) return; // odaklanmış butonu çalıştır
      if (e.key === ' ') { e.preventDefault(); togglePlay(); }
      return;
    }
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !(tag === 'INPUT')) {
      e.preventDefault();
      cancelPreview();
      v.pause();
      const step = e.shiftKey ? 1 : 1 / fps();
      seekTo(snap(state.now + (e.key === 'ArrowLeft' ? -step : step)));
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && state.sel) { e.preventDefault(); deleteSelected(); return; }
    if (e.key === 'Escape' && state.cropEdit) { e.preventDefault(); setCropEdit(false); return; }
    if (e.key === 'Escape' && state.cutEdit) { e.preventDefault(); setCutEdit(false); return; }
    if (e.key === 'Escape' && (state.tool || state.sel)) {
      if (state.tool) setTool(state.tool); else selectAnno(null);
      return;
    }
    if (e.key === 'Home') { e.preventDefault(); seekTo(0); return; }
    if (e.key === 'End') { e.preventDefault(); seekTo(state.duration); return; }
    if (k === 'i' || k === 'ı') { e.preventDefault(); setIn(); return; }
    if (k === 'o') { e.preventDefault(); setOut(); return; }
    if (k === 'p') { e.preventDefault(); previewResult(); return; }
    if (e.key === 'Escape' && !el.toast.hidden) hideToast('closed');
  });

  // ---------- Sürükle bırak ----------
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
  window.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) document.body.classList.remove('dragging'); });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dragging');
    if (api.nativeDrop) return; // Tauri: dosya yolu yerel sürükle-bırak olayından gelir
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    const p = api.pathForFile(f);
    if (p) openFile(p); else toast('Bu öğe açılamadı, bir video dosyası sürükle', 'error');
  });

  // ---------- Pencere ----------
  let resizeRaf = null;
  const ro = new ResizeObserver(() => {
    if (resizeRaf) return;
    resizeRaf = requestAnimationFrame(() => { resizeRaf = null; layoutFrame(); renderRuler(); });
  });
  ro.observe(el.viewport);
  ro.observe(el.track);

  api.onOpenFile((p) => requestOpen(p));
  api.onOpenImage((p) => addImageFile(p));
  api.onBeforeClose(() => confirmLeave());
  api.onZoomChanged((z) => toast(`Yakınlaştırma %${Math.round(z * 100)}`, 'ok', [], 1600));
  api.initialFile().then((p) => { if (p) openFile(p); });

  // ---------- Videoyu kapat ----------
  async function closeFile() {
    if (!state.info || !(await confirmLeave())) return;
    hideToast('closed'); // bekleyen "Geri al" yedeği Geri Dönüşüm Kutusu'na gider
    state.loadToken++;
    api.cancelProxy();
    state.proxyFor = null;
    clearTimeout(state.loadTimer);
    cancelPreview();
    v.pause();
    v.removeAttribute('src');
    v.load();
    hideStageMsg();
    if (state.tool) setTool(state.tool);
    clearAnnos();
    Object.assign(state, { file: null, info: null, duration: 0, inT: 0, outT: 0, segs: [], cropEdit: false, cutEdit: false, now: 0, crop: null, mode: 'keep', proxy: false });
    el.track.classList.remove('cutting');
    el.app.dataset.state = 'empty';
    document.querySelectorAll('.fb-center').forEach((n) => { n.inert = true; });
    el.strip.innerHTML = '';
    [el.btnPlay, el.inTime, el.outTime, el.btnFrame, el.btnPreview, el.optResize, el.optMute, el.btnExport, el.btnSaveAs, $('btnSaveMenu'), $('btnCopy'), $('btnMute'), ...TRANSPORT(),
      ...document.querySelectorAll('.seg button')].forEach((n) => { n.disabled = true; });
    el.inTime.value = el.outTime.value = fmtTime(0);
    el.tNow.textContent = el.tTotal.textContent = fmtTime(0);
    el.sumDur.textContent = '–'; el.sumSize.textContent = ''; el.sumFlags.textContent = ''; $('sumBytes').textContent = '';
    $('btnExportLabel').textContent = 'Kaydet';
    $('fHdr').hidden = true; el.fProxy.hidden = true;
    document.title = 'Kesit';
    resetHistory();
    $('btnOpen2').focus({ preventScroll: true });
  }

  // ---------- Bilgi penceresi (kısayollar, hakkında) ----------
  let infoReturn = null;
  function showInfo(title, body) {
    $('infoTitle').textContent = title;
    $('infoBody').replaceChildren(body);
    infoReturn = document.activeElement;
    $('infoModal').hidden = false;
    setBackgroundInert(true);
    $('infoClose').focus();
  }
  function hideInfo() {
    if ($('infoModal').hidden) return;
    $('infoModal').hidden = true;
    setBackgroundInert(false);
    if (infoReturn && document.contains(infoReturn)) infoReturn.focus({ preventScroll: true });
  }
  $('infoClose').addEventListener('click', hideInfo);
  $('infoModal').addEventListener('pointerdown', (e) => { if (e.target === e.currentTarget) hideInfo(); });
  $('infoModal').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); hideInfo(); } });
  function showKeys() {
    const dl = document.createElement('dl');
    dl.className = 'mkeys';
    for (const [what, keys] of [
      ['Oynat, durdur', 'Boşluk'], ['Parçanın başı, sonu', 'I  O'], ['Bir kare, bir saniye', '←  →  Shift'],
      ['Başa, sona', 'Home  End'], ['Sonucu önizle', 'P'], ['Geri al, yinele', 'Ctrl Z  Ctrl Y'],
      ['Video aç, kapat', 'Ctrl O  Ctrl W'], ['Kaydet, farklı kaydet', 'Ctrl S  Ctrl Shift S'],
      ['Panoya kopyala', 'Ctrl Shift C'], ['Görsel yapıştır', 'Ctrl V'], ['Seçili çizimi sil', 'Delete'], ['Yakınlaştır, uzaklaştır', 'Ctrl +  Ctrl −  Ctrl 0'],
      ['Menü', 'Alt  F10']
    ]) {
      const dt = document.createElement('dt'); dt.textContent = what;
      const dd = document.createElement('dd');
      keys.split('  ').forEach((k, i) => { if (i) dd.append(' '); const kb = document.createElement('kbd'); kb.textContent = k; dd.append(kb); });
      dl.append(dt, dd);
    }
    showInfo('Klavye kısayolları', dl);
  }
  async function showAbout() {
    const ver = await api.appVersion().catch(() => '');
    const box = document.createElement('div');
    const p1 = document.createElement('p'); p1.textContent = `Sürüm ${ver}. Videoyu hızlıca kes, kırp, üzerine çiz.`;
    const p2 = document.createElement('p'); p2.textContent = 'Video işleme için FFmpeg (GPL) kullanılır.';
    box.append(p1, p2);
    showInfo('Kesit', box);
  }

  // ---------- Windows 11 klasik sağ tık menüsü ----------
  let classicMenu = false;
  if (api.isWindows) api.classicMenuGet().then((on) => { classicMenu = !!on; }).catch(() => {});
  async function toggleClassicMenu() {
    const on = !classicMenu;
    const r = await api.classicMenuSet(on);
    if (!r.ok) { toast(`Ayar değiştirilemedi. ${r.error}`, 'error'); return; }
    classicMenu = on;
    toast(on
      ? 'Klasik menü açıldı. Görünmesi için Gezgin yeniden başlamalı (açık klasör pencereleri kapanır)'
      : 'Windows 11 menüsüne dönüldü. Görünmesi için Gezgin yeniden başlamalı (açık klasör pencereleri kapanır)', 'ok', [
      { label: 'Şimdi yeniden başlat', primary: true, fn: () => { hideToast('closed'); api.restartExplorer(); } },
      { label: 'Sonra', fn: () => hideToast('closed') }
    ], 20000);
  }

  // ---------- Uygulama menüsü (sol üst) ----------
  const hasFile = () => !!state.info && !state.exporting;
  const MENU = [
    { label: 'Dosya', items: [
      { label: 'Video aç…', keys: 'Ctrl O', run: openDialog },
      { label: 'Kaydet', keys: 'Ctrl S', run: () => doExport('version'), on: () => hasFile() && hasEdits() && outputDuration() >= 0.05 },
      { label: 'Orijinalin üstüne kaydet', run: () => doExport(true), on: () => hasFile() && hasEdits() && outputDuration() >= 0.05 },
      { label: 'Farklı kaydet…', keys: 'Ctrl Shift S', run: () => doExport(false), on: () => hasFile() && outputDuration() >= 0.05 },
      { label: 'Panoya kopyala', keys: 'Ctrl Shift C', run: copyToClipboard, on: () => hasFile() && outputDuration() >= 0.05 && estimateSize() <= CLIP_MAX },
      { label: 'Bu kareyi PNG olarak kaydet…', run: saveFrame, on: hasFile },
      '-',
      { label: 'Klasörde göster', run: () => api.showInFolder(state.file), on: hasFile },
      { label: 'Videoyu kapat', keys: 'Ctrl W', run: closeFile, on: hasFile },
      '-',
      { label: 'Çıkış', keys: 'Alt F4', run: () => api.quit() }
    ] },
    { label: 'Düzen', items: [
      { label: 'Geri al', keys: 'Ctrl Z', run: undo, on: () => hasFile() && canUndo() },
      { label: 'Yinele', keys: 'Ctrl Y', run: redo, on: () => hasFile() && canRedo() },
      '-',
      { label: 'Parçanın başını buraya al', keys: 'I', run: () => setIn(), on: hasFile },
      { label: 'Parçanın sonunu buraya al', keys: 'O', run: () => setOut(), on: hasFile },
      { label: 'Kesimleri sıfırla', run: () => { state.segs = [[0, state.duration]]; renderAll(); }, on: () => hasFile() && !(state.segs.length === 1 && state.segs[0][0] === 0 && state.segs[0][1] === state.duration) },
      '-',
      { label: 'Hızlı ve kayıpsız kaydet', check: () => effectiveQuality() === 'fast', on: () => hasFile() && !el.optFast.disabled,
        hint: 'Yeniden kodlamaz; kesim birkaç kare kayabilir. Kırpma, küçültme ya da çizim varken kullanılamaz',
        run: () => { el.optFast.checked = !el.optFast.checked; el.optFast.dispatchEvent(new Event('change')); } },
      { label: '1080 px genişliğe küçült', check: () => state.resize, on: hasFile, hint: "Instagram'ın gösterdiği en büyük boyut",
        run: () => { el.optResize.checked = !el.optResize.checked; el.optResize.dispatchEvent(new Event('change')); } },
      '-',
      { label: 'Görsel ekle…', run: pickImage, on: hasFile },
      { label: 'Görseli yapıştır', keys: 'Ctrl V', run: pasteImage, on: hasFile },
      { label: 'Kırpmayı sıfırla', run: resetCrop, on: () => hasFile() && !!state.crop },
      { label: 'Çizimleri temizle', run: () => { clearAnnos(); annosChanged(); }, on: () => hasFile() && state.annos.length > 0 }
    ] },
    { label: 'Görünüm', items: [
      { label: 'Yakınlaştır', keys: 'Ctrl +', run: () => api.zoomStep(1) },
      { label: 'Uzaklaştır', keys: 'Ctrl −', run: () => api.zoomStep(-1) },
      { label: 'Gerçek boyut', keys: 'Ctrl 0', run: () => api.zoomStep(0) },
      '-',
      { label: 'Koyu tema', check: () => theme === 'dark', run: toggleTheme },
      { label: 'Yalnız kırpılan alanı göster', check: () => !!state.cropView, on: () => hasFile() && !!state.crop, run: toggleCropView, hint: 'Kırpılan kısım pencereyi doldurur' },
      '-',
      { label: 'Sonucu önizle', keys: 'P', run: previewResult, on: hasFile },
      ...(api.isWindows ? ['-', { label: 'Klasik sağ tık menüsü', check: () => classicMenu, run: toggleClassicMenu }] : [])
    ] },
    { label: 'Yardım', items: [
      { label: 'Klavye kısayolları', run: showKeys },
      { label: 'Güncellemeleri denetle', run: () => checkUpdate(true) },
      { label: 'Deneme sürümlerini al', check: () => previewChannel, run: togglePreview,
        hint: 'Yayınlanmamış en son değişiklikler de güncelleme olarak gelir. Kararsız olabilir' },
      { label: 'GitHub sayfası', run: () => api.openUrl('https://github.com/dumanworld/kesit') },
      '-',
      { label: 'Kesit hakkında', run: showAbout }
    ] }
  ];
  const CHEVRON = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 2.5L8 6l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  function buildAppMenu() {
    const root = el.appMenu;
    root.replaceChildren();
    for (const group of MENU) {
      const g = document.createElement('div');
      g.className = 'am-group';
      const parent = document.createElement('button');
      parent.type = 'button'; parent.className = 'mitem am-parent';
      parent.setAttribute('role', 'menuitem'); parent.setAttribute('aria-haspopup', 'menu'); parent.setAttribute('aria-expanded', 'false');
      parent.innerHTML = CHEVRON;
      parent.prepend(group.label);
      const sub = document.createElement('div');
      sub.className = 'appmenu am-sub'; sub.setAttribute('role', 'menu'); sub.setAttribute('aria-label', group.label); sub.hidden = true;
      for (const it of group.items) {
        if (it === '-') { const sep = document.createElement('div'); sep.className = 'msep'; sep.setAttribute('role', 'separator'); sub.append(sep); continue; }
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'mitem'; b.setAttribute('role', it.check ? 'menuitemcheckbox' : 'menuitem');
        b.textContent = it.label;
        if (it.check) b.title = it.hint || "Windows 11'de videoya ilk sağ tıklamada \"Kesit ile düzenle\" görünsün. Tüm sağ tık menüleri Windows 10'daki gibi açılır";
        if (it.keys) { const k = document.createElement('span'); k.className = 'am-keys'; k.textContent = it.keys; b.append(k); }
        b.addEventListener('click', () => { closeAppMenu(false); it.run(); });
        b._item = it;
        sub.append(b);
      }
      parent.addEventListener('click', () => openSub(g, true));
      parent.addEventListener('pointerenter', () => openSub(g, false));
      g.append(parent, sub);
      root.append(g);
    }
  }
  function openSub(g, focusFirst) {
    for (const other of el.appMenu.querySelectorAll('.am-group')) {
      const on = other === g;
      other.querySelector('.am-sub').hidden = !on;
      other.querySelector('.am-parent').setAttribute('aria-expanded', String(on));
    }
    const sub = g.querySelector('.am-sub');
    sub.querySelectorAll('.mitem').forEach((b) => {
      b.disabled = !!(b._item.on && !b._item.on());
      if (b._item.check) b.setAttribute('aria-checked', String(!!b._item.check()));
    });
    if (focusFirst) { const f = sub.querySelector('.mitem:not(:disabled)'); if (f) f.focus(); }
  }
  function closeSubs() {
    el.appMenu.querySelectorAll('.am-sub').forEach((x) => { x.hidden = true; });
    el.appMenu.querySelectorAll('.am-parent').forEach((x) => x.setAttribute('aria-expanded', 'false'));
  }
  function openAppMenu(focusFirst) {
    if (asking || updating || state.exporting || !$('infoModal').hidden) return;
    closeMenu(false);
    if (!el.appMenu.childElementCount) buildAppMenu();
    closeSubs();
    el.appMenu.hidden = false;
    el.btnAppMenu.setAttribute('aria-expanded', 'true');
    if (focusFirst) el.appMenu.querySelector('.am-parent').focus();
  }
  function closeAppMenu(returnFocus) {
    if (el.appMenu.hidden) return;
    closeSubs();
    el.appMenu.hidden = true;
    el.btnAppMenu.setAttribute('aria-expanded', 'false');
    if (returnFocus) el.btnAppMenu.focus(); else if (el.appMenu.contains(document.activeElement)) document.activeElement.blur();
  }
  el.btnAppMenu.addEventListener('click', (e) => {
    if (el.appMenu.hidden) openAppMenu(e.detail === 0); else closeAppMenu(e.detail === 0);
    if (e.detail > 0) el.btnAppMenu.blur();
  });
  document.addEventListener('pointerdown', (e) => {
    if (!el.appMenu.hidden && !e.target.closest('.appmenu-wrap')) closeAppMenu(false);
  });
  el.appMenu.addEventListener('keydown', (e) => {
    const cur = document.activeElement;
    const inSub = cur && cur.closest('.am-sub');
    const list = [...(inSub ? inSub : el.appMenu).querySelectorAll(inSub ? '.mitem:not(:disabled)' : '.am-parent')];
    const i = list.indexOf(cur);
    const move = (d) => { const n = list[(i + d + list.length) % list.length]; if (n) n.focus(); };
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Home') { e.preventDefault(); list[0] && list[0].focus(); }
    else if (e.key === 'End') { e.preventDefault(); list[list.length - 1] && list[list.length - 1].focus(); }
    else if (e.key === 'ArrowRight' && !inSub && cur.classList.contains('am-parent')) { e.preventDefault(); openSub(cur.parentElement, true); }
    else if ((e.key === 'ArrowLeft' || e.key === 'Escape') && inSub) {
      e.preventDefault(); e.stopPropagation();
      const g = inSub.parentElement; closeSubs(); g.querySelector('.am-parent').focus();
    } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeAppMenu(true); }
    else if (e.key === 'Tab') { closeAppMenu(false); }
    else if (e.key.length === 1 && !e.ctrlKey && !e.altKey) {
      // Harfle atla: "D" Dosya / Düzen arasında gezer
      const ch = e.key.toLocaleLowerCase('tr');
      const order = [...list.slice(i + 1), ...list.slice(0, i + 1)];
      const hit = order.find((b) => b.textContent.trim().toLocaleLowerCase('tr').startsWith(ch));
      if (hit) { e.preventDefault(); hit.focus(); }
    }
  });
  // Windows alışkanlığı: Alt'a tek başına basıp bırakınca menü açılır
  let altAlone = false;
  document.addEventListener('keydown', (e) => { altAlone = e.key === 'Alt' && !e.repeat ? true : (e.key === 'Alt' && altAlone); }, true);
  document.addEventListener('keyup', (e) => {
    if (e.key !== 'Alt' || !altAlone) return;
    altAlone = false;
    e.preventDefault();
    if (el.appMenu.hidden) openAppMenu(true); else closeAppMenu(true);
  });
  window.addEventListener('blur', () => { altAlone = false; });
  $('btnCopy').addEventListener('click', (e) => { if (e.detail > 0) e.currentTarget.blur(); copyToClipboard(); });
  el.btnUndo = $('btnUndo'); el.btnRedo = $('btnRedo');
  el.btnUndo.addEventListener('click', (e) => { if (e.detail > 0) e.currentTarget.blur(); undo(); });
  el.btnRedo.addEventListener('click', (e) => { if (e.detail > 0) e.currentTarget.blur(); redo(); });

  // ---------- Güncelleme ----------
  let updating = false;
  let previewChannel = false;
  api.getPreview().then((on) => { previewChannel = on; }).catch(() => {});
  async function togglePreview() {
    previewChannel = !previewChannel;
    await api.setPreview(previewChannel);
    if (previewChannel) checkUpdate(true);
    else toast('Deneme sürümleri kapatıldı. Bir sonraki kararlı sürüm normal güncelleme olarak gelir');
  }
  async function checkUpdate(manual) {
    let u = null;
    try { u = await api.checkUpdate(); }
    catch (e) { if (manual) toast(`Güncelleme denetlenemedi. İnternet bağlantını kontrol et. (${String(e).slice(0, 120)})`, 'error'); return; }
    if (!u && manual) { toast(`Kesit güncel (sürüm ${await api.appVersion().catch(() => '?')})`); return; }
    if (!u || updating) return;
    toast(`Kesit ${u.version} hazır`, 'ok', [
      { label: 'Güncelle', primary: true, fn: installUpdate },
      { label: 'Sonra', fn: () => hideToast('closed') }
    ], 30000);
  }
  async function installUpdate() {
    hideToast('update');
    if (updating || !(await confirmLeave())) return;
    updating = true;
    await api.commitSave().catch(() => {});
    cancelPreview();
    v.pause();
    $('exTitle').textContent = 'Güncelleniyor';
    el.exLabel.textContent = 'İndiriliyor';
    el.exBar.style.transform = 'scaleX(0)';
    el.exPct.textContent = '%0';
    el.btnCancel.hidden = true;
    el.exportModal.hidden = false;
    setBackgroundInert(true);
    const r = await api.installUpdate((p) => {
      const n = Math.round(clamp(p, 0, 1) * 100);
      el.exBar.style.transform = `scaleX(${n / 100})`;
      el.exPct.textContent = `%${n}`;
      if (n >= 100) el.exLabel.textContent = 'Kuruluyor, Kesit yeniden açılacak';
    });
    // Windows'ta kurulum başlayınca uygulama kapanır; buraya yalnızca hata olursa gelinir.
    updating = false;
    el.exportModal.hidden = true;
    el.btnCancel.hidden = false;
    setBackgroundInert(false);
    if (!r.ok) toast(`Güncellenemedi. ${r.error}`, 'error');
  }
  setTimeout(() => checkUpdate(false), 4000);

  // Test kancası (yalnızca geliştirme sırasında kullanılır)
  window.__kesit = { state, copyToClipboard, estimateSize, openFile, requestOpen, addImageFile, hasUnsaved, closeFile, openAppMenu, setIn, setOut, seekTo, setRatio };
})();
