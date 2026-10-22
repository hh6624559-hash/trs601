# Runbook an toàn trẻ em
1. **Báo cáo** (bảng `reports`, có bằng chứng): kiểm duyệt viên xử lý trong `/admin/moderation`; leo thang → khoá phòng/tài khoản.
2. **Khẩn cấp trong phòng**: chủ phòng `kick`/`lock`/`end`; nền tảng có thể `end` phòng qua kiểm duyệt.
3. **Cờ pháp lý**: `rooms.peer_minors` (phòng ngang hàng cho <18) và `ai.gateway` mặc định TẮT; chỉ bật sau rà soát pháp lý/DPIA.
4. **AI với trẻ**: <13 bị chặn; 13–17 cần đồng ý `ai_tutor` của giám hộ; dữ liệu khử định danh trước khi gửi; chặn khi đang thi.
5. **Xoá dữ liệu**: theo `/me/delete`, giám hộ xoá cho con; log/audit chỉ lưu ID, không PII.
6. Liên hệ cơ quan chức năng theo quy định địa phương khi có nghi ngờ xâm hại — việc này nằm ngoài hệ thống, do chủ vận hành thực hiện.
