import sys, json
from playwright.sync_api import sync_playwright
S=sys.argv[1]; info=json.load(open(S+'/e2e/info.json')); base=info['base']; errs=[]
def pg_(b,w=900):
    c=b.new_context(viewport={'width':w,'height':900},locale='vi-VN',service_workers='block'); p=c.new_page()
    p.on('response',lambda r:print('HTTP',r.status,r.url.split('/api/v1')[-1],r.text()[:160]) if '/api/' in r.url and r.status>=400 and r.status!=401 else None)
    p.on('pageerror',lambda e:errs.append(('pageerror',str(e))))
    p.on('console',lambda m:errs.append((m.type,m.text)) if m.type=='error' and '401' not in m.text and '409' not in m.text else None); return p
import traceback
with sync_playwright() as pw:
    b=pw.chromium.launch()
    T=pg_(b); T.goto(base+'/#/login'); T.fill('#l-email','gv@example.com'); T.fill('#l-pw','Correct-Horse-9'); T.click('button[type=submit]'); T.wait_for_selector('.topbar')
    kids=[]
    for cr in info['creds'][:2]:
        K=pg_(b,390); K.goto(base+'/#/class-login'); K.fill('#c-code',info['classCode']); K.fill('#c-user',cr['username']); K.fill('#c-pin',cr['pin']); K.click('button[type=submit]'); K.wait_for_selector('.topbar'); kids.append(K)
    T.goto(base+'/#/arena'); T.wait_for_selector('#am-class'); T.select_option('#am-mode','duel'); T.click('form:has(#am-class) button[type=submit]'); T.wait_for_selector('text=Đang chờ người chơi')
    for K in kids:
        K.goto(base+'/#/arena'); K.wait_for_selector('text=Trận đang mở'); K.click('button:has-text("Vào trận")'); K.wait_for_selector('text=Đang chờ người chơi')
    T.wait_for_selector('.pill-list li >> nth=2'); T.click('button:has-text("Bắt đầu")')
    for K in kids: K.wait_for_selector('button:has-text("Sẵn sàng")'); K.click('button:has-text("Sẵn sàng")')
    for r in range(10):
        for K in kids:
            try: K.wait_for_selector('.board .opt:not([disabled])',timeout=15000)
            except Exception: print('STUCK round',r,K.inner_text('main')[:300].replace('\n',' | ')); K.screenshot(path=S+'/e2e/v28/stuck.png'); raise
        if r==0: kids[0].screenshot(path=S+'/e2e/v28/arena-round.png')
        for K in kids: K.click('.board .opt >> nth=0')
        for K in kids: K.wait_for_selector('.stamp',timeout=8000)
        if r==0: kids[0].screenshot(path=S+'/e2e/v28/arena-reveal.png')
    for K in kids: K.wait_for_selector('text=Kết thúc trận',timeout=15000)
    kids[0].screenshot(path=S+'/e2e/v28/arena-final.png'); print('final:', kids[0].inner_text('main')[:200].replace('\n',' | '))
    b.close()
print(json.dumps(errs,ensure_ascii=False))
