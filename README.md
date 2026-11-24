# Google AI Studio TTS Batch Automation (`aistudio-tts-bot`)

Công cụ CLI bằng **Node.js + `playwright-core`** kết nối vào **Google Chrome thật đã đăng nhập sẵn** qua Chrome DevTools Protocol (CDP) để tự động chuyển đổi hàng loạt file văn bản (`.txt`) sang giọng nói (`.wav` / `.mp3`) trên [Google AI Studio Speech Generation](https://aistudio.google.com/generate-speech?model=gemini-3.8-flash-tts).

## Tính năng chính
- **Gọn nhẹ:** Chỉ dùng `playwright-core`, không tải trình duyệt Chromium thừa.
- **Không tắt trình duyệt của bạn:** Khi chạy xong hoặc nhấn `Ctrl+C`, script chỉ ngắt kết nối CDP và giữ nguyên cửa sổ Chrome.
- **Sắp xếp tự nhiên & Resume thông minh:** Tự động sắp xếp `Chuong_2.txt` trước `Chuong_10.txt`, bỏ qua các file đã có sẵn trong `output/` (> 0 bytes) và ghi lại file lỗi vào `logs/failed.json`.
- **An toàn với tiếng Việt & thẻ `<tag>`:** Điền văn bản trực tiếp (không gõ từng ký tự) để tránh kẹt menu autocomplete khi văn bản chứa ký tự `<`.
- **Chống tải nhầm audio cũ:** Chụp snapshot trạng thái audio trước khi bấm `Run` và xác minh có audio mới trước khi tải.
- **Tải file đa chiến lược:** Ưu tiên nút Download chuẩn, tự động dự phòng sang tải trực tiếp từ thẻ `<audio>` (chunked base64 hỗ trợ file > 10MB) và tùy chọn Network Intercept.

---

## 1. Cài đặt

Yêu cầu **Node.js >= 18**.

```bash
npm install
```

*(Tùy chọn)* Sao chép `.env.example` thành `.env` nếu bạn muốn tùy chỉnh nhanh các biến môi trường.

---

## 2. Mở Chrome ở chế độ Debug & Đăng nhập 1 lần

Chrome bản mới **không cho phép** bật `--remote-debugging-port` trên thư mục profile mặc định. Script dưới đây sẽ mở Chrome với một profile riêng (`aistudio-tts-chrome-profile`) — bạn chỉ cần đăng nhập Google **một lần duy nhất**, các lần sau sẽ tự nhớ phiên đăng nhập.

- **Trên Windows:**
  ```bat
  scripts\start-chrome.bat
  ```
  *(Hoặc truyền cổng khác nếu 9222 đang bận: `scripts\start-chrome.bat 9223`)*

- **Trên macOS / Linux:**
  ```bash
  chmod +x scripts/start-chrome.sh
  ./scripts/start-chrome.sh
  ```
  *(Hoặc truyền cổng khác: `./scripts/start-chrome.sh 9223`)*

Sau khi cửa sổ Chrome mở lên:
1. Đăng nhập tài khoản Google của bạn.
2. Đảm bảo đang ở trang `https://aistudio.google.com/generate-speech?model=gemini-3.8-flash-tts`.
3. Chọn sẵn giọng đọc (`Speaker 1`), phong cách (`Friendly`, v.v.) và cấu hình mong muốn trên giao diện.

---

## 3. Kiểm tra Selector bằng `--inspect`

Trước khi chạy hàng loạt, hãy chạy lệnh kiểm tra để đảm bảo bot nhận diện đúng các thành phần trên giao diện AI Studio:

```bash
node src/index.js --inspect
```

Bot sẽ in ra trạng thái `[OK]` / `[MISSING]` của `promptInput`, `runButton`, `downloadButton` và **highlight viền đỏ trong 3 giây** ngay trên trình duyệt để bạn kiểm tra trực quan (KHÔNG bấm Run).

> **Mẹo:** Nếu `downloadButton` báo `MISSING`, hãy thử bấm Run thủ công 1 câu ngắn để thanh audio phía dưới hiện ra, sau đó chạy lại `--inspect`.

---

## 4. Chạy chuyển đổi hàng loạt (Batch)

1. Đặt các file `.txt` (mã hóa UTF-8) vào thư mục `input/` (ví dụ: `Chuong_001.txt`, `Chuong_002.txt`, ...).
2. Chạy lệnh:

```bash
# Chạy toàn bộ file trong input/ (tự động bỏ qua file đã có trong output/)
node src/index.js

# Chạy thử chỉ 2 file đầu tiên
node src/index.js --limit 2

# Tùy chỉnh số phần chia cho mỗi file .txt (mặc định chia 4 phần -> _1.wav .. _4.wav; đặt 1 để không chia)
node src/index.js --parts 4

# Chạy lại cả những file đã có sẵn trong output/
node src/index.js --force

# Chỉ chạy lại các file bị lỗi trong logs/failed.json
node src/index.js --retry-failed

# Chỉ định thư mục input/output tùy chỉnh
node src/index.js --input ./chapters --output ./audios

# Kết nối tới cổng CDP khác (ví dụ 9223)
node src/index.js --cdp http://127.0.0.1:9223

# Tắt tự động đăng lên CMS (chỉ tạo và tải audio về output/)
node src/index.js --no-publish

# Chỉ đăng các file audio đã có sẵn trong output/ lên CMS (không chạy lại TTS)
node src/index.js --publish-only

# Ghi đè URL trang quản trị chương CMS khác
node src/index.js --publish-url https://pnttaudio.netlify.app/admin/stories/<story-id>/chapters
```

> **Lưu ý khi dùng tự động đăng CMS:** Hãy đăng nhập tài khoản Quản trị viên trên trang `https://pnttaudio.netlify.app` **1 lần** ngay trong cửa sổ Chrome Debug (cổng 9222) để bot có quyền truy cập và tải lên tab **Tải lên hàng loạt (Bulk Upload)**. Trạng thái các chương đã đăng được lưu tại `logs/published.json`.

File âm thanh kết quả sẽ được lưu vào `output/` với tên khớp 100% file gốc (ví dụ `Chuong_001.txt` -> `Chuong_001.wav`).

Nhấn `Ctrl+C` bất cứ lúc nào để dừng an toàn. Lần chạy sau bot sẽ tự động bỏ qua các chương đã xong và tiếp tục từ chương còn thiếu.

---

## 5. Tùy chỉnh cấu hình (`config.js`)

Toàn bộ thông số thời gian và mảng selector dự phòng nằm trong `config.js`:
- `maxWaitAudioMs`: Thời gian chờ render tối đa cho mỗi file (mặc định `600000` ms = 10 phút).
- `minDelayMs` / `maxDelayMs`: Thời gian nghỉ ngẫu nhiên giữa các file (mặc định `5000`–`10000` ms).
- `maxRetries` / `retryBackoffMs`: Số lần thử lại khi gặp lỗi tạm thời (mặc định `2` lần, chờ `15s` rồi `45s`).
- `rateLimitCooldownMs`: Thời gian nghỉ khi gặp cảnh báo quota / rate limit (mặc định `60000` ms).
- `stopOnQuotaError`: Đặt `true` nếu muốn dừng toàn bộ batch ngay khi hết quota.
- `enableNetworkIntercept`: Đặt `true` nếu muốn bật chiến lược dự phòng 2 (bắt trực tiếp response audio từ mạng).
- `selectors`: Danh sách selector fallback cho `promptInput`, `runButton`, `stopButton`, `downloadButton`, `audioElement`, `durationLabel`, `errorToast`. Khi Google đổi DOM, bạn chỉ cần bổ sung selector mới vào đầu mảng tương ứng mà không cần sửa code xử lý.
