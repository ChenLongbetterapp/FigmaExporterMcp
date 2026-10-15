import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const serverPath=process.env.FIGMA_REVIEW_SERVER||fileURLToPath(new URL('../dist/server.js',import.meta.url));
async function unusedPort(){const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));return port;}
async function connectClient(port,outputDirectory){
 const transport=new StdioClientTransport({command:process.execPath,args:[serverPath],env:{...process.env,FIGMA_EXPORTER_RELAY_PORT:String(port),...(outputDirectory?{FIGMA_EXPORTER_EXPORT_DIR:outputDirectory}:{})},stderr:'pipe'});
 transport.stderr?.on('data',()=>{});
 const client=new Client({name:'isolated-test',version:'1'},{capabilities:{}});
 try { await client.connect(transport, {timeout: 5000}); return client; } catch (error) { await client.close(); throw error; }
}
function content(result){return result.content.find(item=>item.type==='text')?.text||'';}
async function select(client,channel){return client.callTool({name:'set_active_file',arguments:{keyword:channel}});}
async function plugin(port,channel,respond){
 const socket=new WebSocket(`ws://127.0.0.1:${port}`);
 socket.on('message',async raw=>{
  const message=JSON.parse(raw.toString());
  if(message.type==='broadcast'){
   const request=message.message;
   const result=respond?await respond(request,socket):request.params.nodeId==='false-value'?false:{id:'node',name:channel,type:'FRAME',width:24,height:24};
   socket.send(JSON.stringify({type:'message',message:{id:request.id,result}}));
  }
 });
 await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});
 const joined=new Promise(resolve=>socket.on('message',raw=>{const item=JSON.parse(raw.toString());if(item.type==='system'&&item.message?.result)resolve();}));
 socket.send(JSON.stringify({type:'join',channel,fileName:'Same design name',fileKey:''}));await joined;return socket;
}
const close=socket=>new Promise(resolve=>{if(socket.readyState===WebSocket.CLOSED)return resolve();socket.once('close',resolve);socket.close();});
test('relay isolates sessions, refuses ambiguous targets, and preserves false responses',{timeout:15000},async()=>{
 const port=await unusedPort();const clients=[];const sockets=[];
 try{
  const a=await connectClient(port);clients.push(a);
  const one=await plugin(port,'alpha');sockets.push(one);
  const two=await plugin(port,'beta');sockets.push(two);
  const b=await connectClient(port);clients.push(b);
  const unbound=await connectClient(port);clients.push(unbound);
  await select(a,'alpha');await select(b,'beta');
  assert.equal(JSON.parse(content(await a.callTool({name:'get_document_info',arguments:{}}))).name,'alpha');
  assert.equal(JSON.parse(content(await b.callTool({name:'get_document_info',arguments:{}}))).name,'beta');
  assert.match(content(await unbound.callTool({name:'get_document_info',arguments:{}})),/No unique Figma file selected/);
  assert.match(content(await select(unbound,'Same design name')),/No file matching/);
  assert.equal(content(await a.callTool({name:'get_node_info',arguments:{nodeId:'false-value'}})),'false');
  const created=await a.callTool({name:'create_frame',arguments:{x:0,y:0,width:24,height:24}});
  assert.equal(JSON.parse(content(created)).id,'node');
  await select(a,'missing-file');
  assert.equal((await a.callTool({name:'get_document_info',arguments:{}})).isError,true,'failed file selection must not leave the old target writable');
  await select(a,'alpha');
  const health=await (await fetch(`http://127.0.0.1:${port}/health`)).json();assert.equal(health.service,'figma-exporter-mcp');
  const files=await(await fetch(`http://127.0.0.1:${port}/channels?sessionId=test-query`)).json();assert.equal(files.length,2);
  const replacement=await plugin(port,'alpha');sockets.push(replacement);await close(one);
  assert.equal(JSON.parse(content(await a.callTool({name:'get_document_info',arguments:{}}))).name,'alpha');
  await close(replacement);
  assert.match(content(await a.callTool({name:'get_document_info',arguments:{}})),/No unique Figma file selected/);
  assert.equal(JSON.parse(content(await b.callTool({name:'get_document_info',arguments:{}}))).name,'beta');
 }finally{for(const socket of sockets)await close(socket);for(const client of clients.reverse())await client.close();}
});

test('an in-flight export stays on its original file when the same session switches targets',{timeout:15000},async()=>{
 const port=await unusedPort();const clients=[];const sockets=[];
 const testCache=process.env.FIGMA_EXPORTER_TEST_CACHE||fileURLToPath(new URL('../node_modules/.cache/figma-tests/',import.meta.url));
 fs.mkdirSync(testCache,{recursive:true});
 const output=fs.mkdtempSync(path.join(testCache,'routing-'));
 let gate;
 const exports=[];
 const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=';
 const responder=channel=>async request=>{
   if(request.command==='list_design_assets'){
    const current=gate;current.started();await current.wait;
    return {assets:[{id:'asset',name:'icon',width:24,height:24,kind:'vector',pageName:'Page'}]};
   }
   if(request.command==='export_node_as_image'){exports.push(channel);return {imageData:png,mimeType:'image/png'};}
   return {name:channel};
 };
 try{
  const owner=await connectClient(port,output);clients.push(owner);
  sockets.push(await plugin(port,'alpha',responder('alpha')),await plugin(port,'beta',responder('beta')));
  const proxy=await connectClient(port,output);clients.push(proxy);
  for(const client of [owner,proxy]){
   let started,release;
   const ready=new Promise(resolve=>started=resolve);
   const wait=new Promise(resolve=>release=resolve);
   gate={started,release,wait};exports.length=0;
   await select(client,'alpha');
   const pending=client.callTool({name:'export_design_assets',arguments:{nodeIds:['asset'],concurrency:1}});
   await ready;await select(client,'beta');release();
   const result=await pending;
   assert.deepEqual(exports,['alpha']);assert.equal(result.isError,undefined);
   assert.equal(JSON.parse(content(result)).exportedCount,1);
  }
 }finally{gate?.release();for(const socket of sockets)await close(socket);for(const client of clients.reverse())await client.close();fs.rmSync(output,{recursive:true,force:true});}
});

