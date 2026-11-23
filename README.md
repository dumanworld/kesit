# Kesit

Windows için hızlı video kesme ve kırpma uygulaması. Videoya sağ tıkla, "Kesit ile düzenle" de, başlangıcı ve bitişi işaretle, kenarlardan sürükleyerek kırp, Ctrl+S ile kaydet.

- Kesme: seçili kısmı tut ya da çıkar (kalan parçalar birleştirilir)
- Kırpma: serbest ya da 9:16, 4:5, 1:1, 16:9
- Çizim: ok, daire ve panodan yapıştırılan görsel (kırmızı çerçeveli yuvarlak)
- Kaydet orijinalin üzerine yazar ve geri alınabilir; Farklı kaydet yeni dosya açar
- Hassas mod (H.264 MP4, iPhone HDR'yi SDR'ye çevirir) ya da hızlı ve kayıpsız mod
- Ctrl+Z / Ctrl+Y ile düzenlemeleri geri al ve yinele

Kullanım ve kısayollar [BENIOKU.txt](BENIOKU.txt) dosyasında.

## İndirme

Her `main` push'unda GitHub Actions Windows sürümünü derler: **Actions → Windows → son çalıştırma → Artifacts → Kesit-Windows**. İçinde kurulum (`Kesit-…-kurulum.exe`) ve taşınabilir zip var.

Yeni sürüm yayınlamak için GitHub'da **Releases → Draft a new release** aç, bir etiket yaz (ör. `v2.0.1`) ve yayınla. Kurulum ve zip birkaç dakika içinde sürüme eklenir. `git tag v2.0.1 && git push origin v2.0.1` de aynı işi yapar.

## Yapı

[Tauri 2](https://tauri.app) üzerinde çalışır; arayüz Windows'taki WebView2'de açılır, video işlemleri paketle gelen küçük bir `ffmpeg.exe` ile yapılır.

```
src/                 arayüz (HTML, CSS, JS)
  renderer.js        ekran, zaman çizelgesi, kırpma, çizim, geri al
  ffcore.js          ffmpeg komutlarını kuran saf mantık (Node testleriyle ortak)
  geometry.js        kırpma ve çıktı boyutu hesapları
  bridge.js          window.kesit API'si: kaydetme, yedek, ilerleme, sürükle bırak
  pathx.js           Windows ve POSIX yolları için küçük yardımcı
src-tauri/
  src/lib.rs         ffmpeg çalıştırma/iptal, dosya işlemleri, pencereler, sağ tık menüsü
  bin/ffmpeg.exe     Kesit için derlenmiş küçük FFmpeg (GPL; bkz. ffmpeg-README.txt)
  windows/hooks.nsh  kaldırırken sağ tık menüsünü temizler
tests/               çekirdek testler, uçtan uca sınama ve örnek videolar
tools/               ffmpeg.exe derleme betiği
```

## Geliştirme

Gerekenler: Node 22, Rust (stable), ffmpeg (PATH'te). Linux'ta ayrıca Tauri'nin [sistem paketleri](https://tauri.app/start/prerequisites/).

```
npm install
npm run dev        # geliştirme sürümünü açar
npm test           # ffmpeg mantığı, gerçek videolarla (37 test)
npm run selftest   # Linux'ta uçtan uca sınama (xvfb + WebKitGTK)
npm run build      # Windows'ta kurulum dosyası üretir
```

Windows'ta uçtan uca sınama: `cd src-tauri && cargo build && cd .. && ./tests/run-selftest.ps1`. Bu sınama CI'da da her push'ta çalışır.

`ffmpeg.exe`'yi yeniden derlemek için: `tools/build-ffmpeg.sh` (Ubuntu 24.04, mingw-w64).
