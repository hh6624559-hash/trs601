# Quyết định kiến trúc (ADR) — ghi nhận các chỗ KHÁC Master Prompt

| # | Quyết định | Lý do | Hệ quả / việc còn lại |
|---|---|---|---|
| 0001 | SQLite (WAL) thay PostgreSQL | Môi trường dựng không cài được gói; node:sqlite có sẵn, triển khai 1 file | Một tiến trình; RLS chưa có → cô lập tenant ở tầng ứng dụng (khóa ngoại kép + test IDOR). Chuyển Postgres + RLS: việc tiếp theo |
| 0002 | Node thuần, không Fastify/Next/Zod | Registry npm bị chặn | Router, validator (`s.*`), CSP tự viết và có test |
| 0003 | scrypt (N=2^15) thay Argon2id | Argon2 không có trong lõi Node | Có thể đổi khi có thư viện; hash có tiền tố phiên bản |
| 0004 | CSP không nonce, frontend không inline script/style | Đơn giản, chặt hơn | DOM dựng bằng CSSOM/`h()`, test chặn innerHTML/style attr |
| 0005 | FSRS-4.5 trọng số mặc định | Chưa có vector tham chiếu | **CHƯA đối chiếu vector chính thức** (cần trước khi tuyên bố tuân thủ). Game không đổi lịch (trọng số 0) |
| 0006 | PRNG mulberry32/xmur3 cho dựng đề | Cần tái lập theo seed (DI-017) | Test cùng seed → cùng đề |
| 0007 | Chỉ người lớn tự đăng ký; trẻ do GV/PH tạo, đăng nhập bằng mã lớp+username+PIN | Child-safety, COPPA/NĐ13 | Cần rà soát pháp lý trước khi mở công khai |
| 0008 | Văn bản tự do <18 tuổi TẮT mặc định; <13 chỉ tin soạn sẵn | D4 | Bật 13–17 bằng FREE_TEXT_TEEN |
| 0009 | Video = liên kết ngoài + webhook ký | Không tự lưu video | Tích hợp nhà cung cấp thật hoãn |
| 0010 | Email qua adapter console/memory/webhook | Không có SMTP | Cần cấu hình dịch vụ email để gửi thật |
| 0011 | Đồng bộ thời gian thực bằng bảng sự kiện `seq` + polling ngắn (1s đấu trường, 800ms phòng), resume `?after=seq` | Không có thư viện WebSocket; node thuần; polling đơn giản, chịu mất kết nối | Tải cao hơn WS; chuyển SSE/WS khi cần, giữ nguyên giao thức `seq` |
| 0012 | MediaProvider có P2P + Fake; chưa LiveKit | Không cài được SDK/không có máy chủ SFU | Mesh tối đa 12 peer, UI phân trang 9 ô; phòng 30 người cần LiveKit. Quyền media chỉ client thực thi trong P2P |
| 0013 | AI gateway bằng `fetch`, không SDK; adapter là UNVERIFIED_API | Registry bị chặn, mạng ra ngoài bị chặn | Phải chạy thử với khoá thật trước khi bật `ai.gateway`; tên model cấu hình qua env |
| 0014 | AI chỉ tạo nháp; người duyệt xuất bản; đáp án kiểm bằng model/nhà cung cấp khác | DI-012, giảm lỗi một mô hình | Chi phí gấp đôi mỗi câu; từ chối khi không có model thứ hai |
| 0015 | Phông chữ dùng `local()` + font hệ thống | Không tải được file font | Cần tự host font tiếng Việt khi có mạng |
| 0016 | v29: không khoá mic theo pha ở máy chủ; `strictRoom` tuỳ chọn | Prompt v29 | Khoá chỉ trong ROUND_OPEN khi chủ trì bật, UI báo trước |
| 0017 | Bảng trắng lưu nét chuẩn hoá 0–1 trong `room_board_strokes`, đồng bộ qua sự kiện phòng; chia sẻ màn hình = track thứ ba trong mesh, trạng thái ở `rooms.screen_*` | Không WebSocket/SFU; cần người vào sau thấy lại bảng | Trễ ~0,4–0,8s; trần 3000 nét/phòng, 20 trang; chia sẻ màn hình chỉ người lớn (child-safety) |
