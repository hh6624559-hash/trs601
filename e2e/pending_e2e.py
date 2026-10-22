"""E2E: giáo viên mới (không bật DEMO_MODE) thấy trang «chờ duyệt», KHÔNG phải «Có lỗi xảy ra». Chạy: python3 e2e/pending_e2e.py <base_url>"""
import sys
from playwright.sync_api import sync_playwright
base = sys.argv[1]; manual = len(sys.argv) > 2 and sys.argv[2] == 'manual'   # manual: AUTO_APPROVE=false → trang chờ duyệt; mặc định (production): vào dùng ngay
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(viewport={'width': 1200, 'height': 800}, locale='vi-VN', service_workers='block')
    errs = []; pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' and '401' not in m.text and '403' not in m.text else None)
    pg.goto(base + '/#/register'); pg.wait_for_timeout(700)
    pg.select_option('#r-role', 'teacher'); pg.fill('#r-name', 'Co Hoa'); pg.fill('#r-email', 'hoa@example.com'); pg.fill('#r-pw', 'Correct-Horse-9'); pg.fill('#r-birth', '2001-07'); pg.check('#r-terms')
    pg.click('button[type=submit]'); pg.wait_for_selector('.topbar')
    for path in ('#/', '#/t/vocab', '#/t/ai'):
        pg.goto(base + '/' + path); pg.wait_for_timeout(1500); assert pg.locator('text=Có lỗi xảy ra').count() == 0, path
        if manual: pg.wait_for_selector('text=đang chờ duyệt')
        else: assert pg.locator('text=đang chờ duyệt').count() == 0 and pg.locator('text=chưa được xác minh').count() == 0, path
    pg.goto(base + '/#/'); pg.wait_for_selector('h1'); print('manual' if manual else 'auto', 'OK'); print('errs', errs)
    b.close()
