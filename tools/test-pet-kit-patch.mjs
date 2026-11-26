/** Release installer integration tests on disposable Coo trees. Never alters installed Coo. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {inspect,prepare,apply,revert,targets,assets,hash,processBlockers} from './coo-compat/manager.mjs';
const pack=path.resolve(import.meta.dirname,'..');
const arg=n=>process.argv.find(a=>a.startsWith('--'+n+'='))?.slice(n.length+3);
if(!arg('engine'))throw Error('Pass --engine=<read-only original engine>');
const source=path.resolve(arg('engine')),out=path.resolve(arg('out')||'patch-tests-'+Date.now());
if(fs.existsSync(out))throw Error('Use a new output directory');fs.mkdirSync(out,{recursive:true});
const app=path.join(out,'Coopanion'),engine=path.join(app,'resources/app/node_modules/cortico-world-desktop-pet');
fs.cpSync(source,engine,{recursive:true});
const put=(p,b)=>{fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,b);};
for(const relative of ['resources/app/app/main.cjs','resources/app/app/core-host.cjs','resources/app/core/boot.ts','resources/app/node_modules/tsx/dist/loader.mjs','resources/app/build/cortico/src/core/language.ts'])put(path.join(app,relative),'// fixture\n');
put(path.join(app,'resources/app/package.json'),JSON.stringify({version:'0.2.release-fixture',main:'app/main.cjs'}));
const checks=[],noProcesses=()=>[],paths=[...targets,...assets,'.coo-compat-state.json'];
const snapshot=()=>paths.map(p=>fs.existsSync(path.join(engine,p))?hash(fs.readFileSync(path.join(engine,p))):null);
const base=snapshot(),identity=inspect({dir:app,pack}).identities;
const blocked=(fn,re)=>{const before=snapshot();assert.throws(fn,re);assert.deepEqual(snapshot(),before);};
const plan=prepare({dir:app,pack,out:path.join(out,'fresh')});assert.equal(plan.status,'prepared',plan.error);checks.push('fresh host-only preparation, syntax, real WASAPI, real wrapper/host/frame and rua');
const originalBody=fs.readFileSync(path.join(engine,'web/kit/body.js'));
blocked(()=>apply({reportDir:plan.reportDir,processQuery:()=>[{name:'Coopanion.exe',pid:1}]}),/退出 Coo/);checks.push('running app blocks writes');
const candidate=path.join(plan.reportDir,'staged-engine/web/body-host.js'),saved=fs.readFileSync(candidate);fs.appendFileSync(candidate,'// bad');blocked(()=>apply({reportDir:plan.reportDir,processQuery:noProcesses}),/候选文件/);fs.writeFileSync(candidate,saved);checks.push('tampered staged bytes blocked');
apply({reportDir:plan.reportDir,processQuery:noProcesses});assert.deepEqual(fs.readFileSync(path.join(engine,'web/kit/body.js')),originalBody);assert.equal(inspect({dir:app,pack}).patchStatus,'applied');checks.push('fresh apply leaves original host kit unchanged');
const repeat=prepare({dir:app,pack,out:path.join(out,'repeat'),liveProbe:false});assert.equal(repeat.status,'offline-checked',repeat.error);assert.equal(repeat.changes.length,0);checks.push('idempotent host-only preparation');
blocked(()=>apply({reportDir:repeat.reportDir,processQuery:noProcesses}),/完整隔离检查/);checks.push('offline cannot apply');
const pkg=path.join(app,'resources/app/package.json'),pkgBytes=fs.readFileSync(pkg);fs.writeFileSync(pkg,JSON.stringify({version:'new-version',main:'app/main.cjs'}));blocked(()=>revert({reportDir:plan.reportDir,processQuery:noProcesses}),/跨版本/);fs.writeFileSync(pkg,pkgBytes);checks.push('cross-version rollback rejected');
const core=path.join(app,'resources/app/build/cortico/src/core/language.ts');fs.appendFileSync(core,'// changed');blocked(()=>revert({reportDir:plan.reportDir,processQuery:noProcesses}),/主程序文件/);fs.writeFileSync(core,'// fixture\n');checks.push('same-version core drift rejected');
const backup=path.join(plan.reportDir,'before',plan.changes.find(e=>e.beforeHash!==null).relative),backupBytes=fs.readFileSync(backup);fs.appendFileSync(backup,'bad');blocked(()=>revert({reportDir:plan.reportDir,processQuery:noProcesses}),/备份损坏/);fs.writeFileSync(backup,backupBytes);checks.push('damaged backup rejected before rollback');
revert({reportDir:plan.reportDir,processQuery:noProcesses});assert.deepEqual(snapshot(),base);checks.push('exact rollback including new audio assets');
let injected=false;const nativeRename=fs.renameSync;
try{fs.renameSync=function(from,to){if(!injected&&to===path.join(engine,plan.changes[1].relative)){injected=true;throw Error('simulated write failure');}return nativeRename(from,to);};blocked(()=>apply({reportDir:plan.reportDir,processQuery:noProcesses}),/rolled-back-after-error/);}finally{fs.renameSync=nativeRename;}
assert(injected);checks.push('write failure restores all original bytes');
// Missing host anchor must not affect the actual source.
const hostFile=path.join(engine,'web/figure-frame.js'),hostBytes=fs.readFileSync(hostFile);fs.writeFileSync(hostFile,hostBytes.toString().replace('body.step(m.dt, m.draw);','body.step(0);'));
const beforeBroken=snapshot(),bad=prepare({dir:app,pack,out:path.join(out,'bad-host'),liveProbe:false});assert.equal(bad.status,'blocked');assert.deepEqual(snapshot(),beforeBroken);fs.writeFileSync(hostFile,hostBytes);checks.push('missing host anchor blocks without writes');
// Upgrade from the exact old global kit. Both installed packages must be upgraded first.
fs.writeFileSync(path.join(engine,'web/kit/body.js'),fs.readFileSync(path.join(pack,'runtime/kit/body.js')));
const legacyManifest=path.join(app,'data/home/companion/data/figures/legacy/figure.json');put(legacyManifest,JSON.stringify({id:'deepseek-shenggong-hd',version:'1.6.19'}));
const legacy=prepare({dir:app,pack,out:path.join(out,'legacy-pack'),liveProbe:false});assert.equal(legacy.status,'blocked');assert.match(legacy.error,/同时升级/);checks.push('old installed HD blocks global-kit migration');
const installed=path.dirname(legacyManifest);fs.writeFileSync(legacyManifest,JSON.stringify({id:'deepseek-shenggong-hd',version:'1.6.20'}));fs.copyFileSync(path.join(pack,'figure.js'),path.join(installed,'figure.js'));fs.cpSync(path.join(pack,'runtime'),path.join(installed,'runtime'),{recursive:true});
assert.deepEqual(inspect({dir:app,pack}).identities,identity);
const migration=prepare({dir:app,pack,out:path.join(out,'migration')});assert.equal(migration.status,'prepared',migration.error);assert.equal(migration.staged.find(e=>e.relative==='web/kit/body.js').hash,hash(originalBody));
const figure=path.join(installed,'figure.js'),figureBytes=fs.readFileSync(figure);fs.appendFileSync(figure,'// changed');blocked(()=>apply({reportDir:migration.reportDir,processQuery:noProcesses}),/形象包/);fs.writeFileSync(figure,figureBytes);checks.push('installed pack drift blocks prepared migration');
apply({reportDir:migration.reportDir,processQuery:noProcesses});assert.deepEqual(fs.readFileSync(path.join(engine,'web/kit/body.js')),originalBody);checks.push('known global-kit upgrade restores matching upstream kit');
revert({reportDir:migration.reportDir,processQuery:noProcesses});assert.equal(hash(fs.readFileSync(path.join(engine,'web/kit/body.js'))),hash(fs.readFileSync(path.join(pack,'runtime/kit/body.js'))));checks.push('migration rollback restores old global state');
const rig=path.join(engine,'web/kit/rig.js'),rigBytes=fs.readFileSync(rig);fs.appendFileSync(rig,'// new upstream');const drift=prepare({dir:app,pack,out:path.join(out,'upstream-drift'),liveProbe:false});assert.equal(drift.status,'blocked');assert.match(drift.error,/基础源码不匹配/);fs.writeFileSync(rig,rigBytes);checks.push('changed upstream identity refuses historical kit restore');
const legacyBody=path.join(engine,'web/kit/body.js'),knownBody=fs.readFileSync(legacyBody);fs.appendFileSync(legacyBody,'// unknown old patch bytes');
const unknown=prepare({dir:app,pack,out:path.join(out,'unknown-kit'),liveProbe:false});assert.equal(unknown.status,'blocked');assert.match(unknown.error,/无法识别/);assert.equal(fs.readFileSync(legacyBody,'utf8'),knownBody.toString()+'// unknown old patch bytes');fs.writeFileSync(legacyBody,knownBody);checks.push('unknown old global kit rejected without overwriting it');
// Public entry and raw worker reject unsafe paths/legacy revert before installed writes.
const run=(file,args)=>spawnSync(process.execPath,[path.join(pack,'tools',file),...args],{encoding:'utf8',timeout:60000});
assert.notEqual(run('patch-pet-kit.mjs',['--revert']).status,0);assert.notEqual(run('patch-host-internal.mjs',['--dir='+engine]).status,0);checks.push('public revert requires report; direct worker writes refused');
const cliReport=path.join(out,'public-cli'),beforeCli=snapshot();
const cli=run('patch-pet-kit.mjs',['--dir='+app,'--out='+cliReport]);assert.equal(cli.status,0,cli.stdout+cli.stderr);
assert.equal(run('patch-pet-kit.mjs',['--dir='+app,'--check']).status,0);
const cliRevert=run('patch-pet-kit.mjs',['--revert','--report='+cliReport]);assert.equal(cliRevert.status,0,cliRevert.stdout+cliRevert.stderr);assert.deepEqual(snapshot(),beforeCli);checks.push('public CLI performs live prepare/apply/check/revert on disposable installation');
const processRows=processBlockers([{ProcessId:3,Name:'Coopanion.exe',ExecutablePath:path.join(app,'Coopanion.exe')},{ProcessId:4,ParentProcessId:3,Name:'helper.exe'},{ProcessId:5,Name:'Coopanion Setup.exe',ExecutablePath:'C:/Temp/Coopanion Setup.exe'}],{appRoot:app,engine});assert.equal(processRows.length,3);checks.push('app, updater and helper processes identified');
const result={passed:true,checks,pack,out};fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
