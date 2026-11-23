Kesit ile gelen ffmpeg.exe hakkında

Bu ffmpeg.exe, yalnızca Kesit'in kullandığı bileşenlerle derlenmiş küçük bir FFmpeg
sürümüdür. GNU General Public License sürüm 2 (veya sonrası) ile dağıtılır; lisans
metni ffmpeg-LICENSE.txt dosyasındadır.

Kaynak kodlar:
  FFmpeg n6.1.2   https://github.com/FFmpeg/FFmpeg/tree/n6.1.2
  x264 (c24e06c)     https://github.com/mirror/x264/commit/c24e06c   (GPL v2+)
  zimg (9806db4)     https://github.com/sekrit-twc/zimg/commit/9806db4   (WTFPL)
  zlib             https://zlib.net   (zlib lisansı)

Derleme: x86_64-w64-mingw32 (GCC 13), statik. FFmpeg yapılandırması:

  --enable-gpl --enable-libx264 --enable-libzimg --enable-zlib --disable-everything
  --disable-autodetect --disable-network --disable-ffprobe --disable-ffplay
  çözücüler: h264 hevc prores mpeg4 mpeg1/2 vp8 vp9 mjpeg png dnxhd h263 vc1 wmv1-3
             msmpeg4v3 flv dvvideo aac mp2 mp3 ac3 eac3 opus vorbis flac alac wma dca pcm
  kodlayıcılar: libx264 aac png mjpeg
  filtreler: overlay crop scale setsar setpts concat format trim zscale tonemap
             transpose hflip vflip rotate aresample (ve temel yardımcılar)
  girişler: mov matroska avi mpegts mpegps flv asf mp3 wav concat image2 (çizim katmanı)

Kaynak kodun bir kopyasını istersen yukarıdaki bağlantılardan indirebilirsin.
