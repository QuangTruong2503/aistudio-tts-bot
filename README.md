# Hướng dẫn sử dụng `aistudio-tts-bot`

Công cụ CLI tự động chuyển đổi hàng loạt file truyện `.txt` sang giọng nói bằng **Google AI Studio** (qua Chrome CDP), tự động chia đoạn mượt ở cuối đoạn văn, xoay vòng 5 model TTS khi chạm giới hạn, và tự động ghép & đăng lên CMS **PNTTAudio**.

---

## 1. Chuẩn bị trước khi chạy

### Bước 1: Mở Chrome chế độ Debug
```powershell
.\scripts\start-chrome.bat
```
*(Nếu cổng `9222` bị chiếm, truyền cổng khác: `.\scripts\start-chrome.bat 9223`)*

### Bước 2: Đăng nhập 1 lần trong cửa sổ Chrome Debug
1. Đăng nhập tài khoản Google trên tab `https://aistudio.google.com/generate-speech?model=gemini-3.8-flash-tts` và chọn sẵn giọng đọc / style mong muốn.
2. Mở thêm 1 tab tới trang CMS (`http://localhost:5173/admin/stories/59a33778-f5e0-4937-b3e8-b5ee46542872/chapters` hoặc `https://pnttaudio.netlify.app/...`) và đăng nhập tài khoản Quản trị viên (nếu dùng chế độ tự động đăng).
3. Chép các file `.txt` vào thư mục `input/`.

---

## 2. Tổng hợp các lệnh chạy `node src/index.js`

### Kiểm tra kết nối & selector (KHÔNG bấm Run)
```powershell
node src/index.js --inspect
```

### Chạy bình thường (tạo audio theo từng phần + tự động đăng trọn bộ mỗi chương lên CMS)
```powershell
# Chạy toàn bộ file trong input/ (tự bỏ qua chương/phần đã xong)
node src/index.js

# Chạy thử N chương đầu tiên (khuyên dùng khi mới test)
node src/index.js --limit 1
node src/index.js --limit 5
```

### Tùy chỉnh chia phần (mặc định đọc từ `config.js`, hiện là 8 phần/chương)
```powershell
# Chia mỗi file .txt thành 4 phần (_1.wav .. _4.wav)
node src/index.js --parts 4

# Chia 5 phần/chương
node src/index.js --parts 5

# Không chia nhỏ (tạo 1 file audio duy nhất cho cả chương)
node src/index.js --parts 1
```

### Chỉ định model TTS khởi đầu
*(Khi gặp giới hạn/quota, bot tự động xoay vòng qua 5 model: `gemini-3.8-flash-tts` → `gemini-3.8-flash-lite-tts` → `gemini-3.1-flash-tts-preview` → `gemini-2.5-pro-preview-tts` → `gemini-2.5-flash-preview-tts`)*
```powershell
node src/index.js --model gemini-3.8-flash-tts
node src/index.js --model gemini-3.8-flash-lite-tts
node src/index.js --model gemini-3.1-flash-tts-preview
node src/index.js --model gemini-2.5-pro-preview-tts
node src/index.js --model gemini-2.5-flash-preview-tts
```

### Điều khiển đăng lên CMS (Auto-Publish)
```powershell
# Chỉ tạo & tải audio về thư mục output/, KHÔNG đăng lên CMS
node src/index.js --no-publish

# Chỉ đăng các file audio có sẵn trong output/ lên CMS (không chạy lại TTS)
node src/index.js --publish-only

# Đăng lên bản web Netlify thay vì localhost
node src/index.js --publish-url https://pnttaudio.netlify.app/admin/stories/59a33778-f5e0-4937-b3e8-b5ee46542872/chapters
```

### Chạy lại file lỗi / chạy ép lại từ đầu
```powershell
# Chỉ chạy lại các chương từng bị lỗi trong logs/failed.json
node src/index.js --retry-failed

# Bắt buộc tạo lại & đăng lại kể cả chương đã có trong output/
node src/index.js --force --limit 1
```

### Tùy chỉnh thư mục & cổng CDP
```powershell
# Đổi thư mục input / output tùy ý
node src/index.js --input D:\truyen\txt --output D:\truyen\audio

# Kết nối tới Chrome Debug chạy ở cổng khác (ví dụ 9223)
node src/index.js --cdp http://127.0.0.1:9223
```

### Kết hợp nhiều cờ (ví dụ thực tế)
```powershell
# Chạy 3 chương, chia 4 phần/chương, bắt đầu từ flash-lite, tự đăng lên Netlify
node src/index.js --limit 3 --parts 4 --model gemini-3.8-flash-lite-tts --publish-url https://pnttaudio.netlify.app/admin/stories/59a33778-f5e0-4937-b3e8-b5ee46542872/chapters

# Chạy qua đêm chỉ tải audio về máy, chia 4 phần, không đăng CMS
node src/index.js --parts 4 --no-publish
```

### Xem trợ giúp nhanh
```powershell
node src/index.js --help
```

---

## 3. Dừng an toàn & Tiếp tục (Resume)
- Nhấn `Ctrl + C` 1 lần để dừng sạch sẽ (không tắt cửa sổ Chrome của bạn).
- Lần sau chỉ cần chạy lại `node src/index.js` — bot sẽ tự động bỏ qua các chương/phần đã hoàn tất và chạy tiếp đúng chỗ đang dở.
- Xem log chi tiết tại `logs/run.log`, danh sách lỗi tại `logs/failed.json`, và danh sách đã đăng tại `logs/published.json`.
