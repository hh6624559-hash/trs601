# TRS6 NEXT-GEN (Master Prompt v29) — nền tảng học từ vựng tiếng Anh (backend + frontend + database)

Ứng dụng web hoàn chỉnh theo Master Prompt v29: ôn tập lặp lại ngắt quãng (FSRS), kho từ cá nhân, lớp học/giao bài/kiểm tra,
trò chơi, xã hội an toàn theo độ tuổi, giám hộ, riêng tư (xuất/xóa dữ liệu), quản trị/kiểm duyệt, ngoại tuyến (PWA).
**Không có phụ thuộc ngoài**: chỉ Node ≥ 22.13 (node:http, node:sqlite, node:crypto). Không `npm install`.

## Chạy thử tại máy
```bash
export APP_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")
npm start            # http://localhost:8080  (DB ./data/trs6.sqlite, tự migrate + nạp 203 từ gốc CC0)
npm test             # 85 test (backend, i18n, CSP, đấu trường, phòng học, AI)
```
Tạo quản trị đầu tiên (không có tài khoản mặc định; bắt buộc bật MFA ở lần đăng nhập đầu):
```bash
ADMIN_EMAIL=ban@example.com ADMIN_PASSWORD='mat-khau-dai-≥10-ky-tu' npm run create-admin
```

## Triển khai lên Internet
Cần một máy chủ **một tiến trình** có **đĩa bền vững** gắn vào `/data` (SQLite) và HTTPS ở phía trước.
1. **Docker/VPS**: `cp .env.example .env`, điền `APP_SECRET` và `PUBLIC_ORIGIN=https://tên-miền`, rồi `docker compose up -d --build`.
   Đặt Caddy/nginx làm reverse proxy HTTPS → cổng 8080 (đã bật `TRUST_PROXY` ở production).
2. **Fly.io**: sửa `fly.toml`, `fly volumes create trs6_data --size 1`, `fly secrets set APP_SECRET=...`, `fly deploy`.
3. **Render**: dùng `render.yaml` (gói có đĩa), điền `PUBLIC_ORIGIN`.
4. Sau khi lên: chạy `create-admin` (Fly: `fly ssh console -C "npm run create-admin"` với biến môi trường), đăng nhập, bật MFA.
5. Email: `EMAIL_MODE=console` chỉ in thư (kể cả liên kết xác minh) ra log — để gửi thật đặt `EMAIL_MODE=webhook` + `EMAIL_WEBHOOK_URL`.
6. Sao lưu: sao chép `/data/trs6.sqlite` (an toàn dùng `sqlite3 .backup`); kiểm tra `/healthz`, `/readyz`.

Production **từ chối khởi động** nếu thiếu `APP_SECRET` (≥32 ký tự) hoặc `PUBLIC_ORIGIN`.

## Biến môi trường mới
`MEDIA_PROVIDER` (p2p|fake), `ICE_SERVERS` (JSON STUN/TURN), `ROOM_MAX_PEOPLE`, `MEDIA_WEBHOOK_SECRET`;
AI (đặt `AI_GATEWAY=true` để bật cờ, rồi bật trong trang «Trợ lý AI»): `GEMINI_API_KEY` (hoặc nhập khoá trên trang), `AI_MODEL_GEMINI`, `AI_MODEL_GEMINI_VERIFY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `AI_MODEL_*`, `AI_PROVIDER=fake` (demo).
Adapter AI chưa kiểm chứng với dịch vụ thật — xem `docs/INTEGRATIONS.md`.

## Chạy thử nhanh trên Render (gói free)
Tạo Blueprint từ repo (dùng `render.yaml`): `APP_SECRET` tự sinh, `PUBLIC_ORIGIN` tự lấy từ Render, `DEMO_MODE=true` tự duyệt giáo viên.
Gói free không có đĩa → dữ liệu mất khi khởi động lại. Dùng thật: gói trả phí + đĩa `/data` + `DEMO_MODE=false`
(+ `BOOTSTRAP_ADMIN_EMAIL`/`BOOTSTRAP_ADMIN_PASSWORD` để tạo quản trị khi không có Shell).

## Cấu trúc
`server/` (lib, modules, migrations, jobs) · `public/` (SPA ES modules, i18n vi/en, service worker) · `test/` · `e2e/` (kiểm thử trình duyệt Playwright) · `docs/DECISIONS/` · `STATE.md`.

Xem `STATE.md` để biết chính xác cái gì đã chạy/kiểm chứng và cái gì còn hoãn.
