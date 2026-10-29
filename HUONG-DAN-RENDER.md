# Hướng dẫn đưa lên Render (bản chạy thử, gói free)

Folder này đã có sẵn file `.env` (nằm trong `trs6/`, tên bắt đầu bằng dấu chấm; Windows có thể ẩn — bật *View → Hidden items*)
và bản sao `render-import.env` để dễ thấy.

1. Đẩy toàn bộ folder `trs6` lên GitHub (repo của bạn). `.gitignore` đã chặn `.env` để không lộ `APP_SECRET`.
2. Render → New → Web Service → chọn repo, Runtime = **Docker**, gói Free.
3. Vào **Environment** → **Edit** → **Add from .env** → dán nội dung `render-import.env` → **Save, rebuild and deploy**.
   - Nếu địa chỉ web của bạn khác `https://thi-fe.onrender.com` thì sửa `PUBLIC_ORIGIN` cho đúng (có `https://`, không có `/` cuối).
4. Mở `https://<địa-chỉ>/readyz` → thấy OK là server chạy. Mở trang chính, **Tạo tài khoản** → vai trò *Giáo viên*.
   Nhờ `AUTO_APPROVE` (mặc định bật ở production) mọi tài khoản được duyệt ngay, không cần email.

## Lưu ý
- Gói free **không có đĩa**: dữ liệu mất khi service khởi động lại/ngủ đông. Chỉ để xem thử.
- `DEMO_MODE=true` chỉ để chạy thử. Muốn duyệt thủ công: đặt `AUTO_APPROVE=false` và `DEMO_MODE=false`. Khi dùng thật: gói trả phí + đĩa gắn `/data`, `DATABASE_PATH=/data/trs6.sqlite`,
  `DEMO_MODE=false`, tạo quản trị bằng `BOOTSTRAP_ADMIN_EMAIL` + `BOOTSTRAP_ADMIN_PASSWORD` (hoặc `npm run create-admin` nếu có Shell).
- Tính năng AI tắt mặc định và chưa kiểm chứng với dịch vụ thật (xem `docs/INTEGRATIONS.md`).
- Chạy trên máy: `npm start` (Node ≥ 22.13), xem `README.md`.

## Dùng bảng và chia sẻ màn hình trong phòng học
- Giáo viên vào phòng lớp → nhấn **Chia sẻ màn hình** (chọn cửa sổ/tab bài giảng) hoặc **Mở bảng** để viết/vẽ. Học sinh tự thấy ngay.
- Muốn cho học sinh vẽ: ở danh sách Thành viên bấm nút ✏️ cạnh tên em đó.
- Cần trình duyệt Chrome/Edge/Firefox bản máy tính để chia sẻ màn hình (điện thoại thường không chia sẻ được, nhưng xem thì được).
