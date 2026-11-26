/** Executes the patched host module with fake DOM/WS, and the real frame tick branch.
 * No installed engine writes, no sockets. Pass the already patched isolated engine.
 */
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const engine=process.argv[2];if(!engine)throw Error('Pass isolated patched engine');
// Execute the actual public kit wrapper, with no accidental `custom` global.
// createPet is a stub here to isolate the wrapper's scope from model/DOM rendering.
const kitSource=fs.readFileSync(new URL('../runtime/kit/body.js',import.meta.url),'utf8');
const wrapperStart=kitSource.indexOf('export function createBody(host, opts) {');
assert.ok(wrapperStart>=0);
const kitContext={KIT_CSS:'',SVGNS:'svg',KIT_EXPRESSIONS:[],KIT_MOTIONS:[],
  createPet(){return {pet:{},layout(){return null;},step(){},render(){},talk(){}};},
};
vm.runInNewContext(kitSource.slice(wrapperStart).replace('export function','function')+'\nglobalThis.createBody=createBody;',kitContext);
const element=()=>({setAttribute(){},remove(){},children:[{},{},{}]});
const doc={head:{appendChild(){}},createElement:element,createElementNS:element};
const host={root:{ownerDocument:doc,appendChild(){}},bounds(){return {};}};
let active=false,packet;
const figure={musicActive:()=>active,music:d=>{packet=d;}};
const kitBody=kitContext.createBody(host,{figure});
assert.equal(kitBody.musicActive(),false);active=true;assert.equal(kitBody.musicActive(),true);
kitBody.music({rms:.03});assert.equal(packet.rms,.03);
delete figure.musicActive;assert.equal(kitBody.musicActive(),false);
figure.musicActive=()=>active;
let listener,frame;const sockets=[],posts=[],timers=new Map();let timerId=0;
class Socket {constructor(){sockets.push(this);}close(){this.closed=true;} }
const context={console,URL,performance,WebSocket:Socket,location:{pathname:'/pet',host:'localhost',href:'http://localhost/pet'},
  setTimeout(fn){timers.set(++timerId,fn);return timerId;},clearTimeout(id){timers.delete(id);},
  language:()=> 'zh',t:k=>k,
  addEventListener(type,fn){if(type==='message')listener=fn;},removeEventListener(){},
  document:{createElement(tag){const el={style:{},setAttribute(){},appendChild(){},remove(){}};if(tag==='iframe'){el.contentWindow={postMessage(m){posts.push(m);}};frame=el;}return el;}},
};
let source=fs.readFileSync(path.join(engine,'web/body-host.js'),'utf8').replace(/^import[^\n]*\n/gm,'').replaceAll('export function','function');
vm.runInNewContext(source+'\nglobalThis.loadBody = loadBody;',context);
const pack={id:'fish',base:'/pack/',entry:'figure.js',export:'createFigureBody',axes:[{id:'ear',options:[{id:'music'},{id:'off'}]}],presets:[],vocab:[]};
const promise=context.loadBody({layer:{appendChild(){}},pack,start:{scheme:'music'},bounds:{W:800,H:800,S:1}});
await listener({source:frame.contentWindow,data:{t:'ready'}});const body=await promise;
assert.equal(sockets.length,1);const a=sockets[0];a.onmessage({data:'{"rms":0.03}'});assert.equal(posts.at(-1).t,'music');
// Music activity must cross the actual frame -> host return message.
const frameSource=fs.readFileSync(path.join(engine,'web/figure-frame.js'),'utf8');
const begin=frameSource.indexOf('      const __w = Date.now()'),end=frameSource.indexOf("    } else if (m.t === 'scheme')",begin);
assert.ok(begin>=0&&end>begin,'real tick branch must be found');
let reply;vm.runInNewContext(frameSource.slice(begin,end),{Date,m:{dt:1/60,draw:true},body:kitBody,events:[],sounds:[],post(m){reply=m;}});
await listener({source:frame.contentWindow,data:reply});assert.equal(body.musicActive(),true);
await listener({source:frame.contentWindow,data:{t:'frame',layout:null,musicActive:false}});assert.equal(body.musicActive(),false);
// setScheme returns an acknowledgment promise; use actual host acknowledgments.
async function scheme(id){const p=body.setScheme(id);await listener({source:frame.contentWindow,data:{t:'scheme',seq:posts.at(-1).seq}});await p;}
await scheme('off');assert.equal(a.closed,true);
await scheme('music');assert.equal(sockets.length,2);const b=sockets[1];
a.onclose();const count=posts.length;a.onmessage({data:'{"rms":0.99}'});assert.equal(posts.length,count,'old socket must not forward');
// Closing an old socket must not clear the new socket's ownership.
b.onmessage({data:'{"rms":0.05}'});assert.equal(posts.at(-1).data.rms,.05);
body.dispose();assert.equal(b.closed,true);
console.log('PASS: host/frame activity feedback, audio forwarding, ear off/on, old-socket race, dispose.');
