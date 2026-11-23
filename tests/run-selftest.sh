#!/usr/bin/env bash
# Linux'ta debug sürümüyle uçtan uca sınama (xvfb + WebKitGTK). ffmpeg PATH'te olmalı.
#   tests/run-selftest.sh [medya klasörü]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MEDIA="${1:-$ROOT/tests/media}"
WORK="$(mktemp -d)"
SCRIPT="$WORK/.selftest.js"
trap 'rm -rf "$WORK"' EXIT
{
  printf 'const MEDIA = %s;\nconst WORK = %s;\n' "$(printf '%s' "$MEDIA" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')" \
    "$(printf '%s' "$WORK" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')"
  cat "$ROOT/tests/selftest.js"
} > "$SCRIPT"
cd "$ROOT/src-tauri"
cargo build --quiet
export KESIT_SELFTEST="$SCRIPT" KESIT_FFMPEG="${KESIT_FFMPEG:-$(command -v ffmpeg)}"
export XDG_CONFIG_HOME="$WORK/.config"
timeout 240 xvfb-run -a -s "-screen 0 1440x900x24" ./target/debug/kesit
