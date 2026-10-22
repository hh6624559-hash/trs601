import sys, json
from playwright.sync_api import sync_playwright
S=sys.argv[1]; info=json.load(open(S+'/e2e/info.json')); base=info['base']; errs=[]
FAKE_SCREEN="""(()=>{const c=document.createElement('canvas');c.width=640;c.height=360;const x=c.getContext('2d');let i=0;
setInterval(()=>{x.fillStyle='#123';x.fillRect(0,0,640,360);x.fillStyle='#fc0';x.fillRect((i*7)%600,100,40,40);x.fillStyle='#fff';x.font='32px sans-serif';x.fillText('BAI GIANG '+i,40,60);i++},50);
const st=c.captureStream(15);navigator.mediaDevices.getDisplayMedia=async()=>new MediaStream(st.getVideoTracks().map(t=>t.clone()));})()"""
def pg_(b,w=1100):
    c=b.new_context(viewport={'width':w,'height':1000},locale='vi-VN',service_workers='block',bypass_csp=True); c.add_init_script("try{localStorage.setItem('debug','1')}catch(e){}"); c.add_init_script(FAKE_SCREEN); p=c.new_page()
    p.on('response',lambda r:print('HTTP',r.status,r.url.split('/api/v1')[-1],r.text()[:140]) if '/api/' in r.url and r.status>=400 and r.status!=401 else None)
    p.on('pageerror',lambda e:errs.append(('pageerror',str(e))))
    p.on('console',lambda m:errs.append((m.type,m.text)) if m.type=='error' and '401' not in m.text and '404' not in m.text else None); return p
PIX="(()=>{const c=document.querySelector('canvas.boardcanvas');if(!c)return -1;const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let n=0;for(let i=3;i<d.length;i+=4)if(d[i]>0)n++;return n})()"
def draw(P,pts):
    bb=P.locator('canvas.boardcanvas').bounding_box(); P.mouse.move(bb['x']+bb['width']*pts[0][0],bb['y']+bb['height']*pts[0][1]); P.mouse.down()
    for x,y in pts[1:]: P.mouse.move(bb['x']+bb['width']*x,bb['y']+bb['height']*y,steps=6)
    P.mouse.up()
