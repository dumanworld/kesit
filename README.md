# Kesit

Windows için hızlı video kesme ve kırpma uygulaması. Videoya sağ tıkla, "Kesit ile düzenle" de, başlangıcı ve bitişi işaretle, kenarlardan sürükleyerek kırp, Ctrl+S ile kaydet.

- Kesme: seçili kısmı tut ya da çıkar (kalan parçalar birleştirilir)
- Kırpma: serbest ya da 9:16, 4:5, 1:1, 16:9
- Çizim: ok, daire ve görsel (bilgisayardan, sürükle bırak ya da Ctrl+V; kırmızı çerçeveli yuvarlak)
- Kaydet orijinalin üzerine yazar ve geri alınabilir; Farklı kaydet yeni dosya açar
- Hassas mod (H.264 MP4, iPhone HDR'yi SDR'ye çevirir) ya da hızlı ve kayıpsız mod
- Sol üstte Dosya / Düzen / Görünüm / Yardım menüsü, geri al ve yinele düğmeleri (Ctrl+Z / Ctrl+Y)
- Kaydedilmemiş değişiklik varken başka dosya açınca ya da kapatınca sorar
- Düzenlenen videoyu panoya dosya olarak kopyalar (Ctrl+Shift+C)
- Kendini günceller

Kullanım ve kısayollar [BENIOKU.txt](BENIOKU.txt) dosyasında.

## İndirme

**[Son sürümü indir](https://github.com/dumanworld/kesit/releases/latest)**: `Kesit-…-kurulum.exe` (önerilen) ya da taşınabilir zip.

## Sürüm yayınlama

1. GitHub'da **Releases → Draft a new release** aç.
2. **Choose a tag** kutusuna bir öncekinden büyük sürümü üç parça halinde yaz, ör. `v1.2.0`. Uygulamanın sürüm numarası bu etiketten alınır; `v1` gibi eksik yazılırsa `src-tauri/tauri.conf.json`'daki numara kullanılır.
3. İstersen notları yaz ve **Publish release**'e bas.

Birkaç dakika içinde kurulum, zip ve `latest.json` sürüme eklenir. Kurulu Kesit'ler bir sonraki açılışta yeni sürümü görür.

Güncellemeler imzalıdır. İmza anahtarı repo ayarlarında `TAURI_SIGNING_PRIVATE_KEY` secret'ı olarak durur; açık anahtar `src-tauri/tauri.conf.json` içindedir. Anahtar kaybolursa kurulu uygulamalar yeni sürümleri kabul etmez, yedeğini sakla.

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
