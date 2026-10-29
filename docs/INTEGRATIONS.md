# Tích hợp ngoài — trạng thái kiểm chứng
| Tích hợp | Trạng thái | Ghi chú |
|---|---|---|
| OpenAI chat.completions | **UNVERIFIED_API** | Viết theo tài liệu công khai; chỉ có contract-test bằng fixture. Tên model qua `AI_MODEL_OPENAI` |
| Anthropic messages | **UNVERIFIED_API** | Header `x-api-key`, `anthropic-version`; model qua `AI_MODEL_ANTHROPIC` |
| Gemini generateContent | **UNVERIFIED_API** | Khoá ở header `x-goog-api-key`; sinh: `AI_MODEL_GEMINI` (mặc định gemini-3.8-flash), kiểm: `AI_MODEL_GEMINI_VERIFY` (gemini-3.8-flash-lite); tắt “thinking” cho dòng flash để không cắt JSON |
| Streaming SSE của 3 nhà cung cấp | Chưa làm | Gateway trả một khối; luồng huỷ được chỉ kiểm với nhà cung cấp giả |
| LiveKit | Chưa cài | Giao diện MediaProvider sẵn; xem ADR-0012 |
| STUN/TURN | Cấu hình `ICE_SERVERS` (mặc định rỗng) | Mạng đối xứng/NAT chặt cần TURN |
| Email | Adapter console/memory/webhook | Chưa gửi thật |
Base URL cố định trong mã (không cho tổ chức tự nhập) để tránh SSRF.
