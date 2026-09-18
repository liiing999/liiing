const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const TARGET = 'http://127.0.0.1:8000/index.html';
const port = 9371;
const chrome = spawn(CHROME, ['--headless=new','--disable-gpu','--no-first-run','--remote-debugging-port='+port,'--user-data-dir=.testtmp\\chrome-profile-phys2','about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const getJson = p => new Promise((res,rej)=>{http.get('http://127.0.0.1:'+port,p,r2=>{let d='';r2.on('data',c=>d+=c);r2.on('end',()=>{if(d.length===0)return rej(new Error('empty status='+r2.statusCode));try{res(JSON.parse(d));}catch(e){rej(e);}});}).on('error',rej);});
class CDP{constructor(u){this.u=new URL(u);this.id=0;this.p=new Map();this.events=[];const k=crypto.randomBytes(16).toString('base64');
 this.sock=net.connect(this.u.port,this.u.hostname,()=>{this.sock.write('GET '+this.u.pathname+' HTTP/1.1\r\nHost: '+this.u.host+'\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: '+k+'\r\nSec-WebSocket-Version: 13\r\n\r\n');});
 let hs=false,buf=Buffer.alloc(0);this.sock.on('data',c=>{buf=Buffer.concat([buf,c]);if(!hs){const i=buf.indexOf('\r\n\r\n');if(i<0)return;hs=true;buf=buf.slice(i+4);}
  while(buf.length>=2){let len=buf[1]&127;let off=2;if(len===126){len=buf.readUInt16BE(2);off=4;}if(buf.length<off+len)break;const pl=buf.slice(off,off+len);buf=buf.slice(off+len);try{const m=JSON.parse(pl.toString());if(m.id&&this.p.has(m.id)){this.p.get(m.id)(m.result);this.p.delete(m.id);}else if(m.method)this.events.push(m);}catch{}}});
 this.ready=new Promise(r=>{const t=setInterval(()=>{if(hs){clearInterval(t);r();}},30);});}
 send(method,params={}){return new Promise(res=>{const id=++this.id;this.p.set(id,res);const data=Buffer.from(JSON.stringify({id,method,params}));const h=Buffer.alloc(2);h[0]=0x81;h[1]=0x80|data.length;const m=crypto.randomBytes(4);for(let i=0;i<data.length;i++)data[i]^=m[i%4];this.sock.write(Buffer.concat([h,m,data]));});}
 drain(){return this.events.splice(0);}}
(async()=>{
 let list=null;for(let i=0;i<40;i++){try{const r=await getJson('/json');if(Array.isArray(r)&&r.find(t=>t.type==='page')){list=r;break;}}catch(e){if(i===39)console.log('last err',e.message);}await sleep(500);} console.log('tries done');
 const pg=list.find(t=>t.type==='page');const cdp=new CDP(pg.webSocketDebuggerUrl);await cdp.ready;
 const errors=[];
 await cdp.send('Runtime.enable');await cdp.send('Page.enable');
 await cdp.send('Page.navigate',{url:TARGET});await sleep(3500);
 await cdp.send('Runtime.evaluate',{expression:"document.getElementById('start-btn').click()"});
 await sleep(3000);
 // 物理验证脚本：在页面内跑固定步数，分别测顺风/顶风
 const testExpr = `(async()=>{
   const g = window.__game;
   g.paused = false; g.pointerLocked = true;
   const results = {};
   async function run(label, heading){
     g.player.resetState(0, 40, heading);
     g.player.sailAmount = 1;
     g.player.yardAngle = 0;
     for(let i=0;i<180;i++){ g._fixedUpdate(1/60); }
     // AI 自动设置理想帆桁
     for(let i=0;i<180;i++){
       g.player.yardAngle = g.player.idealYard;
       g._fixedUpdate(1/60);
     }
     results[label] = {
       eff: +(g.player.sailEfficiency*100).toFixed(0),
       knots: +g.player.speedKnots.toFixed(1),
       x: +g.player.position.x.toFixed(1), z:+g.player.position.z.toFixed(1)
     };
   }
   const windFrom = g.windAngle;
   await run('顺风(downwind)', windFrom + Math.PI);
   await run('横风(beam)', windFrom + Math.PI/2);
   await run('顶风(headwind)', windFrom);
   // 火炮测试
   g.player.reloadPort = 0;
   const before = g.combat.projectiles.some(p=>p.active);
   g.player.requestBroadside('port', g.elapsed);
   g.combat.fireBroadside(g.player,'port',g.enemies.ships);
   const fired = g.combat.projectiles.filter(p=>p.active).length;
   // 抛锚
   g.player.anchored = true;
   const sp1 = g.player.speedKnots;
   for(let i=0;i<120;i++) g._fixedUpdate(1/60);
   const sp2 = g.player.speedKnots;
   return JSON.stringify({results, fired, anchorBefore:+sp1.toFixed(2), anchorAfter:+sp2.toFixed(2), chunks: g.world.chunkCount});
 })()`;
 const r = await cdp.send('Runtime.evaluate',{expression:testExpr, awaitPromise:true, returnByValue:true});
 console.log(r.result.value || JSON.stringify(r.result));
 await sleep(500);
 for(const ev of cdp.drain()){ if(ev.method==='Runtime.exceptionThrown') errors.push(ev.params.exceptionDetails.exception?.description||ev.params.exceptionDetails.text); }
 console.log('异常:', errors.length); errors.slice(0,8).forEach(e=>console.log(e));
 chrome.kill();
 process.exit(errors.length?2:0);
})();








