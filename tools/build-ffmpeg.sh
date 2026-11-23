#!/usr/bin/env bash
# Kesit'in Windows için küçük ffmpeg.exe'sini Linux'ta (Ubuntu 24.04) çapraz derler.
# Çıktı: src-tauri/bin/ffmpeg.exe
#
# Gerekenler:
#   sudo apt install build-essential git nasm pkg-config autoconf automake libtool \
#        mingw-w64 libz-mingw-w64-dev
#
#   tools/build-ffmpeg.sh [çalışma klasörü]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${1:-$ROOT/.ffbuild}"
PREFIX="$WORK/prefix"
HOST=x86_64-w64-mingw32
JOBS="$(nproc)"

FFMPEG_TAG=n6.1.2
X264_COMMIT=c24e06c
ZIMG_COMMIT=9806db4

mkdir -p "$WORK" "$PREFIX"
cd "$WORK"
export PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig" PKG_CONFIG_LIBDIR="$PREFIX/lib/pkgconfig"

# --- x264 (GPL) ---
if [ ! -f "$PREFIX/lib/libx264.a" ]; then
  [ -d x264 ] || git clone https://github.com/mirror/x264.git
  (cd x264 && git checkout -q "$X264_COMMIT" &&
    ./configure --host=$HOST --cross-prefix=$HOST- --prefix="$PREFIX" --enable-static --disable-cli --disable-opencl &&
    make -j"$JOBS" && make install)
fi

# --- zimg (HDR → SDR renk dönüşümü için zscale) ---
if [ ! -f "$PREFIX/lib/libzimg.a" ]; then
  [ -d zimg ] || git clone https://github.com/sekrit-twc/zimg.git
  (cd zimg && git checkout -q "$ZIMG_COMMIT" && git submodule update --init --recursive &&
    ./autogen.sh && ./configure --host=$HOST --prefix="$PREFIX" --enable-static --disable-shared &&
    make -j"$JOBS" && make install)
fi

# --- FFmpeg: yalnızca Kesit'in kullandığı bileşenler ---
[ -d ffmpeg ] || git clone --depth 1 --branch "$FFMPEG_TAG" https://github.com/FFmpeg/FFmpeg.git ffmpeg
cd ffmpeg
./configure --prefix="$PREFIX" --arch=x86_64 --target-os=mingw32 --cross-prefix=$HOST- \
  --pkg-config=pkg-config --pkg-config-flags=--static \
  --enable-gpl --enable-libx264 --enable-libzimg --enable-zlib \
  --disable-everything --disable-autodetect --disable-doc --disable-debug \
  --disable-ffprobe --disable-ffplay --enable-ffmpeg --disable-network \
  --enable-decoder=h264,hevc,prores,mpeg4,mpeg2video,mpeg1video,vp8,vp9,mjpeg,png,dnxhd,h263,vc1,wmv1,wmv2,wmv3,msmpeg4v3,flv,dvvideo,aac,aac_latm,mp3float,mp2float,mp3,mp2,ac3,eac3,opus,vorbis,flac,alac,wmav1,wmav2,dca,pcm_s16le,pcm_s16be,pcm_s24le,pcm_s24be,pcm_s32le,pcm_s32be,pcm_f32le,pcm_u8,pcm_alaw,pcm_mulaw \
  --enable-encoder=libx264,aac,png,mjpeg \
  --enable-demuxer=mov,matroska,avi,mpegts,mpegps,mpegvideo,flv,asf,mp3,wav,concat,h264,hevc,image2,png_pipe \
  --enable-muxer=mp4,mov,ipod,tgp,matroska,webm,avi,mpegts,flv,asf,mpeg1system,mpeg2vob,image2,image2pipe,null \
  --enable-parser=h264,hevc,aac,aac_latm,mpegaudio,ac3,vp8,vp9,mpeg4video,mpegvideo,opus,vorbis,flac,mjpeg,png,dca,vc1,dvd_nav \
  --enable-bsf=h264_mp4toannexb,hevc_mp4toannexb,aac_adtstoasc,vp9_superframe,vp9_superframe_split,extract_extradata,mpeg4_unpack_bframes,null \
  --enable-filter=overlay,crop,scale,setsar,setpts,asetpts,concat,null,anull,format,aformat,zscale,tonemap,trim,atrim,aresample,transpose,hflip,vflip,rotate,buffer,buffersink,abuffer,abuffersink,split,asplit,copy,acopy \
  --enable-protocol=file,pipe \
  --extra-cflags="-I$PREFIX/include" --extra-ldflags="-L$PREFIX/lib -static" --extra-libs="-lstdc++"
make -j"$JOBS"
$HOST-strip ffmpeg.exe
cp ffmpeg.exe "$ROOT/src-tauri/bin/ffmpeg.exe"
ls -l "$ROOT/src-tauri/bin/ffmpeg.exe"
