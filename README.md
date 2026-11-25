# AI Studio TTS Pro Studio (`aistudio-tts-bot`)

Hệ thống tự động hóa tạo truyện nói (TTS) thông minh nhất cho **Google AI Studio** + tự động ghép & đăng chương lên CMS **PNTTAudio**:
- **Giao diện Web Dashboard hiện đại (`http://localhost:3456`)** điều khiển trực quan & theo dõi tiến độ/log realtime.
- **Chạy 2 Tác vụ song song (x2 tốc độ)**: Hỗ trợ linh hoạt cả **2 Tab trên 1 Chrome** hoặc **2 Cửa sổ Chrome độc lập (cổng 9222 & 9223 cho 2 tài khoản Google)**.
- **2 Chế độ phân việc**: Gộp sức chạy chung 1 bộ truyện (tự chia chương) HOẶC chạy 2 bộ truyện độc lập hoàn toàn.
- **Tự động xoay vòng Model TTS & Chọn Giọng đọc cố định**: Xoay vòng sau mỗi chương và đổi ngay lập tức khi chạm giới hạn Quota; tự thoát màn hình Zero-State (`Create new dialog`) và chọn lại đúng giọng đọc cố định.
- **Khóa đồng bộ CMS (Publish Queue) & Tự động dọn file `.wav`**: Chống đè nhau khi 2 tác vụ đăng lên CMS cùng lúc, cấu hình Bitrate AAC (`48k/64k/96k/128k`) & nhịp nghỉ nối đoạn (`0s/0.4s/0.8s`), tùy chọn tự xóa file `.wav` sau khi đăng thành công để tiết kiệm ổ cứng mà vẫn nhớ lịch sử Resume.

---

## Cách 1: Sử dụng qua Giao diện Điều khiển (Khuyên dùng)

Chạy lệnh sau (hoặc nhấp đúp vào `scripts\start-dashboard.bat`):

```powershell
npm run ui
```

Trình duyệt sẽ tự động mở bảng điều khiển tại **`http://localhost:3456`**.

Trên giao diện, bạn có thể:
1. Bấm nút **Mở Chrome 1 (9222)** (và **Mở Chrome 2 (9223)** nếu muốn dùng tài khoản Google thứ 2 để nhân đôi Quota). Đăng nhập Google AI Studio + CMS 1 lần trên các cửa sổ đó.
2. Cấu hình số tác vụ (`1` hoặc `2`), danh sách ưu tiên Model TTS, Giọng đọc cố định, Số phần chia `.txt`, Thời gian chờ/nghỉ, và Cấu hình CMS.
3. Bấm **▶ Bắt đầu Chạy Tự động** và theo dõi trực tiếp từng tác vụ, đồng hồ đếm giây, ETA ước tính và log realtime.

---

## Cách 2: Sử dụng qua Dòng lệnh (CLI truyền thống)

Nếu bạn vẫn muốn chạy nhanh qua terminal không cần giao diện:

```powershell
# Mở Chrome Debug cổng 9222 (hoặc truyền 9223 cho profile thứ 2)
.\scripts\start-chrome.bat
.\scripts\start-chrome.bat 9223

# Kiểm tra selector trên tab AI Studio đang mở
node src/index.js --inspect

# Chạy toàn bộ file trong input/
node src/index.js

# Chạy thử N chương, chia 4 phần, chọn model khởi đầu
node src/index.js --limit 2 --parts 4 --model gemini-3.8-flash-lite-tts

# Chỉ tải audio (không đăng CMS) / Chỉ đăng file có sẵn trong output/
node src/index.js --no-publish
node src/index.js --publish-only

# Chạy lại các file bị lỗi trong logs/failed.json
node src/index.js --retry-failed
```
