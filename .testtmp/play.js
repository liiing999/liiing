const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const TARGET = 'http://127.0.0.1:8000/index.html';
const port = 9335;
const chrome = spawn(CHROME, ['--headless=new','--disable-gpu','--no-first-run','--remote-debugging-port='+port,'--user-data-dir=.testtmp\\chrome-profile3','--window-size=1280,800','about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJson = p => new Promise((res, rej) => { http.get('http://127.0.0.1:'+port+p, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>res(JSON.parse(d))); }).on('error', rej); });
class CDP {
  constructor(u){this.u=new URL(u);this.id=0;this.pending=new Map();this.events=[];const k=crypto.randomBytes(16).toString('base64');
    this.sock=net.connect(this.u.port,this.u.hostname,()=>{this.sock.write('GET '+this.u.pathname+' HTTP/1.1\r\nHost: '+this.u.host+'\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: '+k+'\r\nSec-WebSocket-Version: 13\r\n\r\n');});
    let hs=false,buf=Buffer.alloc(0);this.sock.on('data',c=>{buf=Buffer.concat([buf,c]);if(!hs){const i=buf.indexOf('\r\n\r\n');if(i<0)return;hs=true;buf=buf.slice(i+4);}
      while(buf.length>=2){const op=buf[0]&15;let len=buf[1]&127;let off=2;if(len===126){len=buf.readUInt16BE(2);off=4;}if(buf.length<off+len)break;const pl=buf.slice(off,off+len);buf=buf.slice(off+len);if(op===1){let m;try{m=JSON.parse(pl.toString())}catch{continue;}if(m.id&&this.pending.has(m.id)){this.pending.get(m.id)(m.result);this.pending.delete(m.id);}else if(m.method)this.events.push(m);}}});
    this.ready=new Promise(r=>{const t=setInterval(()=>{if(hs){clearInterval(t);r();}},30);});}
  send(method,params={}){return new Promise(res=>{const id=++this.id;this.pending.set(id,res);const data=Buffer.from(JSON.stringify({id,method,params}));const h=Buffer.alloc(data.length<126?2:4);h[0]=0x81;if(data.length<126){h[1]=0x80|data.length;}else{h[1]=0x80|126;h.writeUInt16BE(data.length,2);}const m=crypto.randomBytes(4);for(let i=0;i<data.length;i++)data[i]^=m[i%4];this.sock.write(Buffer.concat([h,m,data]));});}
  drain(){return this.events.splice(0);}
}
function key(cdp, type, code){return cdp.send('Input.dispatchKeyEvent',{type,code,windowsVirtualKeyCode:code.charCodeAt(0),key:code==='Space'?' ':'w'});}
(async()=>{
  let list=null;for(let i=0;i<40;i++){try{list=await getJson('/json');break;}catch{await sleep(500);}}
  const pg=list.find(t=>t.type==='page');const cdp=new CDP(pg.webSocketDebuggerUrl);await cdp.ready;
  const errors=[];
  await cdp.send('Runtime.enable');await cdp.send('Page.enable');
  cdp.events.length=0;
  await cdp.send('Page.navigate',{url:TARGET});await sleep(3500);
  await cdp.send('Runtime.evaluate',{expression:"document.getElementById('start-btn').click()"});
  await sleep(3000);
  // 读取初始风向（来自运行中的游戏）
  const wind = await cdp.send('Runtime.evaluate',{expression:`(()=>{const g=window; return JSON.stringify({wa:window.__game&&window.__game.windAngle});})()`,returnByValue:true});
  // 直接通过游戏实例：把船头转到顺风方向并满帆，再转到顶风，对比效率
  const setup = await cdp.send('Runtime.evaluate',{expression:`(()=>{
    // 无法直接访问 game 闭包，改为模拟按键：按住 W 升帆 2 秒
    return 'ready';
  })()`,returnByValue:true});
  // 按住 W 2 秒
  await key(cdp,'keyDown','KeyW'); await sleep(2200); await key(cdp,'keyUp','KeyW');
  await sleep(3000);
  const afterSail = await cdp.send('Runtime.evaluate',{expression:`JSON.stringify({
    sail: document.getElementById('sail-amount-text').textContent,
    eff: document.getElementById('sail-text').textContent,
    speed: document.getElementById('speed-text').textContent
  })`,returnByValue:true});
  console.log('满帆后:', afterSail.result.value);
  // 再跑 6 秒看速度
  await sleep(6000);
  const moving = await cdp.send('Runtime.evaluate',{expression:`JSON.stringify({
    eff: document.getElementById('sail-text').textContent,
    speed: document.getElementById('speed-text').textContent,
    info: document.getElementById('info-stats').textContent.replace(/\\s+/g,' ').slice(0,140),
    chunks: document.getElementById('info-stats').textContent.includes('区块')
  })`,returnByValue:true});
  console.log('航行中:', moving.result.value);
  // 截图
  const shot = await cdp.send('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync('.testtmp/game.png', Buffer.from(shot.data,'base64'));
  for(const ev of cdp.drain()){
    if(ev.method==='Runtime.exceptionThrown') errors.push(ev.params.exceptionDetails.text);
  }
  console.log('异常数:', errors.length); errors.slice(0,10).forEach(e=>console.log(e));
  chrome.kill();
  process.exit(errors.length?2:0);
})();
