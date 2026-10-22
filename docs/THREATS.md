# Mô hình đe doạ rút gọn (cập nhật cho v29)
| Đe doạ | Biện pháp | Kiểm |
|---|---|---|
| Người lớn tiếp cận trẻ trong đấu trường/phòng | joinCheck: cùng lớp hoặc liên kết giám hộ; người lớn được phép phải có mặt mới LIVE | test arena/rooms |
| Gian lận đáp án/điểm đấu trường | Máy chủ giữ đồng hồ và đáp án, append-only, điểm áp dụng lúc lộ đáp án | test forged fields, 30 đồng thời |
| Mã mời bị lộ | Mã băm, hết hạn, giới hạn dùng, thu hồi | test invites |
| Rò khoá AI (BYOK) | seal AES-GCM, chỉ key_hint, step-up, quét rò rỉ trong response/log/audit | test ai |
| Prompt injection qua nội dung | sanitizeText + bọc `<data>` + chỉ thị hệ thống; đầu ra phải qua lược đồ; AI chỉ tạo nháp | fixture có phiên bản |
| AI lộ đáp án cho thí sinh | Chặn gia sư khi attempt/arena đang mở; che từ đáp án trong gợi ý | test ai |
| Chi phí AI vượt kiểm soát | Ngân sách token theo tháng, hạn mức theo người dùng/ngày, cache, breaker | test ai |
| Mesh P2P lộ IP | Cảnh báo; dùng TURN relay khi triển khai thật | chưa kiểm |
| Chia sẻ màn hình làm lộ dữ liệu / trẻ phát màn hình | Chỉ người lớn có thẩm quyền; trình duyệt tự hỏi chọn cửa sổ; chủ phòng dừng được; tự dừng khi rời/bị đuổi/phòng kết thúc | test roomshare |
| Lạm dụng bảng (vẽ nội dung xấu, spam nét) | Mặc định chỉ GV vẽ; cấp quyền từng em, thu hồi được; không gõ chữ; giới hạn nét/payload/tốc độ; GV xoá trang | test roomshare |
