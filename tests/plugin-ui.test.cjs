const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');

test('manual disconnect stays disconnected and stale sockets cannot replace a new connection',async()=>{
 const timers=new Map();let timerId=0;const sockets=[];
 const elements=new Map();
 const document={querySelectorAll:()=>[],getElementById:id=>{
  if(!elements.has(id))elements.set(id,{value:'3066',style:{},classList:{add(){},remove(){}},addEventListener(){}});
  return elements.get(id);
 }};
 class Socket{
  static OPEN=1;
  constructor(){this.readyState=0;this.sent=[];sockets.push(this);}
  send(data){this.sent.push(JSON.parse(data));}
  close(){this.readyState=3;this.onclose?.();}
  open(){this.readyState=1;this.onopen?.();this.onmessage?.({data:JSON.stringify({type:'system',channel:'test',message:{result:'joined'}})});}
 }
 const context=vm.createContext({document,window:{},parent:{postMessage(){}},WebSocket:Socket,console:{log(){},error(){}},setTimeout:fn=>{timers.set(++timerId,fn);return timerId;},clearTimeout:id=>timers.delete(id)});
 const html=fs.readFileSync(path.join(__dirname,'../figma-plugin/ui.html'),'utf8');
 vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1],context);
 const run=code=>vm.runInContext(code,context);
 await run('connectToServer(3066)');await run('connectToServer(3066)');
 assert.equal(sockets.length,1,'connecting sockets must not be duplicated');
 sockets[0].open();run('disconnectFromServer()');
 for(const fn of [...timers.values()])fn();
 assert.equal(sockets.length,1,'manual disconnect must cancel all automatic reconnects');
 await run('connectToServer(3066)');const current=sockets[1];current.open();
 sockets[0].onclose();assert.equal(run('state.socket')===current,true);
 current.close();const count=sockets.length;
 for(const fn of [...timers.values()])fn();
 assert.equal(sockets.length,count+1,'unexpected disconnect must reconnect');
});