test('MCP errors and partial failures are marked and retain structured receipts',{timeout:10000},async()=>{
 const port=await unusedPort();let client,socket;
 try{
  client=await connectClient(port);
  socket=await plugin(port,'alpha',async request=>{
   if(request.command==='get_instance_overrides')return {success:false,message:'Not an instance',sourceInstanceId:'source'};
   if(request.command==='set_multiple_text_contents')return {success:true,replacementsApplied:1,replacementsFailed:1,results:[{nodeId:'done',success:true},{nodeId:'bad',success:false}]};
   if(request.command==='get_node_info')return undefined;
   return {success:false,error:'Denied'};
  });
  const partial=await client.callTool({name:'set_multiple_text_contents',arguments:{nodeId:'root',text:[{nodeId:'done',text:'x'},{nodeId:'bad',text:'y'}]}});
  assert.equal(partial.isError,true);assert.match(JSON.stringify(partial.content),/replacementsFailed/);
  const overrides=await client.callTool({name:'get_instance_overrides',arguments:{nodeId:'source'}});
  assert.equal(overrides.isError,true);assert.equal(JSON.parse(content(overrides)).sourceInstanceId,'source');
  const malformed=await client.callTool({name:'get_node_info',arguments:{nodeId:'bad'}});
  assert.equal(malformed.isError,true);assert.match(content(malformed),/malformed response/);
 }finally{if(socket)await close(socket);if(client)await client.close();}
});

test('browser HTTP requests cannot mutate a design and progress respects the command deadline',{timeout:10000},async()=>{
 const port=await unusedPort();let client,socket;
 try{
  client=await connectClient(port);
  socket=await plugin(port,'alpha',async(request,ws)=>{
   ws.send(JSON.stringify({type:'message',message:{id:request.id,type:'progress_update',data:{commandType:'test',progress:1,message:'working'}}}));
   return new Promise(()=>{});
  });
  const url=`http://127.0.0.1:${port}/api/command`;
  const blocked=await fetch(url,{method:'POST',headers:{Origin:'https://unrelated.example','Content-Type':'application/json'},body:JSON.stringify({command:'delete_node',params:{nodeId:'x'}})});
  assert.equal(blocked.status,403);
  const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({command:'get_document_info',timeoutMs:80})});
  assert.equal(response.status,500);assert.match((await response.json()).error,/timed out/);
 }finally{if(socket)await close(socket);if(client)await client.close();}
});

test('SVG and PDF exports use embedded resources, not image content',{timeout:10000},async()=>{
 const port=await unusedPort();let client,socket;
 const testCache=fileURLToPath(new URL('../node_modules/.cache/figma-tests/',import.meta.url));fs.mkdirSync(testCache,{recursive:true});
 const output=fs.mkdtempSync(path.join(testCache,'formats-'));
 try{
  client=await connectClient(port,output);
  socket=await plugin(port,'formats',async request=>({imageData:Buffer.from(request.params.format==='SVG'?'<svg/>':'%PDF-1.4').toString('base64'),mimeType:request.params.format==='SVG'?'image/svg+xml':'application/pdf'}));
  for(const format of ['SVG','PDF']){
   const result=await client.callTool({name:'export_node_as_image',arguments:{nodeId:'node',format}});
   assert.equal(result.isError,undefined);assert.equal(result.content[0].type,'resource');
   assert.equal(result.content[0].resource.mimeType,format==='SVG'?'image/svg+xml':'application/pdf');
   assert.ok(result.content[0].resource.blob);
  }
 }finally{if(socket)await close(socket);if(client)await client.close();fs.rmSync(output,{recursive:true,force:true});}
});
test('an occupied unrelated HTTP port cannot become a proxy',{timeout:10000},async()=>{
 const service=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({service:'other'}));});
 await new Promise(resolve=>service.listen(0,'127.0.0.1',resolve));
 const port=service.address().port;
 try{
  const child=spawn(process.execPath,[serverPath],{env:{...process.env,FIGMA_EXPORTER_RELAY_PORT:String(port)},stdio:['ignore','pipe','pipe']});
  let errors='';child.stderr.on('data',data=>errors+=data);child.stdout.resume();
  const code=await new Promise(resolve=>child.on('exit',resolve));
  assert.equal(code,1);assert.match(errors,/unknown or incompatible service/);
 }finally{service.closeAllConnections();await new Promise(resolve=>service.close(resolve));}
});
