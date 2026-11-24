'use strict';
// Çekirdek ffmpeg mantığını gerçek dosyalarla test eder.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const F = require('./helpers/ffnode');

const FF = process.env.KESIT_FFMPEG || 'ffmpeg';
const M = path.join(__dirname, 'media');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'kesit-test-'));

function ffprobe(file) {
  const j = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]).toString());
  const v = j.streams.find((s) => s.codec_type === 'video');
  const a = j.streams.find((s) => s.codec_type === 'audio');
  return { dur: parseFloat(j.format.duration), w: v && v.width, h: v && v.height, codec: v && v.codec_name, audio: !!a, side: v && v.side_data_list };
}

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ok  ', name); }
  catch (e) { fail++; console.log('  FAIL', name, '\n       ', e.message); }
}

(async () => {
  const land = await F.probe(FF, path.join(M, 'land.mp4'));
  const rot = await F.probe(FF, path.join(M, 'rot.mp4'));
  const hevc = await F.probe(FF, path.join(M, 'hevc.mp4'));
  const tr = path.join(M, "Çekim şık 'özel' #1.mov");
  const prores = await F.probe(FF, tr);
  const noa = await F.probe(FF, path.join(M, 'noaudio.mp4'));

  await t('probe: yatay', () => {
    assert.strictEqual(land.width, 1920); assert.strictEqual(land.height, 1080);
    assert.strictEqual(land.fps, 30); assert(Math.abs(land.duration - 10) < 0.05);
    assert(land.hasAudio); assert.strictEqual(land.rotation, 0);
  });
  await t('probe: döndürülmüş (90°) boyutları çevirir', () => {
    assert.strictEqual(rot.rotation, 270); assert.strictEqual(rot.width, 1080); assert.strictEqual(rot.height, 1920);
  });
  await t('probe: HEVC / ProRes / sessiz', () => {
    assert.strictEqual(hevc.videoCodec, 'hevc');
    assert.strictEqual(prores.videoCodec, 'prores'); assert.strictEqual(prores.width, 640);
    assert.strictEqual(noa.hasAudio, false); assert.strictEqual(noa.fps, 25);
  });
  await t('probe: eski "rotate:" etiketi ve -90 displaymatrix', () => {
    const a = F.parseProbe('  Duration: 00:00:05.00, start: 0\n  Stream #0:0(und): Video: h264 (High) (avc1 / 0x31637661), yuv420p, 1920x1080, 29.97 fps\n    Metadata:\n      rotate          : 90\n    Side data:\n      displaymatrix: rotation of -90.00 degrees\n  Stream #0:1(und): Audio: aac\n');
    assert.strictEqual(a.rotation, 90); assert.strictEqual(a.width, 1080); assert.strictEqual(a.fps, 29.97);
    const b = F.parseProbe('  Duration: 00:00:05.00\n  Stream #0:0: Video: mjpeg, yuvj420p, 600x600, 90k tbr (attached pic)\n  Stream #0:1: Video: h264, yuv420p, 640x360, 25 fps\n');
    assert.strictEqual(b.width, 640);
  });
  await t('probe: video olmayan dosyayı reddeder', async () => {
    const txt = path.join(OUT, 'x.txt'); fs.writeFileSync(txt, 'merhaba');
    await assert.rejects(F.probe(FF, txt));
  });
  await t('kırpma: 9:16 tam oran ve 1080x1920 ölçek', () => {
    const r = 9 / 16;
    const h = 1, w = r * 1080 / 1920; // yatay videoda en büyük 9:16
    const v = F.videoFilter({ info: land, crop: { x: (1 - w) / 2, y: 0, w, h, ratio: r }, resize: true });
    assert.match(v.vf, /^crop=608:1080:\d+:0/);
    // 608 < 1080 → ölçek yok
    assert.strictEqual(v.outW, 608);
    const v2 = F.videoFilter({ info: rot, crop: { x: 0, y: (1 - 1080 / 1920 * 16 / 9 * 9 / 16) / 2, w: 1, h: 1, ratio: r }, resize: true });
    assert.strictEqual(v2.outW, 1080); assert.strictEqual(v2.outH, 1920);
  });

  const run = async (name, opts, expect) => {
    await t(name, async () => {
      const tmpDir = fs.mkdtempSync(path.join(OUT, 'tmp-'));
      const plan = F.buildExportPlan({ tmpDir, ...opts });
      let last = 0;
      for (const s of plan.steps) {
        if (s.writeFile) fs.writeFileSync(s.writeFile.path, s.writeFile.content);
        await F.run(FF, s.args, { duration: s.duration, onProgress: (p) => { last = p; } });
      }
      const p = ffprobe(opts.output);
      if (expect.dur != null) assert(Math.abs(p.dur - expect.dur) <= (expect.tol || 0.12), `süre ${p.dur} beklenen ${expect.dur}`);
      if (expect.w) assert.strictEqual(p.w, expect.w, `genişlik ${p.w}`);
      if (expect.h) assert.strictEqual(p.h, expect.h, `yükseklik ${p.h}`);
      if (expect.audio != null) assert.strictEqual(p.audio, expect.audio, 'ses');
      if (expect.codec) assert.strictEqual(p.codec, expect.codec);
      if (expect.progress) assert(last > 0.9, `ilerleme ${last}`);
      assert(Math.abs(plan.outDuration - (expect.dur ?? plan.outDuration)) < 0.01 || expect.fastTol);
    });
  };
  const o = (n) => path.join(OUT, n);
  const L = path.join(M, 'land.mp4');

  await run('hassas: tut 2.5–7.0', { input: L, output: o('a.mp4'), info: land, start: 2.5, end: 7, mode: 'keep', quality: 'precise' }, { dur: 4.5, w: 1920, h: 1080, audio: true, codec: 'h264', progress: true });
  await run('hassas: çıkar 3–6 (iki parça birleşir)', { input: L, output: o('b.mp4'), info: land, start: 3, end: 6, mode: 'remove', quality: 'precise' }, { dur: 7, audio: true, progress: true });
  await run('hassas: üç parça (film şeridinden)', { input: L, output: o('b3.mp4'), info: land, segments: [[6, 7.5], [0.5, 2], [2, 3]], quality: 'precise' }, { dur: 4, audio: true });
  await run('hızlı: iki parça', { input: L, output: o('b4.mp4'), info: land, segments: [[0, 2], [5, 8]], quality: 'fast' }, { dur: 5, tol: 2.1, fastTol: true });
  await run('hassas: çıkar baştan (tek parça kalır)', { input: L, output: o('b2.mp4'), info: land, start: 0, end: 4, mode: 'remove', quality: 'precise' }, { dur: 6 });
  await run('hassas: 9:16 kırp + sesi kaldır', { input: L, output: o('c.mp4'), info: land, start: 1, end: 3, mode: 'keep', quality: 'precise', mute: true, crop: { x: 0.3, y: 0, w: 0.31640625, h: 1, ratio: 9 / 16 } }, { dur: 2, w: 608, h: 1080, audio: false });
  await run('hassas: çıkar + 4:5 kırp + 1080 ölçek', { input: L, output: o('d.mp4'), info: land, start: 2, end: 4, mode: 'remove', quality: 'precise', resize: true, crop: { x: 0.2, y: 0, w: 0.46875, h: 1, ratio: 4 / 5 } }, { dur: 8, w: 864, h: 1080, audio: true });
  await run('döndürülmüş: 1:1 kırp + ölçek → 1080x1080', { input: path.join(M, 'rot.mp4'), output: o('e.mp4'), info: rot, start: 0, end: 4, mode: 'keep', quality: 'precise', resize: true, crop: { x: 0, y: 0.2, w: 1, h: 1080 / 1920, ratio: 1 } }, { dur: 4, w: 1080, h: 1080 });
  await run('HEVC kaynak: hassas tut', { input: path.join(M, 'hevc.mp4'), output: o('f.mp4'), info: hevc, start: 1, end: 3, mode: 'keep', quality: 'precise' }, { dur: 2, codec: 'h264' });
  await run('ProRes + Türkçe/tırnaklı ad: hassas', { input: tr, output: o("çıktı 'özel' #1.mp4"), info: prores, start: 0.5, end: 2.5, mode: 'keep', quality: 'precise' }, { dur: 2, w: 640 });
  await run('sessiz kaynak: çıkar', { input: path.join(M, 'noaudio.mp4'), output: o('g.mp4'), info: noa, start: 1, end: 2, mode: 'remove', quality: 'precise' }, { dur: 4, audio: false });
  await run('hızlı: tut (kayıpsız)', { input: L, output: o('h.mp4'), info: land, start: 2, end: 6, mode: 'keep', quality: 'fast' }, { dur: 4, tol: 2.1, codec: 'h264', audio: true, fastTol: true });
  await run('hızlı: çıkar (parçala + birleştir)', { input: L, output: o('i.mp4'), info: land, start: 4, end: 6, mode: 'remove', quality: 'fast' }, { dur: 8, tol: 2.1, audio: true, fastTol: true });
  await run('hızlı: ProRes .mov çıkar, Türkçe ad', { input: tr, output: o("hızlı 'ş'.mov"), info: prores, start: 1, end: 2, mode: 'remove', quality: 'fast' }, { dur: 2, tol: 0.3, fastTol: true });
  await t('tamamı kalıyor ve yalnız ses kaldırılıyorsa yeniden kodlamaz', () => {
    const plan = F.buildExportPlan({ input: L, output: o('m.mp4'), info: land, segments: [[0, land.duration]], quality: 'precise', mute: true, tmpDir: OUT });
    assert.strictEqual(plan.quality, 'fast');
    assert(plan.steps[0].args.includes('copy'));
    // HDR (SDR'ye çevrilir) ya da ProRes kaynakta yine kodlanır
    const pr = F.buildExportPlan({ input: tr, output: o('m2.mp4'), info: prores, segments: [[0, prores.duration]], quality: 'precise', mute: true, tmpDir: OUT });
    assert.strictEqual(pr.quality, 'precise');
    const cut = F.buildExportPlan({ input: L, output: o('m3.mp4'), info: land, segments: [[1, land.duration]], quality: 'precise', mute: true, tmpDir: OUT });
    assert.strictEqual(cut.quality, 'precise');
  });
  await run('yalnız ses kaldır: kayıpsız kopya, süre tam', { input: L, output: o('m4.mp4'), info: land, segments: [[0, land.duration]], quality: 'precise', mute: true }, { dur: 10, w: 1920, h: 1080, audio: false, codec: 'h264' });
  await run('döndürülmüş, yalnız ses kaldır: kopya döndürmeyi korur', { input: path.join(M, 'rot.mp4'), output: o('m5.mp4'), info: rot, segments: [[0, rot.duration]], quality: 'precise', mute: true }, { audio: false });
  await t('kopyada döndürme bilgisi duruyor', () => {
    const side = ffprobe(o('m5.mp4')).side || [];
    assert(side.some((d) => Math.abs(d.rotation) === 90), JSON.stringify(side));
  });
  await run('hızlı istense de kırpma varsa hassasa geçer', { input: L, output: o('j.mp4'), info: land, start: 0, end: 2, mode: 'keep', quality: 'fast', crop: { x: 0, y: 0, w: 0.5625, h: 1, ratio: 1 } }, { dur: 2, w: 1080, h: 1080 });

  await t('kare: PNG + kırpma', async () => {
    const out = o('kare.png');
    await F.run(FF, F.frameArgs({ input: L, time: 3.2, info: land, crop: { x: 0.2, y: 0, w: 0.5625, h: 1, ratio: 1 }, output: out }));
    const p = ffprobe(out); assert.strictEqual(p.w, 1080); assert.strictEqual(p.h, 1080);
  });
  await t('küçük resim: JPEG baytları', async () => {
    const { stdout } = await F.capture(FF, F.thumbArgs(path.join(M, 'hevc.mp4'), 2, 72), { binary: true });
    assert(stdout.length > 1000 && stdout[0] === 0xff && stdout[1] === 0xd8);
  });
  await t('önizleme kopyası: HEVC → 720p H.264, döndürme uygulanmış', async () => {
    const out = o('proxy.mp4'); let last = 0;
    await F.run(FF, F.proxyArgs(path.join(M, 'rot.mp4'), out, rot), { duration: rot.duration, onProgress: (p) => (last = p) });
    const p = ffprobe(out); assert.strictEqual(p.w, 720); assert.strictEqual(p.h, 1280); assert(last > 0.9);
  });
  const hdr = await F.probe(FF, path.join(M, 'hdr_hlg.mov'));
  await t('probe: HDR (HLG) algılanır', () => { assert.strictEqual(hdr.hdr, true); assert.strictEqual(land.hdr, false); });
  await run('HDR: hassas → SDR bt709 H.264', { input: path.join(M, 'hdr_hlg.mov'), output: o('hdr.mp4'), info: hdr, start: 0.5, end: 2.5, mode: 'keep', quality: 'precise', crop: { x: 0.3, y: 0, w: 0.3, h: 1, ratio: 9 / 16 } }, { dur: 2, w: 608, h: 1080, codec: 'h264' });
  await t('HDR çıktı renk etiketi bt709', () => {
    const j = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=color_transfer,pix_fmt', '-of', 'json', o('hdr.mp4')]).toString());
    assert.strictEqual(j.streams[0].color_transfer, 'bt709'); assert.strictEqual(j.streams[0].pix_fmt, 'yuv420p');
  });
  await t('hata mesajları Türkçe ve yol gösterici', () => {
    const fe = F.friendlyError;
    assert.match(fe({ message: 'x', stderr: 'av_interleaved_write_frame(): No space left on device' }), /Diskte yer kalmadı/);
    assert.match(fe(Object.assign(new Error('EBUSY: resource busy or locked, rename'), { code: 'EBUSY' })), /başka bir programda açık/);
    assert.match(fe({ message: 'Error opening output file C:\\x.mp4', stderr: 'Permission denied' }), /yazma izni yok/);
    assert.match(fe({ message: 'x', stderr: 'moov atom not found' }), /bozuk/);
    assert.match(fe({ message: 'x', stderr: '/nope/x.mp4: No such file or directory' }), /bulunamadı/);
    assert.match(fe({ message: 'x', stderr: 'Could not find tag for codec h264 in stream #0' }), /\.mp4 olarak kaydet/);
    assert.strictEqual(fe(new Error('Çıktıda kalacak bir bölüm yok.')), 'Çıktıda kalacak bir bölüm yok.');
    assert.match(fe(new Error('weird internal failure')), /Video işlenemedi.*Ayrıntı: weird/);
  });
  await t('gerçek ffmpeg hatası: olmayan klasöre yazma', async () => {
    const err = await F.run(FF, ['-y', '-v', 'error', '-i', L, '-t', '0.2', '-c', 'copy', '/olmayan/klasor/x.mp4']).catch((e) => e);
    assert.match(F.friendlyError(err), /bulunamadı/);
  });
  // Çizim bindirmesi: kırmızı kutunun ortasındaki piksel çıktıda kırmızı olmalı
  const pixel = (file, x, y, t = 0.5) => {
    const buf = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', `crop=2:2:${x}:${y},format=rgb24`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
    return [buf[0], buf[1], buf[2]];
  };
  const isRed = ([r, g, b]) => r > 180 && g < 90 && b < 90;
  const OV = path.join(M, 'overlay.png');
  await run('bindirme: hassas tut', { input: L, output: o('ov1.mp4'), info: land, start: 1, end: 3, mode: 'keep', quality: 'fast', overlay: OV }, { dur: 2, w: 1920, h: 1080, codec: 'h264' });
  await t('bindirme: kırmızı kutu çıktıda (hızlı istense de hassasa geçer)', () => { assert(isRed(pixel(o('ov1.mp4'), 960, 540)), String(pixel(o('ov1.mp4'), 960, 540))); assert(!isRed(pixel(o('ov1.mp4'), 1700, 200))); });
  await run('bindirme + 9:16 kırp + çıkar', { input: L, output: o('ov2.mp4'), info: land, start: 3, end: 5, mode: 'remove', quality: 'precise', overlay: OV, crop: { x: (960 - 304) / 1920, y: 0, w: 0.31640625, h: 1, ratio: 9 / 16 } }, { dur: 8, w: 608, h: 1080 });
  await t('bindirme kırpmadan önce uygulanır (kutu kırpılmış karede doğru yerde)', () => { assert(isRed(pixel(o('ov2.mp4'), 960 - 656, 540)), String(pixel(o('ov2.mp4'), 304, 540))); });
  const hdrOv = await F.probe(FF, path.join(M, 'hdr_hlg.mov'));
  await run('bindirme + HDR (renk dönüşümünden sonra)', { input: path.join(M, 'hdr_hlg.mov'), output: o('ov3.mp4'), info: hdrOv, start: 0, end: 2, mode: 'keep', quality: 'precise', overlay: OV }, { dur: 2 });
  await t('HDR\'de kırmızı soluklaşmıyor', () => { assert(isRed(pixel(o('ov3.mp4'), 960, 540)), String(pixel(o('ov3.mp4'), 960, 540))); });
  await run('bindirme + döndürülmüş video', { input: path.join(M, 'rot.mp4'), output: o('ov4.mp4'), info: rot, start: 0, end: 2, mode: 'keep', quality: 'precise', overlay: path.join(M, 'overlay-rot.png') }, { dur: 2, w: 1080, h: 1920 });
  await t('döndürülmüş videoda kutu dik karede doğru yerde', () => { assert(isRed(pixel(o('ov4.mp4'), 540, 960))); });
  await t('kare: bindirmeli PNG', async () => {
    const out = o('kare-ov.png');
    await F.run(FF, F.frameArgs({ input: L, time: 1, info: land, crop: null, output: out, overlay: OV }));
    const buf = execFileSync('ffmpeg', ['-v', 'error', '-i', out, '-vf', 'crop=2:2:960:540,format=rgb24', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
    assert(isRed([buf[0], buf[1], buf[2]]));
  });
  await t('boş seçim hatası', () => {
    assert.throws(() => F.buildExportPlan({ input: L, output: o('z.mp4'), info: land, start: 0, end: 10, mode: 'remove', quality: 'precise' }), /kalacak/);
  });

  console.log(`\n${pass} geçti, ${fail} başarısız`);
  process.exit(fail ? 1 : 0);
})();
