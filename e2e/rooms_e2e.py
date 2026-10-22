import sys, json
from playwright.sync_api import sync_playwright
S=sys.argv[1]; info=json.load(open(S+'/e2e/info.json')); base=info['base']; errs=[]
def pg_(b,w=1000):
    c=b.new_context(viewport={'width':w,'height':900},locale='vi-VN',service_workers='block',bypass_csp=True,permissions=['camera','microphone']); c.add_init_script("try{localStorage.setItem('debug','1')}catch(e){}"); p=c.new_page()
    p.on('response',lambda r:print('HTTP',r.status,r.url.split('/api/v1')[-1],r.text()[:140]) if '/api/' in r.url and r.status>=400 and r.status!=401 else None)
    p.on('console',lambda m:print('CONSOLE',m.type,m.text[:150]) if m.type in('warning',) and 'room poll' in m.text else None)
    p.on('pageerror',lambda e:errs.append(('pageerror',str(e))))
    p.on('console',lambda m:errs.append((m.type,m.text)) if m.type=='error' and '401' not in m.text and '409' not in m.text else None); return p
with sync_playwright() as pw:
    b=pw.chromium.launch(args=['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream'])
    T=pg_(b); T.goto(base+'/#/login'); T.fill('#l-email','gv@example.com'); T.fill('#l-pw','Correct-Horse-9'); T.click('button[type=submit]'); T.wait_for_selector('.topbar')
    K=pg_(b,390); cr=info['creds'][0]; K.goto(base+'/#/class-login'); K.fill('#c-code',info['classCode']); K.fill('#c-user',cr['username']); K.fill('#c-pin',cr['pin']); K.click('button[type=submit]'); K.wait_for_selector('.topbar')
    T.goto(base+'/#/rooms'); T.wait_for_selector('#rm-title'); T.fill('#rm-title','Học buổi sáng'); T.click('form:has(#rm-title) button[type=submit]'); T.wait_for_selector('text=Trước khi vào')
    T.screenshot(path=S+'/e2e/v28/room-prejoin.png')
    T.click('button:has-text("Vào không bật cam")'); T.wait_for_selector('.controls')
    K.goto(base+'/#/rooms'); K.wait_for_selector('a:has-text("Mở")'); K.click('a:has-text("Mở")'); K.wait_for_selector('text=Trước khi vào'); K.click('button:has-text("Vào không bật cam")'); K.wait_for_selector('.controls')
    T.wait_for_selector('.polaroid >> nth=1'); K.wait_for_selector('.polaroid >> nth=1')
    # mặc định cam/mic TẮT và bị khóa cho HS cho tới khi giáo viên cho phép
    assert K.is_disabled('button[aria-label="Cam"]'), 'cam phải bị khóa khi chưa được cho phép'
    T.click('button[title="Cho phép cam/mic"]'); T.wait_for_timeout(2500)
    print('T members:', T.inner_text('.stack').replace('\n',' | ')[:300]); print('K cam disabled:', K.is_disabled('button[aria-label="Cam"]'))
    K.wait_for_function("!document.querySelector('button[aria-label=\"Cam\"]').disabled",timeout=8000)
    K.click('button[aria-label="Cam"]')
    try:
        T.wait_for_function("[...document.querySelectorAll('.polaroid video')].some(v=>v.videoWidth>0)",timeout=20000)
    except Exception:
        for P,n in ((T,'T'),(K,'K')):
            print(n,'pcs',P.evaluate("window.__rs ? [...window.__rs.pcs.entries()].map(([k,pc])=>[k.slice(0,6),pc.connectionState,pc.iceConnectionState,pc.signalingState]) : 'no rs'"))
        for P,n in ((T,'T'),(K,'K')):
            print(n,'recv',P.evaluate("[...window.__rs.pcs.values()].map(pc=>pc.getReceivers().map(r=>[r.track.kind,r.track.muted,r.track.readyState]))"),'send',P.evaluate("[...window.__rs.pcs.values()].map(pc=>pc.getSenders().map(s=>s.track&&s.track.kind))"),'local',P.evaluate("window.__rs.local&&window.__rs.local.getTracks().map(t=>t.kind)"))
            print(n,'videos',P.evaluate("[...document.querySelectorAll('.polaroid video')].map(v=>[v.srcObject&&v.srcObject.getTracks().length,v.videoWidth,v.paused])"))
        print('K gum:', K.evaluate("navigator.mediaDevices.getUserMedia({video:true}).then(s=>'ok '+s.getTracks().length).catch(e=>e.name+': '+e.message)"))
        print('K banner:', K.inner_text('main')[:400].replace('\n',' | '))
        raise
    print('remote video flowing: OK')
    K.press('body','h'); T.wait_for_selector('text=✋',timeout=8000)
    T.screenshot(path=S+'/e2e/v28/room-live.png'); K.screenshot(path=S+'/e2e/v28/room-live-mobile.png')
    T.click('button:has-text("Kết thúc cho mọi người")'); K.wait_for_selector('text=Phòng đã kết thúc',timeout=10000); print('end: OK')
    b.close()
print(json.dumps(errs,ensure_ascii=False))
