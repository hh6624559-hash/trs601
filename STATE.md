# STATE — TRS6 NEXT-GEN, đối chiếu Master Prompt v29 (cập nhật 2026-10-16)

## Đã có và đã kiểm chứng
- **Backend** (Node thuần + SQLite): ma trận phân quyền default-deny, phiên/CSRF, MFA, idempotency, rate limit, outbox, audit chuỗi băm,
  trigger DB cho máy trạng thái/append-only. `npm test`: **98/98 pass** (auth, FSRS, đánh giá, xã hội theo tuổi, riêng tư, i18n, thiết kế/tương phản,
  đấu trường, phòng học, AI, bootstrap/origin).
- **Giao diện v28** (tokens, thẻ giấy, sticker, mascot 6 trạng thái, tabbar/sidenav, kệ sách, PWA có toast “Cập nhật”): 28 cặp tương phản đạt; kiểm bằng Chromium.
- **Đấu trường (§8)**: máy trạng thái do máy chủ điều khiển, điểm thuần, ngắt kết nối 15s/bỏ cuộc 60s, tái lập theo seed, luật tuổi/lớp/giám hộ; E2E trình duyệt đạt.
- **Phòng học (§7)**: MediaProvider (P2P + Fake), phòng chờ, mời có mã băm/hết hạn, cam/mic mặc định tắt, chat soạn sẵn cho trẻ, báo cáo, dọn phòng ma; E2E đạt.
- **AI (§9)**: gateway fallback + breaker + retry, đầu ra có cấu trúc (sửa 1 lần), cache, ngân sách, BYOK mã hoá cột (step-up, chỉ lộ 4 ký tự cuối),
  khử định danh + lọc prompt-injection; AI chỉ tạo **nháp**, kiểm đáp án bằng model khác; gia sư bị chặn khi đang thi/đấu. **TẮT mặc định.**
- **Nhập từ vựng**: giáo viên dán/tải CSV-TSV (copy từ Excel), xem trước, nhập vào bộ từ của tổ chức (cô lập tenant), dùng được để giao bài và ra đề. E2E trình duyệt `e2e/vocab_ai_e2e.py` đạt với AI giả.
- **Soạn câu hỏi 2 chế độ** (Ngân hàng câu hỏi): ✍️ tự nhập, hoặc 🤖 AI ra đề theo yêu cầu tự do của giáo viên (vd «5 câu hiện tại hoàn thành, B1») — nháp, kiểm đáp án bằng model khác; E2E `e2e/ai_request_e2e.py` đạt với AI giả.
- **Học sinh & phụ huynh tự soạn đề luyện tập** (2 cách: tự nhập / AI ra đề theo yêu cầu): học sinh soạn cho mình (menu «Tự soạn đề»), phụ huynh soạn cho con (nút «Soạn đề cho con», kể cả con <13). AI hiện bản xem trước, người dùng xem lại/xóa câu rồi mới tạo; bài là luyện tập, không tính điểm chính thức; audit ghi người soạn. Học sinh <13 không tự gọi AI; 13–17 cần phụ huynh bấm «Cho phép gia sư AI». Chủ tổ chức (phụ huynh/học sinh người lớn) bật AI và nhập khoá ở «Cài đặt AI». E2E `e2e/practice_e2e.py` đạt (AI giả).
- **AI ra đề bằng Gemini**: sinh bằng `gemini-2.5-flash`, kiểm đáp án bằng `gemini-2.5-flash-lite` (model khác); chỉ tạo NHÁP; giáo viên xem đáp án ✓ rồi duyệt. Trang `Trợ lý AI`: bật AI, nhập khoá (step-up), hạn mức. Luồng kiểm bằng adapter Gemini giả trong test.
- v29: máy chủ không khoá mic theo pha; cờ `strictRoom` tuỳ chọn, giao diện báo trước khi vào trận.

## Chưa làm / chưa kiểm
- Học sinh/phụ huynh chưa có nhập danh sách từ vựng riêng (chỉ giáo viên); chưa có bài luyện tập dạng điền từ/ghép cặp do người dùng tự soạn (chỉ trắc nghiệm). (không tuyên bố hoàn tất)
- **Gemini chưa gọi thật lần nào** (sandbox chặn mạng); tên model `gemini-2.5-flash*` và định dạng request có thể cần chỉnh khi chạy thật (đặt `AI_MODEL_GEMINI`, `AI_MODEL_GEMINI_VERIFY`).
- **Adapter openai/anthropic/gemini là UNVERIFIED_API**: chỉ có contract-test bằng fixture, chưa gọi thật (sandbox chặn mạng). Eval AI: NOT CALIBRATED.
- **P2P mesh không phải SFU**: phòng ≥ ~12 người cần LiveKit (ADR-0012); quyền media chỉ do client thực thi.
- Đồng bộ thời gian thực bằng polling `seq`, không WebSocket/SSE (ADR-0011).
- Đấu trường chưa có: phòng media liên kết, chế độ đội, vòng nói, Elo; chính tả dạng chữ (chưa nghe). Chưa tạm dừng khi người lớn được phép rời phòng. Chưa test chuyển host; chưa test teen xem video ngang hàng (cờ `rooms.peer_minors` tắt).
- FSRS chưa đối chiếu vector tham chiếu; mascot là bản tạm; font không tải được nên dùng `local()`; chưa kiểm Safari/Firefox/thiết bị thật; chưa kiểm axe.
- PostgreSQL + RLS, chat thời gian thực nhóm, bản tin tuần, push: hoãn. Cần rà soát pháp lý/DPIA trước khi mở công khai (`docs/runbooks/child-safety.md`).
- Phòng học (S5+): **bảng trắng** (bút/bút dạ/tẩy, 6 màu, nhiều trang ≤20, hoàn tác, xuất PNG, GV cấp quyền vẽ từng em; không có gõ chữ tự do) và **chia sẻ màn hình** kiểu Meet (chỉ người lớn có thẩm quyền, 1 người/lần, luồng thứ ba trong mesh P2P). Migration 010, test `roomshare.test.js`, E2E `share_e2e.py`. Chưa có: nền ảnh/PDF slide, bảng nhiều người vẽ đồng thời >12, chia sẻ âm thanh hệ thống.
- Ra đề AI hàng loạt tới 1000 câu: chạy nền trong tiến trình máy chủ (`ai_jobs`), tiến độ + nút Dừng; mất khi khởi động lại; Gemini gói miễn phí giới hạn lượt/phút nên có thể mất hàng giờ.

## Việc tiếp theo gợi ý
1. Chạy thử với khoá AI thật ở môi trường có mạng, rồi hiệu chỉnh eval. 2. Gắn LiveKit nếu cần phòng lớn. 3. Rà soát pháp lý. 4. Duyệt ảnh giao diện.
