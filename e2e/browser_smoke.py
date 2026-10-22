import sys, json, hmac, hashlib, struct, time, base64
from playwright.sync_api import sync_playwright
S=sys.argv[1]; info=json.load(open(S+'/e2e/info.json')); base=info['base']
def totp(secret):
    key=base64.b32decode(secret+'='*(-len(secret)%8)); c=int(time.time()//30)
    h=hmac.new(key,struct.pack('>Q',c),hashlib.sha1).digest(); o=h[-1]&15
    return str((struct.unpack('>I',h[o:o+4])[0]&0x7fffffff)%1000000).zfill(6)
errs=[]
def newpage(b,w=390):
    ctx=b.new_context(viewport={'width':w,'height':800}, locale='vi-VN'); pg=ctx.new_page()
    pg.on('console', lambda m: errs.append((m.type,m.text)) if m.type in('error','warning') and '401' not in m.text else None)
    pg.on('pageerror', lambda e: errs.append(('pageerror',str(e)))); return pg
with sync_playwright() as p:
    b=p.chromium.launch()
    # học viên 9 tuổi vào bằng mã lớp: làm bài kiểm tra
    pg=newpage(b); pg.goto(base+'/#/class-login'); pg.fill('#c-code',info['classCode']); pg.fill('#c-user',info['cred']['username']); pg.fill('#c-pin',info['cred']['pin']); pg.click('button[type=submit]')
    pg.wait_for_selector('text=Chào An'); print('kid density', pg.evaluate("document.body.dataset.density"))
    pg.screenshot(path=f'{S}/e2e/20-kid-home.png')
    pg.goto(base+'/#/assignments'); pg.wait_for_selector('text=Kiểm tra 15 phút'); pg.click('text=Bắt đầu làm bài'); pg.wait_for_selector('.opt')
    pg.screenshot(path=f'{S}/e2e/21-quiz.png')
    for i in range(5):
        pg.click('.opt >> nth=1'); pg.wait_for_timeout(200)
        if i<4: pg.click('text=Tiếp')
    pg.click('text=Nộp bài'); pg.wait_for_selector('.stat'); print('quiz result', pg.inner_text('.stat'))
    pg.screenshot(path=f'{S}/e2e/22-quiz-result.png')
    pg.goto(base+'/#/friends'); pg.wait_for_timeout(600); print('kid friends:', pg.inner_text('main')[:120].replace('\n',' | '))
    # giáo viên
    pg=newpage(b,1100); pg.goto(base+'/#/login'); pg.fill('#l-email','gv@example.com'); pg.fill('#l-pw','Correct-Horse-9'); pg.click('button[type=submit]'); pg.wait_for_selector('main h1')
    pg.screenshot(path=f'{S}/e2e/23-teacher-classes.png'); pg.click('a.card >> nth=0'); pg.wait_for_selector('text=Danh sách học viên'); pg.wait_for_timeout(500)
    pg.screenshot(path=f'{S}/e2e/24-teacher-class.png', full_page=True)
    pg.goto(base+'/#/t/questions'); pg.wait_for_selector('text=Soạn câu hỏi'); pg.screenshot(path=f'{S}/e2e/25-questions.png')
    # phụ huynh
    pg=newpage(b); pg.goto(base+'/#/login'); pg.fill('#l-email','ph@example.com'); pg.fill('#l-pw','Correct-Horse-9'); pg.click('button[type=submit]'); pg.wait_for_selector('main a.card'); pg.click('a.card >> nth=0'); pg.wait_for_selector('text=Ai đã xem'); pg.screenshot(path=f'{S}/e2e/26-guardian-child.png', full_page=True)
    # admin (MFA)
    pg=newpage(b,1100); pg.goto(base+'/#/login'); pg.fill('#l-email',info['adminEmail']); pg.fill('#l-pw','Correct-Horse-9'); pg.click('button[type=submit]'); pg.wait_for_selector('#l-totp:visible'); pg.fill('#l-totp',totp(info['adminSecret'])); pg.click('button[type=submit]')
    pg.wait_for_selector('text=Tổng quan hệ thống'); pg.screenshot(path=f'{S}/e2e/27-admin.png')
    for h in ['teachers','moderation','audit']:
        pg.goto(base+'/#/a/'+h); pg.wait_for_timeout(700); print(h, pg.inner_text('h1'))
    b.close()
print(json.dumps(errs,ensure_ascii=False))