with sync_playwright() as pw:
    b=pw.chromium.launch(args=['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream'])
    T=pg_(b); T.goto(base+'/#/login'); T.fill('#l-email','gv@example.com'); T.fill('#l-pw','Correct-Horse-9'); T.click('button[type=submit]'); T.wait_for_selector('.topbar')
    K=pg_(b,420); K.context.add_init_script("(()=>{const d=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'srcObject');Object.defineProperty(HTMLMediaElement.prototype,'srcObject',{set(v){if(this.id==='rm-screen')console.log('SRC '+(v?'set':'null')+' '+new Error().stack.split('\\n').slice(2,4).join('|'));d.set.call(this,v)},get(){return d.get.call(this)}})})()"); K.on('console',lambda m:print(m.text[:300]) if m.text.startswith('SRC') else None); cr=info['creds'][0]; K.goto(base+'/#/class-login'); K.fill('#c-code',info['classCode']); K.fill('#c-user',cr['username']); K.fill('#c-pin',cr['pin']); K.click('button[type=submit]'); K.wait_for_selector('.topbar')
    T.goto(base+'/#/rooms'); T.wait_for_selector('#rm-title'); T.fill('#rm-title','Bài giảng'); T.click('form:has(#rm-title) button[type=submit]'); T.wait_for_selector('text=Trước khi vào')
    T.click('button:has-text("Vào không bật cam")'); T.wait_for_selector('.controls')
    K.goto(base+'/#/rooms'); K.wait_for_selector('a:has-text("Mở")'); K.click('a:has-text("Mở")'); K.wait_for_selector('text=Trước khi vào'); K.click('button:has-text("Vào không bật cam")'); K.wait_for_selector('.controls')
    K.wait_for_selector('.polaroid'); K.wait_for_timeout(1500)
    assert K.locator('#rm-share').is_hidden(), 'HS không có nút chia sẻ'
    # --- chia sẻ màn hình ---
    T.click('#rm-share'); 
    try: K.wait_for_function("(()=>{const v=document.querySelector('#rm-screen');return v&&v.videoWidth>0})()",timeout=25000)
    except Exception:
        for P,n in ((T,'T'),(K,'K')):
            print(n,P.evaluate("[...window.__rs.pcs.values()].map(pc=>[pc.connectionState,pc.signalingState,pc.getTransceivers().map(t=>[t.mid,t.direction,t.currentDirection,t.sender.track&&t.sender.track.kind,t.receiver.track.kind])])"),P.evaluate("[window.__rs.screenId,window.__rs.state.screenBy,window.__rs.state.screenStream,!!window.__rs.screenTrack]"),P.evaluate("document.querySelector('#rm-stage').innerText"))
        print('K dbg',K.evaluate("[!!window.__rs.screenIn, [...window.__rs.pcs.values()].map(pc=>pc.getReceivers().map(r=>[r.track.kind,r.track.muted,r.track.readyState])), (()=>{const v=document.querySelector('#rm-screen');return v&&[!!v.srcObject,v.videoWidth,v.paused,v.readyState]})()]"))
        print('K manual',K.evaluate("(async()=>{const v=document.querySelector('#rm-screen');v.srcObject=window.__rs.screenIn;await new Promise(r=>setTimeout(r,3000));return [v.videoWidth,v.paused,window.__rs.screenIn.getTracks().map(t=>[t.readyState,t.muted])]})()"))
        raise
    print('K thấy màn hình giáo viên: OK')
    T.wait_for_selector('#rm-screen'); T.screenshot(path=S+'/e2e/v28/share-teacher.png'); K.screenshot(path=S+'/e2e/v28/share-student.png')
    # --- bảng trắng ---
    T.click('#rm-board'); K.wait_for_selector('text=Bảng',timeout=8000)
    K.click('.stage button:has-text("Bảng")'); K.wait_for_selector('canvas.boardcanvas'); T.click('.stage button:has-text("Bảng")'); T.wait_for_selector('canvas.boardcanvas')
    assert K.locator('.boardtools').is_hidden() or K.locator('[data-tool=pen]').is_hidden(), 'HS chưa có công cụ vẽ'
    draw(T,[(0.1,0.2),(0.4,0.5),(0.8,0.3)])
    K.wait_for_function(PIX+">200",timeout=8000); print('K thấy nét vẽ của giáo viên: OK')
    draw(K,[(0.2,0.8),(0.6,0.9)]); K.wait_for_timeout(1200); n=K.evaluate(PIX); T.wait_for_timeout(1200)
    assert T.evaluate(PIX)>0
    K_before=K.evaluate(PIX)
    # cấp quyền
    T.click('[data-grant]'); K.wait_for_selector('[data-tool=pen]:visible',timeout=8000)
    draw(K,[(0.2,0.8),(0.6,0.9)]); T.wait_for_function(PIX+">"+str(T.evaluate(PIX)+50),timeout=8000); print('HS được cấp quyền vẽ, GV thấy: OK')
    T.screenshot(path=S+'/e2e/v28/board-teacher.png'); K.screenshot(path=S+'/e2e/v28/board-student.png')
    # hoàn tác nét của HS
    K.click('button[aria-label="Hoàn tác"]'); T.wait_for_timeout(1500)
    # trang mới
    T.click('button[aria-label="Thêm trang"]'); K.wait_for_function("document.querySelector('[data-board-page]').textContent.includes('2/2')",timeout=8000); assert K.evaluate(PIX)==0; print('đổi trang đồng bộ: OK')
    # tải PNG
    with T.expect_download() as d: T.click('button[aria-label="Tải trang bảng (PNG)"]')
    print('export:',d.value.suggested_filename)
    # dừng chia sẻ
    T.click('#rm-share'); K.wait_for_function("!document.querySelector('#rm-screen')||!document.querySelector('#rm-screen').srcObject",timeout=8000); print('dừng chia sẻ: OK')
    T.click('button:has-text("Kết thúc cho mọi người")'); K.wait_for_selector('text=Phòng đã kết thúc',timeout=10000)
    b.close()
print(json.dumps(errs,ensure_ascii=False))
