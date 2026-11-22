# Antigravity Theme Studio

Hệ thống tùy biến giao diện **Live Video / Image / Gradient Wallpaper + Boot HUD + Task Complete Audio** đồng bộ cho cả 3 ứng dụng:
- **Antigravity** (cổng CDP `9222`)
- **Antigravity IDE** (cổng CDP `9223`)
- **Visual Studio Code** (cổng CDP `9224`)

Hoạt động hoàn toàn qua Chrome DevTools Protocol (CDP), **không can thiệp vào tệp cài đặt gốc (`app.asar`)** và **không làm bẩn `settings.json`**.

## Tính năng tích hợp

- **Hỗ trợ đồng bộ đa ứng dụng (Antigravity + Antigravity IDE + VS Code):**
  - Tự động làm trong suốt Workbench, Explorer, Editor, Welcome Page và đồng bộ tọa độ ảnh nền **1:1 xuyên qua khung chat `extensionView` bên phải** ở mọi kích thước cửa sổ và mức zoom.
- **Video nền động & Ảnh nền độ phân giải cao:**
  - Phát video qua HTTP Media Server nội bộ hỗ trợ `Range 206` (tự động `pause()` khi bạn chuyển sang ứng dụng khác hoặc thu nhỏ cửa sổ để tiết kiệm GPU/pin, tự động `play()` khi quay lại).
  - Tự động mã hóa `data:` URI cho ảnh nền (và video `.webm` ≤ 25MB) trên IDE / VS Code để vượt qua giới hạn CSP của `vscode-file://`.
- **In-App Theme Studio (nút `Theme Studio` trên Sidebar / Status Bar hoặc phím tắt `Ctrl + Shift + T`):**
  - Chuyển đổi giữa **Video động / Ảnh tĩnh / Gradient** và 4 preset sẵn có (`Dark Glass Live`, `Neon Cyberpunk`, `Midnight Obsidian`, `Frost Light`).
  - Có **Thumbnail xem trước** cho cả Video và Ảnh tĩnh, tùy chỉnh **Object Position** (Căn trên / giữa / dưới), **Dim Overlay**, **Pre-baked Glass Blur** (0 live blur — cuộn mượt 60–120 FPS), **Accent Color Override**, kiểu bong bóng chat, khung Composer và **User/Agent Avatar** (tự nén WebP 192×192).
  - Hỗ trợ **Xuất / Nhập file cấu hình JSON** và **Đặt lại mặc định** (xác nhận 2 bước chống bấm nhầm).
  - Upload trực tiếp Video, Ảnh, Âm thanh theo luồng (**Stream Upload + Stream MD5** tới 150MB, không ngốn RAM) và xóa trực tiếp khỏi ổ đĩa.
- **Task Complete Sound & Boot HUD Audio:**
  - Phát âm báo khi Agent hoàn thành tác vụ (chống kêu trùng lặp khi mở nhiều cửa sổ cùng lúc, tự bỏ qua khi bạn bấm hủy).
  - Màn hình khởi động **Boot HUD** đi kèm âm thanh **Sci-Fi Glass Synth** (hoặc tải file âm thanh khởi động riêng), chỉ phát 1 lần mỗi phiên mở cửa sổ.

---

## Hướng dẫn chạy nhanh (Windows)

```powershell
cd D:\Projects\antigravity-theme-studio

# 1. Biên dịch gói giao diện (dist/bundle.js)
npm run build

# 2. Cài đặt daemon chạy ngầm (tự khởi động cùng Windows & tự gắn cờ CDP vào shortcut của cả 3 app)
npm run install-win

# 3. Mở ứng dụng kèm cổng CDP (hoặc mở trực tiếp từ Start Menu / Taskbar)
npm run launch          # Mở Antigravity (port 9222)
npm run launch-ide      # Mở Antigravity IDE (port 9223)
npm run launch-vscode   # Mở Visual Studio Code (port 9224)

# 4. Kiểm tra trạng thái hoạt động
npm run verify
```

> **Mẹo:** Nếu một trong các ứng dụng đang mở sẵn mà chưa có cổng CDP, bạn có thể thêm cờ `-- -Restart` để tự động khởi động lại ứng dụng đó với cổng CDP (ví dụ: `npm run launch-ide -- -Restart` hoặc `npm run launch-vscode -- -Restart`).

## Gỡ cài đặt hoàn toàn

```powershell
npm run uninstall
```
*(Lệnh trên sẽ dừng daemon, xóa lối tắt Windows Startup, gỡ cờ `--remote-debugging-port` khỏi các shortcut và khôi phục ngay giao diện gốc trên tất cả cửa sổ đang mở).*
