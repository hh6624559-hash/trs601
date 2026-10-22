"""E2E: Ngân hàng câu hỏi có 2 chế độ (tự nhập / AI ra đề theo yêu cầu). Chạy: python3 e2e/ai_request_e2e.py <base_url> [ảnh.png]"""
import sys
from playwright.sync_api import sync_playwright
base = sys.argv[1]
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(viewport={'width': 1280, 'height': 900}, locale='vi-VN')
    errs = []; pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' and '401' not in m.text else None)
    pg.goto(base + '/#/register'); pg.wait_for_timeout(700)
    pg.select_option('#r-role', 'teacher'); pg.fill('#r-name', 'Co Lan'); pg.fill('#r-email', 'lan@example.com'); pg.fill('#r-pw', 'Correct-Horse-9'); pg.fill('#r-birth', '2001-07'); pg.check('#r-terms')
    pg.click('button[type=submit]'); pg.wait_for_timeout(1500)
    pg.goto(base + '/#/t/questions'); pg.wait_for_selector('[role=tablist]')
    print('TABS:', pg.inner_text('[role=tablist]').replace('\n', ' | '))
    print('MANUAL form shown:', pg.locator('#qn-s').count() == 1)
    # thủ công: tạo 1 câu
    pg.fill('#qn-s', 'Capital of France?'); pg.fill('#qn-o', 'Paris\nRome\nMadrid'); pg.fill('#qn-a', '1'); pg.click('button:has-text("Tạo")'); pg.wait_for_selector('text=Capital of France?')
    print('MANUAL created OK')
    # AI: chưa bật -> báo, nút tạo bị khóa
    pg.click('text=AI Gemini ra đề theo yêu cầu'); pg.wait_for_selector('#qa-req')
    print('AI not ready note:', 'Cần bật AI' in pg.inner_text('main'), '| button disabled:', pg.locator('button:has-text("Tạo nháp")').is_disabled())
    pg.goto(base + '/#/t/ai'); pg.wait_for_selector('#ai-on'); pg.check('#ai-on'); pg.wait_for_timeout(900)
    pg.goto(base + '/#/t/questions'); pg.wait_for_selector('[role=tablist]'); pg.wait_for_selector('#qa-req')   # nhớ chế độ AI
    pg.fill('#qa-req', '5 câu về thì hiện tại hoàn thành, since và for'); pg.fill('#qa-n', '3'); pg.select_option('#qa-lv', 'B1')
    pg.click('button:has-text("Tạo nháp")'); pg.wait_for_selector('text=Nháp', timeout=20000); pg.wait_for_timeout(800)
    print('AI drafts:', pg.locator('tbody tr').count(), 'rows; AI badges:', pg.locator('tbody .badge.warn').count())
    pg.screenshot(path=sys.argv[2] if len(sys.argv) > 2 else '/tmp/q2.png', full_page=True)
    print('errs', errs); b.close()
