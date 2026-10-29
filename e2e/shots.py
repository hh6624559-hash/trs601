import sys, json
from playwright.sync_api import sync_playwright
S=sys.argv[1]; info=json.load(open(S+'/e2e/info.json')); base=info['base']; out=S+'/e2e/v28'
import os; os.makedirs(out,exist_ok=True)
VP={'m':(390,844),'t':(768,1024),'d':(1440,900)}
with sync_playwright() as p:
    b=p.chromium.launch()
    for k,(w,hh) in VP.items():
        ctx=b.new_context(viewport={'width':w,'height':hh},locale='vi-VN',service_workers='block'); pg=ctx.new_page()
        pg.goto(base+'/#/class-login'); pg.fill('#c-code',info['classCode']); pg.fill('#c-user',info['cred']['username']); pg.fill('#c-pin',info['cred']['pin']); pg.click('button[type=submit]'); pg.wait_for_selector('main h1')
        for theme in ('light','dark'):
            pg.evaluate(f"document.documentElement.dataset.theme='{theme}'")
            for name,route in (('home','/'),('shelf','/collections'),('review','/review')):
                pg.goto(base+'/#'+route); pg.wait_for_timeout(700); pg.screenshot(path=f'{out}/{k}-{theme}-{name}.png')
        ctx.close()
    b.close()
