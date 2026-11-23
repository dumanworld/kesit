'use strict';
// Kesit — ffmpeg komutlarını kuran saf mantık (bilgi okuma, kesim planı, filtreler, hata metinleri).
// Hem Tauri ön yüzünde (tarayıcı) hem Node testlerinde çalışır; süreç başlatmaz.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('path'), require('./geometry'));
  else root.KesitCore = factory(root.KesitPath, root.KesitGeometry);
})(typeof self !== 'undefined' ? self : this, function (path, G) {
  const { videoFilter, videoChain, TONEMAP } = G;

  function normRot(deg) {
    let r = Math.round(deg / 90) * 90;
    r = ((r % 360) + 360) % 360;
    return r;
  }

  // `ffmpeg -hide_banner -i dosya` çıktısını çözümler.
  function parseProbe(text) {
    const info = {
      duration: 0, width: 0, height: 0, codedWidth: 0, codedHeight: 0,
      rotation: 0, fps: 30, sar: 1, hdr: false, hasVideo: false, hasAudio: false,
      videoCodec: '', audioCodec: '', format: ''
    };
    const fm = text.match(/Input #0, ([^,\s]+)/);
    if (fm) info.format = fm[1];
    const d = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (d) info.duration = (+d[1]) * 3600 + (+d[2]) * 60 + parseFloat(d[3]);

    const lines = text.split(/\r?\n/);
    let vIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      let m;
      if (!info.hasVideo && (m = l.match(/Stream #\d+:\d+.*?: Video: ([^\s,]+)(.*)$/))) {
        if (/\(attached pic\)/.test(l)) continue; // kapak resmi
        info.hasVideo = true;
        info.videoCodec = m[1];
        const rest = m[2];
        const s = rest.match(/\b(\d{2,5})x(\d{2,5})\b/);
        if (s) { info.codedWidth = +s[1]; info.codedHeight = +s[2]; }
        const f = rest.match(/(\d+(?:\.\d+)?)\s*fps/) || rest.match(/(\d+(?:\.\d+)?)\s*tbr/);
        if (f) {
          const v = parseFloat(f[1]);
          if (v >= 1 && v <= 240) info.fps = v;
        }
        const sar = rest.match(/SAR (\d+):(\d+)/);
        if (sar && +sar[1] > 0 && +sar[2] > 0) info.sar = (+sar[1]) / (+sar[2]);
        info.hdr = /arib-std-b67|smpte2084/.test(rest);
        vIdx = i;
      } else if (!info.hasAudio && (m = l.match(/Stream #\d+:\d+.*?: Audio: ([^\s,]+)/))) {
        info.hasAudio = true;
        info.audioCodec = m[1];
      }
    }

    if (vIdx >= 0) {
      for (let i = vIdx + 1; i < lines.length; i++) {
        if (/^\s*Stream #/.test(lines[i])) break;
        let m = lines[i].match(/rotation of (-?\d+(?:\.\d+)?) degrees/);
        if (m) { info.rotation = normRot(-parseFloat(m[1])); break; }
        m = lines[i].match(/^\s*rotate\s*:\s*(-?\d+(?:\.\d+)?)/);
        if (m) info.rotation = normRot(parseFloat(m[1]));
      }
    }

    const swap = info.rotation === 90 || info.rotation === 270;
    // ffmpeg varsayılan olarak döndürmeyi uygular; filtreler döndürülmüş kareyi görür.
    info.width = swap ? info.codedHeight : info.codedWidth;
    info.height = swap ? info.codedWidth : info.codedHeight;
    return info;
  }

  const fmt = (n) => (Math.max(0, n)).toFixed(3);

  const MOV_LIKE = new Set(['.mp4', '.mov', '.m4v', '.3gp']);

  function encodeArgs(withAudio, hdr) {
    const a = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p'];
    if (hdr) a.push('-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709');
    if (withAudio) a.push('-c:a', 'aac', '-b:a', '192k'); else a.push('-an');
    a.push('-movflags', '+faststart');
    return a;
  }

  const PROGRESS = ['-progress', 'pipe:1', '-nostats'];

  // Dışa aktarma planı: sırayla çalıştırılacak ffmpeg adımları.
  // opts: { input, output, info, start, end, mode: 'keep'|'remove', quality: 'precise'|'fast',
  //         crop: null|{x,y,w,h,ratio}, mute, resize, tmpDir }
  function buildExportPlan(opts) {
    const { input, output, info } = opts;
    const D = info.duration;
    const start = Math.max(0, Math.min(opts.start, D));
    const end = Math.max(start, Math.min(opts.end, D));
    const withAudio = info.hasAudio && !opts.mute;
    const needsEncode = !!opts.crop || !!opts.resize || !!opts.overlay;
    const quality = needsEncode ? 'precise' : opts.quality;
    const { vf, outW, outH } = videoFilter(opts);
    const EPS = 0.05;

    // Hangi parçalar kalacak?
    let segments;
    if (opts.mode === 'remove') {
      segments = [];
      if (start > EPS) segments.push([0, start]);
      if (D - end > EPS) segments.push([end, D]);
    } else {
      segments = [[start, end]];
    }
    segments = segments.filter(([a, b]) => b - a > 0.01);
    if (!segments.length) throw new Error('Çıktıda kalacak bir bölüm yok. Başlangıç ve bitişi kontrol et.');

    const outDuration = segments.reduce((s, [a, b]) => s + (b - a), 0);
    const ext = path.extname(output).toLowerCase();
    const movflags = MOV_LIKE.has(ext) ? ['-movflags', '+faststart'] : [];
    const mapA = withAudio ? ['-map', '0:a:0?'] : [];
    const steps = [];
    const tmpFiles = [];

    if (quality === 'precise') {
      if (segments.length === 1) {
        const [a, b] = segments[0];
        const args = ['-y', '-hide_banner', '-ss', fmt(a), '-i', input];
        if (opts.overlay) {
          args.push('-i', opts.overlay, '-t', fmt(b - a), '-filter_complex', overlayGraph('[0:v:0]', '[1:v]', opts), '-map', '[v]', ...mapA);
        } else {
          args.push('-t', fmt(b - a), '-map', '0:v:0', ...mapA);
          if (vf) args.push('-vf', vf);
        }
        args.push(...encodeArgs(withAudio, info.hdr), ...PROGRESS, output);
        steps.push({ args, duration: b - a, label: 'Kodlanıyor' });
      } else {
        const [[, a], [b]] = segments; // [0,a] ve [b,D]
        const args = ['-y', '-hide_banner', '-t', fmt(a), '-i', input, '-ss', fmt(b), '-i', input];
        if (opts.overlay) args.push('-i', opts.overlay);
        let fc = '[0:v:0]setpts=PTS-STARTPTS[v0];[1:v:0]setpts=PTS-STARTPTS[v1];';
        if (withAudio) {
          fc += '[0:a:0]asetpts=PTS-STARTPTS[a0];[1:a:0]asetpts=PTS-STARTPTS[a1];';
          fc += '[v0][a0][v1][a1]concat=n=2:v=1:a=1[vc][a];';
        } else {
          fc += '[v0][v1]concat=n=2:v=1:a=0[vc];';
        }
        fc += opts.overlay ? overlayGraph('[vc]', '[2:v]', opts) : `[vc]${vf || 'null'}[v]`;
        args.push('-filter_complex', fc, '-map', '[v]');
        if (withAudio) args.push('-map', '[a]');
        args.push(...encodeArgs(withAudio, info.hdr), ...PROGRESS, output);
        steps.push({ args, duration: outDuration, label: 'Kodlanıyor' });
      }
    } else {
      // Hızlı / kayıpsız: akış kopyalama
      const copyArgs = (a, b, out) => {
        const args = ['-y', '-hide_banner'];
        if (a > 0) args.push('-ss', fmt(a));
        args.push('-i', input, '-t', fmt(b - a), '-map', '0:v:0', ...mapA, '-c', 'copy');
        if (!withAudio) args.push('-an');
        args.push('-avoid_negative_ts', 'make_zero', ...(MOV_LIKE.has(path.extname(out).toLowerCase()) ? ['-movflags', '+faststart'] : []), ...PROGRESS, out);
        return args;
      };
      if (segments.length === 1) {
        const [a, b] = segments[0];
        steps.push({ args: copyArgs(a, b, output), duration: b - a, label: 'Kopyalanıyor' });
      } else {
        const tmpDir = opts.tmpDir;
        const parts = segments.map((_, i) => path.join(tmpDir, `parca${i + 1}${ext || '.mp4'}`));
        segments.forEach(([a, b], i) => {
          steps.push({ args: copyArgs(a, b, parts[i]), duration: b - a, label: `Parça ${i + 1}` });
        });
        const list = path.join(tmpDir, 'liste.txt');
        const listText = parts.map((p) => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n') + '\n';
        const args = ['-y', '-hide_banner', '-f', 'concat', '-safe', '0', '-i', list,
          '-map', '0:v:0', ...(withAudio ? ['-map', '0:a:0?'] : []), '-c', 'copy', ...(withAudio ? [] : ['-an']), ...movflags, ...PROGRESS, output];
        steps.push({ args, duration: outDuration, label: 'Birleştiriliyor', writeFile: { path: list, content: listText } });
        tmpFiles.push(...parts, list);
      }
    }
    return { steps, tmpFiles, outDuration, outW, outH, quality };
  }

  function frameArgs({ input, time, info, crop, output, overlay }) {
    const args = ['-y', '-hide_banner', '-ss', fmt(time), '-i', input];
    if (overlay) {
      args.push('-i', overlay, '-filter_complex', overlayGraph('[0:v:0]', '[1:v]', { info, crop, resize: false }), '-map', '[v]');
    } else {
      const { vf } = videoFilter({ info, crop, resize: false });
      if (vf) args.push('-vf', vf);
    }
    args.push('-frames:v', '1', '-update', '1', output);
    return args;
  }

  // [video] → (HDR dönüşümü) → çizim bindirmesi → (kırpma, ölçek) → [v]
  function overlayGraph(vin, oin, opts) {
    const { pre, post } = videoChain(opts);
    return `${vin}${pre || 'null'}[kb];[kb]${oin}overlay=0:0:format=auto[ko];[ko]${post || 'null'}[v]`;
  }

  function thumbArgs(input, time, height) {
    return ['-hide_banner', '-loglevel', 'error', '-ss', fmt(time), '-i', input, '-frames:v', '1',
      '-vf', `scale=-2:${height}`, '-q:v', '5', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1'];
  }

  function proxyArgs(input, output, info) {
    const args = ['-y', '-hide_banner', '-i', input, '-map', '0:v:0'];
    if (info.hasAudio) args.push('-map', '0:a:0?');
    // Uzun kenarı en fazla 1280 px olan hafif bir kopya.
    const scale = "scale='if(gte(iw,ih),min(1280,iw),-2)':'if(gte(iw,ih),-2,min(1280,ih))'";
    args.push('-vf', info.hdr ? `${TONEMAP},${scale}` : scale, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '26',
      '-pix_fmt', 'yuv420p', '-g', '12');
    if (info.hasAudio) args.push('-c:a', 'aac', '-b:a', '128k'); else args.push('-an');
    args.push('-movflags', '+faststart', ...PROGRESS, output);
    return args;
  }

  // ffmpeg'i çalıştırır; ilerlemeyi -progress çıktısından okur.
  function lastError(stderr) {
    const lines = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const errs = lines.filter((l) => /error|invalid|no such|not found|failed|could not|unable/i.test(l));
    return (errs.length ? errs[errs.length - 1] : lines[lines.length - 1] || '').slice(0, 300);
  }

  // Çıkış kodundan bağımsız olarak stderr/stdout toplar (bilgi okuma ve küçük resimler için).
  const FRIENDLY = [
    [/ENOSPC|No space left on device|There is not enough space/i,
      'Diskte yer kalmadı. Biraz yer açıp tekrar dene.'],
    [/EBUSY|being used by another process|resource busy|sharing violation/i,
      'Dosya başka bir programda açık. O programı kapatıp tekrar dene.'],
    [/EACCES|EPERM|Permission denied|Access is denied|Operation not permitted|read-only file system|EROFS/i,
      'Bu klasöre yazma izni yok. Farklı kaydet ile başka bir klasör seç.'],
    [/moov atom not found|Invalid data found when processing input|could not find codec parameters|End of file|corrupt/i,
      'Video dosyası bozuk ya da tamamen inmemiş görünüyor. Dosyayı yeniden indirip tekrar dene.'],
    [/ENOENT|No such file or directory|cannot find the (file|path)/i,
      'Dosya ya da klasör bulunamadı; taşınmış ya da silinmiş olabilir.'],
    [/Could not find tag for codec|not currently supported in container|codec not supported|incorrect codec parameters|Could not write header/i,
      'Video bu dosya biçiminde kaydedilemiyor. Farklı kaydet ile .mp4 olarak kaydet.'],
    [/does not contain any stream|Output file is empty|nothing was encoded/i,
      'Çıktıda kalacak görüntü yok. Başlangıç ve bitişi kontrol et.']
  ];
  function friendlyError(err) {
    const text = [err && err.code, err && err.message, err && err.stderr].filter(Boolean).join('\n');
    for (const [re, msg] of FRIENDLY) if (re.test(text)) return msg;
    // Zaten Türkçe olan kendi mesajlarımızı olduğu gibi bırak
    if (err && err.message && /[çğıöşüİ]/i.test(err.message)) return err.message;
    const detail = (err && err.message ? err.message : String(err || '')).slice(0, 140);
    return `Video işlenemedi. Başka bir dosyayla dene ya da Farklı kaydet ile .mp4 olarak kaydet.${detail ? ` (Ayrıntı: ${detail})` : ''}`;
  }


  return {
    parseProbe, buildExportPlan, frameArgs, thumbArgs, proxyArgs, lastError, friendlyError,
    probeError: (stderr) => /No such file|Invalid data found|could not find codec|Permission denied/i.test(stderr) && !/Duration:/.test(stderr)
  };
});
