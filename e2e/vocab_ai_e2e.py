"""E2E: giáo viên nhập từ vựng → bật AI → chọn bộ từ → AI (giả) ra nháp → xem trong ngân hàng câu hỏi. Chạy: python3 e2e/vocab_ai_e2e.py <base_url>"""
import sys
from playwright.sync_api import sync_playwright
base = sys.argv[1]
TEXT = "Từ\tLoại từ\tNghĩa\tVí dụ\nzorblax\tn\tcon vật tưởng tượng\tA zorblax sings.\nquimble\tv\tlảo đảo\t\nflarn\tn\ttiếng ồn lạ\t\ngrunk\tadj\tnặng nề\t"
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(viewport={'width': 1280, 'height': 900}, locale='vi-VN')
    errs = []; pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' and '401' not in m.text else None)
    pg.goto(base + '/#/register'); pg.wait_for_timeout(700)
    pg.select_option('#r-role', 'teacher'); pg.fill('#r-name', 'Co Lan'); pg.fill('#r-email', 'lan@example.com'); pg.fill('#r-pw', 'Correct-Horse-9'); pg.fill('#r-birth', '2001-07'); pg.check('#r-terms')
    pg.click('button[type=submit]'); pg.wait_for_timeout(1500)
    pg.goto(base + '/#/t/vocab'); pg.wait_for_selector('#vi-text')
    pg.fill('#vi-name', 'Unit 1'); pg.fill('#vi-text', TEXT)
    pg.click('text=Xem trước'); pg.wait_for_selector('text=Đọc được 4 từ hợp lệ')
    pg.click('text=Nhập vào kho từ'); pg.wait_for_selector('text=Hãy tích xác nhận')
    pg.check('#vi-att'); pg.click('text=Nhập vào kho từ'); pg.wait_for_selector('td:has-text("Unit 1")')
    print('IMPORT OK')
    pg.click('text=AI ra đề'); pg.wait_for_selector('#ai-on')
    print('AI page:', pg.inner_text('main')[:160].replace('\n', ' | '))
    pg.check('#ai-on'); pg.wait_for_timeout(800)
    pg.wait_for_selector('#ai-list'); pg.select_option('#ai-list', index=1); pg.wait_for_timeout(800)
    pg.click('text=Chọn tất cả'); pg.click('button:has-text("Tạo nháp")'); pg.wait_for_selector('text=Đã tạo', timeout=20000)
    print('GEN:', pg.inner_text('main section:first-of-type').split('Tạo nháp')[-1][:120].replace('\n', ' '))
    pg.click('text=Xem và duyệt các nháp'); pg.wait_for_selector('table'); pg.wait_for_timeout(500)
    print('QUESTIONS:', pg.inner_text('table')[:300].replace('\n', ' | '))
    pg.screenshot(path=sys.argv[2] if len(sys.argv) > 2 else '/tmp/q.png', full_page=True)
    print('errs', errs); b.close()
