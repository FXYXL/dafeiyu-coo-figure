/** Exercise patched production closures, including the main-window cancel handlers. */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const engine=process.argv[2];if(!engine)throw Error('Pass an isolated patched engine');
const kit=fs.readFileSync(new URL('../runtime/kit/body.js',import.meta.url),'utf8');
const start=kit.indexOf('  function doWord(w, o) {'),end=kit.indexOf('\n  /**',start);
assert(start>=0&&end>start);
const calls=[],pet={sqv:0},options={force:true};
let locked=true;
const context={pet,rua:{on:false},KIT_EXPRESSIONS:['love'],FACE_TONES:{love:'heart'},
  sfx:{play:()=>calls.push('sound')},
  custom:{allowWord(w,o,session){calls.push(['allow',w,session]);return !!o?.force||!locked;},
    baseWord(w,o){calls.push(['parse',o]);return w;},actWord(){calls.push('act');return true;},
    kitHearts(){calls.push('hearts');}}};
vm.createContext(context);vm.runInContext(kit.slice(start,end)+'\nglobalThis.doWord=doWord;',context);
assert.equal(context.doWord('restore'),true);assert.equal(context.doWord('love'),true);
assert.equal(pet.sqv,0);assert.equal(calls.length,2);assert.equal(calls[0][2],true,'session remains active outside head');
calls.length=0;context.doWord('love',options);
assert(calls.some(c=>Array.isArray(c)&&c[0]==='parse'&&c[1]===options));
assert(calls.includes('hearts')&&calls.includes('sound'));assert.equal(pet.sqv,.8);
calls.length=0;locked=false;context.rua=null;context.doWord('love');assert(calls.includes('hearts'));
// Other figures need not implement allowWord and keep the previous behavior.
delete context.custom.allowWord;calls.length=0;context.doWord('love');assert(calls.includes('act'));

const app=fs.readFileSync(path.join(engine,'web/pet-app.js'),'utf8');
const up=app.match(/^const up = \(e\) => \{[^\n]+$/m)?.[0];assert(up);
const cancelStart=app.indexOf("stage.addEventListener('pointercancel', up);");
const cancelEnd=app.indexOf("\ndocument.addEventListener('pointerleave'",cancelStart);assert(cancelStart>=0&&cancelEnd>cancelStart);
const stageListeners={},windowListeners={},releases=[];
const appContext={stage:{style:{},addEventListener:(name,fn)=>stageListeners[name]=fn},
  window:{addEventListener:(name,fn)=>windowListeners[name]=fn},
  body:{pointer:(kind,p)=>releases.push({kind,p})},lastPointer:{x:10,y:20},performance:{now:()=>500}};
vm.createContext(appContext);
vm.runInContext('let pressing=true;\n'+up+'\n'+app.slice(cancelStart,cancelEnd),appContext);
windowListeners.blur();assert.equal(releases.length,1);assert.equal(releases[0].kind,'up');
stageListeners.lostpointercapture();assert.equal(releases.length,1,'cancel must not release twice');
vm.runInContext('pressing=true;',appContext);stageListeners.lostpointercapture();assert.equal(releases.length,2);
vm.runInContext('pressing=true;',appContext);stageListeners.pointercancel({clientX:30,clientY:40,timeStamp:600});
assert.equal(releases[2].p.x,30);assert.equal(releases[2].p.t,600);
console.log('PASS: real kit admission before parser/extras; force options; other figures; real pet-app blur/capture/cancel release.');
