'use strict';
// Kırpma ve çıktı boyutu hesapları. Hem ana süreçte (Node) hem arayüzde (tarayıcı) kullanılır.
(function (root, factory) {
  const g = factory();
  if (typeof module === 'object' && module.exports) module.exports = g;
  else root.KesitGeometry = g;
})(typeof self !== 'undefined' ? self : this, function () {
  const even = (n) => Math.max(2, Math.floor(n / 2) * 2);

  // HDR (HLG / PQ) kaynakları SDR'ye çevirir; aksi halde Instagram'da soluk görünür.
  const TONEMAP = 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p';

  // Normalleştirilmiş kırpma kutusunu (0..1) piksel değerlerine çevirir.
  function cropPixels(crop, info) {
    const W = info.width, H = info.height;
    let w = even(crop.w * W);
    let h = even(crop.h * H);
    if (crop.ratio) {
      // Ekran oranını korumak için genişliği yükseklikten hesapla (kare olmayan piksel desteğiyle).
      const rPx = crop.ratio / (info.sar || 1);
      w = even(Math.round(h * rPx));
      if (w > W) { w = even(W); h = even(Math.round(w / rPx)); }
      if (h > H) { h = even(H); }
    }
    w = Math.min(w, even(W));
    h = Math.min(h, even(H));
    let x = crop.x * W < 2 ? 0 : even(crop.x * W);
    let y = crop.y * H < 2 ? 0 : even(crop.y * H);
    x = Math.max(0, Math.min(x, W - w));
    y = Math.max(0, Math.min(y, H - h));
    x = Math.floor(x / 2) * 2; y = Math.floor(y / 2) * 2;
    return { w, h, x, y };
  }

  // Çıktının piksel boyutunu ve video filtre zincirini hesaplar.
  function videoFilter(opts) {
    const { info, crop, resize } = opts;
    const filters = [];
    let outW = info.width, outH = info.height;
    if (crop) {
      const c = cropPixels(crop, info);
      filters.push(`crop=${c.w}:${c.h}:${c.x}:${c.y}`);
      outW = c.w; outH = c.h;
    }
    if (info.hdr) filters.push(TONEMAP);
    if (resize && outW > 1080) {
      const ratio = crop && crop.ratio ? crop.ratio : (outW * (info.sar || 1)) / outH;
      const tw = 1080;
      const th = even(Math.round(tw / ratio));
      filters.push(`scale=${tw}:${th}:flags=lanczos`, 'setsar=1');
      outW = tw; outH = th;
    }
    return { vf: filters.join(','), outW, outH };
  }

  // Bindirme (çizimler) varken zincir ikiye ayrılır: önce renk dönüşümü (HDR), sonra bindirme,
  // en son kırpma ve ölçekleme. Böylece çizimler tam karenin piksel koordinatlarında kalır.
  function videoChain(opts) {
    const { info } = opts;
    const pre = info.hdr ? TONEMAP : '';
    const post = videoFilter({ ...opts, info: { ...info, hdr: false } }).vf;
    return { pre, post };
  }

  return { even, cropPixels, videoFilter, videoChain, TONEMAP };
});
