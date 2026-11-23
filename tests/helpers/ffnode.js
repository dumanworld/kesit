'use strict';
// Node tarafı: ffmpeg süreçlerini başlatır. Saf mantık ffcore.js'te (Tauri ön yüzüyle ortak).
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const C = require('../../src/ffcore');

const IS_WIN = process.platform === 'win32';

function resolveFfmpeg(resourcesPath) {
  const exe = IS_WIN ? 'ffmpeg.exe' : 'ffmpeg';
  const candidates = [];
  if (resourcesPath) candidates.push(path.join(resourcesPath, exe));
  candidates.push(path.join(__dirname, exe));
  // (geliştirme) PATH'teki ffmpeg kullanılır
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return c; } catch (_) { /* yok */ }
  }
  return exe; // PATH üzerinden dene
}

function run(ffmpegPath, args, { duration = 0, onProgress, onSpawn } = {}) {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(ffmpegPath, args, { windowsHide: true });
    } catch (e) { reject(e); return; }
    if (onSpawn) onSpawn(proc);
    let stderr = '';
    let buf = '';
    proc.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        const m = line.match(/^out_time_(?:us|ms)=(\d+)/);
        if (m && onProgress && duration > 0) onProgress(Math.min(1, (+m[1]) / 1e6 / duration));
      }
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
    });
    proc.on('error', (e) => {
      if (e.code === 'ENOENT') reject(new Error('ffmpeg bulunamadı. Uygulama klasöründeki dosyalar eksik olabilir.'));
      else reject(e);
    });
    proc.on('close', (code, signal) => {
      if (code === 0) resolve({ stderr });
      else {
        const err = new Error(C.lastError(stderr) || `ffmpeg hata kodu ${code}`);
        err.killed = !!signal || proc.killedByUser;
        err.stderr = stderr;
        reject(err);
      }
    });
  });
}

function capture(ffmpegPath, args, { binary = false, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    let proc;
    try { proc = spawn(ffmpegPath, args, { windowsHide: true }); } catch (e) { reject(e); return; }
    const out = []; let err = '';
    const timer = setTimeout(() => { try { proc.kill(); } catch (_) {} }, timeoutMs);
    proc.stdout.on('data', (c) => out.push(c));
    proc.stderr.on('data', (c) => { err += c.toString(); });
    proc.on('error', (e) => {
      clearTimeout(timer);
      if (e.code === 'ENOENT') reject(new Error('ffmpeg bulunamadı. Uygulama klasöründeki dosyalar eksik olabilir.'));
      else reject(e);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out);
      resolve({ code, stdout: binary ? stdout : stdout.toString(), stderr: err });
    });
  });
}

async function probe(ffmpegPath, input) {
  const { stderr } = await capture(ffmpegPath, ['-hide_banner', '-i', input]);
  if (/No such file|Invalid data found|could not find codec|Permission denied/i.test(stderr) && !/Duration:/.test(stderr)) {
    throw new Error('Bu dosya okunamadı. Bir video dosyası olduğundan emin ol.');
  }
  const info = C.parseProbe(stderr);
  if (!info.hasVideo) throw new Error('Bu dosyada video bulunamadı.');
  return info;
}

const G = require('../../src/geometry');
module.exports = { ...C, cropPixels: G.cropPixels, videoFilter: G.videoFilter, resolveFfmpeg, run, capture, probe };
