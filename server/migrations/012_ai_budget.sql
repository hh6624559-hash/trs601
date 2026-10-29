-- 012: ngân sách token tháng mặc định 20.000.000 (ra đề hàng trăm câu). Chỉ nâng các tổ chức đang ở mức mặc định thấp hơn.
UPDATE ai_settings SET monthly_token_budget = 20000000 WHERE monthly_token_budget IN (200000, 5000000);
