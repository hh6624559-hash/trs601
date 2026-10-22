# Lỗi đã biết / đã sửa
- Đã sửa: `normAnswer` dùng toLocaleLowerCase('vi') (P-05); SW không tự skipWaiting; Permissions-Policy cho cam/mic.
- Mở: phòng prejoin tạo 1 dòng console 404 dự kiến khi dò quyền; chưa kiểm Safari/Firefox.
- Mở: phòng media chỉ chặn quyền ở client trong P2P.
- Giáo viên chưa được duyệt thấy trang «chờ duyệt» (không còn «Có lỗi xảy ra»); DEMO_MODE tự duyệt cả tài khoản giáo viên đăng ký trước đó khi mở /me. Test bootstrap + E2E `pending_e2e.py`.
- AI: ô «Số câu» tự nhập 1–30 (chia lô 10 câu); lỗi nhà cung cấp AI hiện mã + thông điệp thật (đã che khoá).
- Gemini: tên model mặc định gemini-3.8-flash / gemini-3.8-flash-lite; nếu Google trả 404 (model bị gỡ) thì tự lấy danh sách model của khoá và dùng bản flash/flash-lite mới nhất (cache 6 giờ).
- Ra đề AI hàng loạt tới 1000 câu: >30 câu chạy nền (bảng ai_jobs, thanh tiến độ, nút Dừng); hạn mức AI mặc định 5.000.000 token/tháng, 3000 lượt/ngày (tối đa 100000).
