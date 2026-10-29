"""E2E: ra đề hàng loạt 45 câu (chạy nền) có thanh tiến độ. Chạy: python3 e2e/ai_bulk_e2e.py <base_url> [ảnh.png]"""
import sys
from playwright.sync_api import sync_playwright
base = sys.argv[1]
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(viewport={'width': 1280, 'height': 900}, locale='vi-VN', service_workers='block')
    errs = []; pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' and '401' not in m.text else None)
    pg.goto(base + '/#/register'); pg.wait_for_timeout(700)
    pg.select_option('#r-role', 'teacher'); pg.fill('#r-name', 'Co Lan'); pg.fill('#r-email', 'lan@example.com'); pg.fill('#r-pw', 'Correct-Horse-9'); pg.fill('#r-birth', '2001-07'); pg.check('#r-terms')
    pg.click('button[type=submit]'); pg.wait_for_timeout(1500)
    pg.goto(base + '/#/t/ai'); pg.wait_for_selector('#ai-on'); pg.check('#ai-on'); pg.wait_for_timeout(900)
    pg.goto(base + '/#/t/questions'); pg.wait_for_selector('[role=tablist]'); pg.click('text=AI Gemini ra đề theo yêu cầu'); pg.wait_for_selector('#qa-req')
    pg.fill('#qa-req', 'ra đề theo ngữ cảnh trình độ B2'); pg.fill('#qa-n', '45'); pg.select_option('#qa-lv', 'B2')
    pg.click('button:has-text("Tạo nháp")'); pg.wait_for_selector('progress', timeout=15000); print('progress bar shown')
    pg.wait_for_selector('.qcard', timeout=30000); print('first cards appear while running')
    pg.wait_for_selector('text=Hoàn tất', timeout=60000)
    c = pg.locator('.qcard').count(); k = pg.locator('.qtick').count(); print('cards:', c, 'answers:', k); assert c >= 40 and k == c
    pg.screenshot(path=sys.argv[2] if len(sys.argv) > 2 else '/tmp/bulk.png')
    pg.click('text=Mở ngân hàng câu hỏi để duyệt'); pg.wait_for_selector('tbody tr'); pg.wait_for_timeout(800)
    n = pg.locator('tbody tr').count(); print('rows:', n); assert n >= 40, n
    print('errs', errs); b.close()
