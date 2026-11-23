'use strict';
// Tarayıcıda Node'un path modülünün Kesit'in kullandığı kadarı. Hem "\" hem "/" ayırıcıyı tanır;
// birleştirirken ilk yolun ayırıcısını kullanır (Windows'ta "\").
(function (root) {
  const isSep = (c) => c === '/' || c === '\\';
  const sepOf = (p) => (/\\/.test(p) || /^[a-zA-Z]:/.test(p) ? '\\' : '/');

  function trimEnd(p) {
    let e = p.length;
    while (e > 1 && isSep(p[e - 1]) && !/^[a-zA-Z]:$/.test(p.slice(0, e - 1))) e--;
    return p.slice(0, e);
  }
  function basename(p, ext) {
    p = trimEnd(String(p));
    let i = p.length - 1;
    while (i >= 0 && !isSep(p[i])) i--;
    let b = p.slice(i + 1);
    if (ext && b.endsWith(ext) && b !== ext) b = b.slice(0, -ext.length);
    return b;
  }
  function dirname(p) {
    p = trimEnd(String(p));
    let i = p.length - 1;
    while (i >= 0 && !isSep(p[i])) i--;
    if (i < 0) return '.';
    if (i === 0) return p[0];
    const d = p.slice(0, i);
    return /^[a-zA-Z]:$/.test(d) ? d + p[i] : d;
  }
  function extname(p) {
    const b = basename(p);
    const i = b.lastIndexOf('.');
    return i <= 0 ? '' : b.slice(i);
  }
  function join(...parts) {
    parts = parts.filter((x) => x !== '' && x != null).map(String);
    if (!parts.length) return '.';
    const sep = sepOf(parts[0]);
    let out = parts[0];
    for (const part of parts.slice(1)) {
      out = (isSep(out[out.length - 1]) ? out : out + sep) + part.replace(/^[\\/]+/, '');
    }
    return sep === '\\' ? out.replace(/\//g, '\\') : out;
  }
  // Karşılaştırma için: ayırıcıları birleştirir, Windows'ta büyük/küçük harfi yok sayar.
  function same(a, b) {
    const n = (p) => {
      const s = trimEnd(String(p).replace(/[\\/]+/g, '/'));
      return sepOf(String(p)) === '\\' ? s.toLowerCase() : s;
    };
    return n(a) === n(b);
  }

  const api = { basename, dirname, extname, join, same, sep: sepOf };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KesitPath = api;
})(typeof self !== 'undefined' ? self : this);
