#!/usr/bin/env bash
set -euo pipefail

# Cho phép truyền cổng tùy chỉnh (mặc định 9222)
PORT="${1:-9222}"

# Thư mục profile riêng (KHÔNG dùng Default User Data vì Chrome mới chặn CDP trên profile mặc định)
PROFILE_DIR="${HOME}/.aistudio-tts-chrome-profile"
TARGET_URL="https://aistudio.google.com/generate-speech?model=gemini-3.8-flash-tts"

CHROME_BIN=""
if [[ "$OSTYPE" == "darwin"* ]]; then
  if [[ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]]; then
    CHROME_BIN="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  fi
else
  for candidate in google-chrome google-chrome-stable chromium chromium-browser; do
    if command -v "$candidate" >/dev/null 2>&1; then
      CHROME_BIN="$(command -v "$candidate")"
      break
    fi
  done
fi

if [[ -z "$CHROME_BIN" ]]; then
  echo "[ERROR] Không tìm thấy Google Chrome/Chromium. Vui lòng cài đặt hoặc chỉnh đường dẫn trong script." >&2
  exit 1
fi

mkdir -p "$PROFILE_DIR"

echo "[INFO] Đang khởi chạy Chrome Debug Mode..."
echo "[INFO] Port       : $PORT"
echo "[INFO] Profile    : $PROFILE_DIR"
echo "[INFO] Target URL : $TARGET_URL"

"$CHROME_BIN" \
  --remote-debugging-port="$PORT" \
  --user-data-dir="$PROFILE_DIR" \
  --no-first-run \
  --no-default-browser-check \
  "$TARGET_URL" >/dev/null 2>&1 &

echo "[OK] Chrome đã được mở ở nền (PID: $!)."
