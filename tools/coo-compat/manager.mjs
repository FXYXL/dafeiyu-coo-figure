/** Version-bound patch preparation/transactions. Never starts or stops Coo. */
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export const workspace=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
export const targets=['web/kit/body.js','web/body-host.js','web/figure-frame.js','web/pet-app.js',
  'src/script.ts','src/model-text.ts','src/chat.ts','src/packs.ts','src/world.ts','src/server.ts'];
export const assets=['web/music/probe.ps1','web/music/NAudio.dll','src/music-ear.ts'];
const managed=[...targets,...assets];
const stateName='.coo-compat-state.json';
export const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const digest=p=>fs.existsSync(p)?hash(fs.readFileSync(p)):null;
const writeJson=(p,value)=>atomicWrite(p,Buffer.from(JSON.stringify(value,null,2)+'\n'));
const defaultPack=()=>fs.existsSync(path.join(workspace,'runtime/origin.json'))?workspace:path.join(workspace,'repo');
const patchRelative=pack=>fs.existsSync(path.join(pack,'runtime/origin.json'))?'tools/patch-host-internal.mjs':'tools/patch-pet-kit.mjs';
function ownedRuntime(pack) {
  if(!fs.existsSync(path.join(pack,'runtime/origin.json')))return null;
  const origin=json(path.join(pack,'runtime/origin.json'));
  for(const [relative,expected] of Object.entries(origin.files))if(digest(safePath(path.join(pack,'runtime'),relative))!==expected)throw Error('随包 runtime 文件已损坏：'+relative);
  return origin;
}
function migrateHostKit(pack,before,stage) {
  const origin=ownedRuntime(pack);if(!origin)return;
  const current=before.files.find(e=>e.relative==='web/kit/body.js').hash;
  if(current===origin.upstreamBodyHash)return;
  if(current!==origin.files['kit/body.js']){
    if(/rua-word-admission-v1|custom\?\.baseWord|custom\?\.actWord|opts\.figure\?\.musicActive/.test(fs.readFileSync(path.join(stage,'web/kit/body.js'),'utf8')))throw Error('发现无法识别的旧全局 kit；请提供兼容报告适配，未恢复任何旧字节。');
    return; // A different upstream kit is left intact; host anchors and runtime bridge still must pass.
  }
  const identity=json(path.join(pack,'runtime/upstream/identity.json'));
  if(JSON.stringify(identity)!==JSON.stringify(before.identities))throw Error('旧全局 kit 的宿主基础源码不匹配，禁止恢复旧版本文件。');
  if(!before.installation.appRoot)throw Error('迁移旧全局 kit 必须传完整 Coo 安装目录，以核实其他已装大肥鱼包。');
  const figures=path.join(before.installation.appRoot,'data/home/companion/data/figures');
  if(fs.existsSync(figures))for(const entry of fs.readdirSync(figures,{withFileTypes:true})){
    if(!entry.isDirectory())continue;
    const dir=path.join(figures,entry.name),manifest=path.join(dir,'figure.json');if(!fs.existsSync(manifest))continue;
    const id=json(manifest).id;
    if(['deepseek-shenggong','deepseek-shenggong-hd'].includes(id)){
      ownedRuntime(dir);
      if(!fs.existsSync(path.join(dir,'runtime/origin.json'))||!fs.readFileSync(path.join(dir,'figure.js'),'utf8').includes("import('./runtime/kit/body.js')"))throw Error('请先同时升级已安装的标准版和 HD 形象包，再迁移全局 kit：'+id);
    }
  }
  const body=fs.readFileSync(path.join(pack,'runtime/upstream/body.js'));
  if(hash(body)!==origin.upstreamBodyHash)throw Error('随包原版 kit 校验失败');
  fs.writeFileSync(path.join(stage,'web/kit/body.js'),body);
}
function runtimeDependencies(installation) {
  if(!installation.appRoot)return [];
  const root=installation.appRoot,figures=path.join(root,'data/home/companion/data/figures'),result=[];
  if(fs.existsSync(figures))for(const e of fs.readdirSync(figures,{withFileTypes:true})){
    if(!e.isDirectory())continue;
    const dir=path.join(figures,e.name),manifest=path.join(dir,'figure.json');if(!fs.existsSync(manifest))continue;
    if(!['deepseek-shenggong','deepseek-shenggong-hd'].includes(json(manifest).id))continue;
    for(const f of ['figure.json','figure.js','runtime/origin.json','runtime/kit/body.js','runtime/kit/rig.js'])result.push({relative:path.relative(root,path.join(dir,f)).replaceAll('\\','/'),hash:digest(path.join(dir,f))});
  }
  return result.sort((a,b)=>a.relative.localeCompare(b.relative));
}
function assertRuntimeDependencies(report) {
  if(report.runtimeDependencies&&JSON.stringify(runtimeDependencies(report.before.installation))!==JSON.stringify(report.runtimeDependencies))throw Error('已安装形象包在检查后变化；请重新 prepare。');
}

export function safePath(root,relative) {
  if(typeof relative!=='string'||!relative||path.isAbsolute(relative)||relative.includes('\\')||relative.includes(':'))throw Error('Unsafe relative path: '+relative);
  const base=path.resolve(root),dest=path.resolve(base,relative),rel=path.relative(base,dest);
  if(!rel||rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel))throw Error('Path escapes root: '+relative);
  // Never follow junctions/symlinks, including a linked target root.
  let current=dest;
  while(true){if(fs.existsSync(current)&&fs.lstatSync(current).isSymbolicLink())throw Error('Linked path refused: '+current);const parent=path.dirname(current);if(parent===current)break;current=parent;}
  return dest;
}
function copy(from,to){fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(from,to);}
function inventory(root,paths){return paths.map(relative=>({relative,hash:digest(safePath(root,relative))}));}
function equalInventory(root,expected,label) {
  for(const item of expected)if(digest(safePath(root,item.relative))!==item.hash)throw Error(label+': '+item.relative);
}

export function resolveInstallation(input) {
  const supplied=path.resolve(input),suffix='resources/app/node_modules/cortico-world-desktop-pet';
  const engine=fs.existsSync(path.join(supplied,suffix))?path.join(supplied,suffix):supplied;
  if(!fs.existsSync(path.join(engine,'web/kit/body.js')))throw Error('找不到桌宠引擎，请用 --dir 指定 Coo 根目录或引擎目录。');
  safePath(engine,'web/kit/body.js');
  const candidate=path.resolve(engine,'../../../..');
  const appRoot=path.resolve(candidate,suffix)===engine&&fs.existsSync(path.join(candidate,'resources/app/package.json'))?candidate:null;
  return {engine,appRoot};
}
function walkSources(root) {
  if(!fs.existsSync(root))return [];
  const result=[];
  for(const entry of fs.readdirSync(root,{withFileTypes:true})){
    if(entry.isSymbolicLink())throw Error('Linked source directory refused: '+entry.name);
    const file=path.join(root,entry.name);
    if(entry.isDirectory())result.push(...walkSources(file));
    else if(/\.(?:[cm]?js|ts|json)$/.test(entry.name))result.push(file);
  }
  return result.sort();
}
function inspectEngineIdentity(engine) {
  const paths=['package.json',...walkSources(path.join(engine,'web')).concat(walkSources(path.join(engine,'src')))
    .map(p=>path.relative(engine,p).replaceAll('\\','/')).filter(p=>!managed.includes(p))];
  return inventory(engine,[...new Set(paths)].sort());
}
function coreHealth(appRoot) {
  if(!appRoot)return {scope:'engine-only',version:null,healthy:true,identity:[],missing:[],note:'仅引擎检查，未验证 Coo 主程序。'};
  const app=path.join(appRoot,'resources/app'),pkg=json(safePath(appRoot,'resources/app/package.json'));
  const required=['resources/app/package.json','resources/app/'+(pkg.main||'app/main.cjs'),
    'resources/app/app/core-host.cjs','resources/app/core/boot.ts','resources/app/node_modules/tsx/dist/loader.mjs',
    'resources/app/build/cortico/src/core/language.ts'];
  const missing=required.filter(p=>!fs.existsSync(safePath(appRoot,p))).map(relative=>({relative,reason:'required-file-missing'}));
  const root=path.join(app,'build/cortico/src'),sources=[...walkSources(root),...walkSources(path.join(app,'core'))];
  const outsideRuntime=[];
  // Static literal relative imports only. No Core execution, provider loading, or user configuration.
  for(const file of sources.filter(p=>/\.(?:[cm]?js|ts)$/.test(p))){
    const source=fs.readFileSync(file,'utf8').replace(/^import\s+type\b[\s\S]*?;[ \t]*(?:\r?\n|$)/gm,'');
    const matches=source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)(['"])(\.[^'"\r\n]+)\1/g);
    for(const match of matches){
      const spec=match[2];if(!/\.(?:[cm]?js|ts|json)$/.test(spec))continue;
      const dest=path.resolve(path.dirname(file),spec);
      if(!fs.existsSync(dest)){
        const issue={relative:path.relative(appRoot,dest).replaceAll('\\','/'),importer:path.relative(appRoot,file).replaceAll('\\','/'),reason:'relative-import-missing'};
        // The shipped tree also contains CLI launchers whose ../bin assets are intentionally
        // absent from the app build. Report those separately, not as a Core boot failure.
        if(dest.startsWith(root+path.sep)||dest.startsWith(path.join(app,'core')+path.sep))missing.push(issue);
        else outsideRuntime.push(issue);
      }
    }
  }
  const paths=[...new Set([...required,...sources.map(p=>path.relative(appRoot,p).replaceAll('\\','/'))])].sort();
  return {scope:'coo-installation',version:pkg.version,channel:pkg.coopanion?.channel,healthy:!missing.length,missing,outsideRuntime,identity:inventory(appRoot,paths)};
}

function logSignals(appRoot,logsDir) {
  const candidates=[logsDir,appRoot&&path.join(appRoot,'data/logs'),process.env.APPDATA&&path.join(process.env.APPDATA,'Coopanion/logs')].filter(Boolean);
  const dir=candidates.find(p=>fs.existsSync(p));
  if(!dir)return {available:false,note:'未发现日志目录，可用 --logs 显式指定。'};
  const signals=[];
  for(const name of ['core.log','updater.log']){
    const file=path.join(dir,name);if(!fs.existsSync(file))continue;
    const fd=fs.openSync(file,'r');let content;
    try{const size=fs.fstatSync(fd).size,bytes=Buffer.alloc(Math.min(size,128*1024));fs.readSync(fd,bytes,0,bytes.length,Math.max(0,size-bytes.length));content=bytes.toString('utf8');}finally{fs.closeSync(fd);}
    for(const [code,pattern] of [['module-not-found',/ERR_MODULE_NOT_FOUND/g],['capture-compile-error',/Add-Type/g],['install-requested',/quitAndInstall/g],['core-ready',/companion:ready/g]]){
      const count=[...content.matchAll(pattern)].length;if(count)signals.push({file:name,code,count});
    }
  }
  return {available:true,signals,note:'仅统计日志末尾的历史信号，不含用户对话或密钥，不代表当前仍故障；不能仅凭旧日志自动回退。'};
}

export function processBlockers(rows,{appRoot,engine}) {
  const norm=s=>String(s||'').replaceAll('\\','/').toLowerCase();
  const roots=[appRoot,engine].filter(Boolean).map(norm);
  const result=[];
  for(const p of rows){
    if(Number(p.ProcessId)===process.pid)continue;
    const name=norm(p.Name),exe=norm(p.ExecutablePath),cmd=norm(p.CommandLine);
    const inRoot=roots.some(root=>{
      if(exe.startsWith(root+'/'))return true;
      let at=-1;while((at=cmd.indexOf(root,at+1))>=0){const next=cmd[at+root.length];if(next===undefined||/[\/"\s]/.test(next))return true;}return false;
    });
    const installer=/(?:setup|updat|install|\.tmp$)/.test(name)&&(/coopanion|coo[ -]?setup/.test(exe+' '+cmd)||inRoot);
    if(installer||inRoot&&/(?:coopanion|electron|node)/.test(name))result.push({pid:Number(p.ProcessId),name:p.Name,reason:installer?'更新安装器仍在运行':'Coo 或其后台进程仍在运行'});
  }
  const blocked=new Set(result.map(p=>p.pid));
  let grew=true;while(grew){grew=false;for(const p of rows)if(blocked.has(Number(p.ParentProcessId))&&!blocked.has(Number(p.ProcessId))&&Number(p.ProcessId)!==process.pid){blocked.add(Number(p.ProcessId));result.push({pid:Number(p.ProcessId),name:p.Name,reason:'Coo/安装器的子进程仍在运行'});grew=true;}}
  return result;
}
export function queryProcesses(installation) {
  if(process.platform!=='win32')throw Error('写入前的进程检查当前只支持 Windows。');
  const script='Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress';
  const r=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true,timeout:20000,maxBuffer:12*1024*1024});
  if(r.status!==0)throw Error('无法核实 Coo/安装器进程状态，未写入。');
  const data=JSON.parse(r.stdout||'[]');return processBlockers(Array.isArray(data)?data:[data],installation);
}

function command(command,args,logFile) {
  const r=spawnSync(command,args,{encoding:'utf8',windowsHide:true,timeout:60000,maxBuffer:8*1024*1024});
  if(logFile)fs.writeFileSync(logFile,(r.stdout||'')+(r.stderr||'')+(r.error?'\n'+r.error.message:''));
  return {ok:r.status===0&&!r.error,status:r.status,error:r.error?.message};
}
function run(script,args,logFile){return command(process.execPath,[script,...args],logFile);}

export function inspect({dir,pack=defaultPack(),logs}) {
  const installation=resolveInstallation(dir),health=coreHealth(installation.appRoot);
  const files=inventory(installation.engine,managed),requiredMissing=files.filter(f=>targets.includes(f.relative)&&f.hash===null).map(f=>f.relative);
  const runtime=ownedRuntime(pack);
  const patcher=path.resolve(pack,patchRelative(pack));
  const check=command(process.execPath,[patcher,'--dir='+installation.engine,'--check']);
  const identities=inspectEngineIdentity(installation.engine);
  const fingerprint=hash(JSON.stringify({health:health.identity,files,identities,state:digest(path.join(installation.engine,stateName))}));
  return {schema:1,installation,health,files,identities,fingerprint,requiredMissing,
    patchStatus:check.ok&&(!runtime||files.find(e=>e.relative==='web/kit/body.js').hash!==runtime.files['kit/body.js'])?'applied':'missing-or-mismatched',legacyTransaction:fs.existsSync(path.join(installation.engine,'.petkit-transaction.json')),
    runtimeTrial:!!installation.appRoot&&fs.existsSync(path.join(installation.appRoot,'.coo-runtime-trial.json')),
    logSignals:logSignals(installation.appRoot,logs),note:'补丁标记检查不等于运行正常。prepare 会在隔离副本执行语法和真实消息入口回归。'};
}

export function prepare({dir,pack=defaultPack(),out,liveProbe=true,logs}) {
  if(Number(process.versions.node.split('.')[0])<24)throw Error('兼容工具需要 Node.js 24 或更新；旧版随包补丁不受此限制影响。');
  const reportDir=path.resolve(out||path.join(workspace,'test-runs/coo-compat',new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8)));
  if(fs.existsSync(reportDir))throw Error('输出目录必须是新目录，避免覆盖已有快照。');
  const installation=resolveInstallation(dir);
  if([installation.engine,installation.appRoot].filter(Boolean).some(root=>{const rel=path.relative(root,reportDir);return !rel||rel!=='..'&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel);}))throw Error('检查输出不能放在 Coo 安装目录内。');
  fs.mkdirSync(reportDir,{recursive:true});
  const report={schema:1,id:randomUUID(),createdAt:new Date().toISOString(),status:'preparing',checks:[],reportDir};
  const save=()=>writeJson(path.join(reportDir,'report.json'),report);
  try {
    const before=inspect({dir,pack,logs});report.before=before;save();
    if(before.runtimeTrial&&!ownedRuntime(pack))throw Error('当前处于随包 kit 真机试用；不要重新套用完整旧补丁。请先用 coo-runtime-trial.mjs 检查或回退此次试用。');
    const manifest=json(path.resolve(pack,'figure.json'));report.pack={id:manifest.id,version:manifest.version};
    if(!before.health.healthy||before.requiredMissing.length)throw Error('Coo 安装文件不完整，先修复原程序；未尝试打补丁。');
    const capsule=path.join(reportDir,'capsule'),stage=path.join(reportDir,'staged-engine');
    for(const relative of managed)if(fs.existsSync(safePath(installation.engine,relative)))copy(safePath(installation.engine,relative),safePath(stage,relative));
    writeJson(path.join(stage,'package.json'),{type:'module'});
    for(const relative of ['figure.json',patchRelative(pack),'tools/music/probe.ps1','tools/music/NAudio.dll','tools/music/music-ear.ts',
      'tools/test-music-bridge.mjs','tools/test-interaction-kit.mjs','tools/test-music-probe-live.mjs'])copy(safePath(path.resolve(pack),relative),safePath(capsule,relative));
    if(ownedRuntime(pack)){
      for(const relative of ['runtime/origin.json','runtime/kit/body.js','runtime/kit/rig.js','runtime/upstream/body.js','runtime/upstream/identity.json'])copy(safePath(path.resolve(pack),relative),safePath(capsule,relative));
      migrateHostKit(capsule,before,stage);
      for(const name of ['test-music-bridge.mjs','test-interaction-kit.mjs']){
        const file=path.join(capsule,'tools',name),source=fs.readFileSync(file,'utf8'),anchor="fs.readFileSync(path.join(engine,'web/kit/body.js'),'utf8')";
        const own="fs.readFileSync(new URL('../runtime/kit/body.js',import.meta.url),'utf8')";
        if(source.includes(own))continue;
        if(source.split(anchor).length!==2)throw Error('runtime 回归测试入口变化：'+name);
        fs.writeFileSync(file,source.replace(anchor,own));
      }
      report.runtimeProfile='pack-owned-kit';
      report.runtimeDependencies=runtimeDependencies(before.installation);
    }
    const capsuleFiles=walkSources(capsule).map(p=>path.relative(capsule,p).replaceAll('\\','/'));
    capsuleFiles.push('tools/music/NAudio.dll','tools/music/probe.ps1');
    report.capsule=inventory(capsule,[...new Set(capsuleFiles)].sort());
    function check(name,fn){const result=fn();report.checks.push({name,...result});save();if(!result.ok)throw Error('隔离检查失败：'+name+'（见报告目录日志）');}
    const patcher=path.join(capsule,patchRelative(capsule));
    // Deliberately omit legacy .bak/.petkit-transaction from the stage: each preparation owns a new generation.
    check('patch-prepare',()=>run(patcher,['--dir='+stage,'--compat-stage'],path.join(reportDir,'patch-prepare.log')));
    check('patch-check',()=>run(patcher,['--dir='+stage,'--check'],path.join(reportDir,'patch-check.log')));
    const patched=inventory(stage,managed);
    check('patch-idempotence',()=>{const result=run(patcher,['--dir='+stage,'--compat-stage'],path.join(reportDir,'patch-repeat.log'));equalInventory(stage,patched,'重复应用改变文件');return result;});
    const syntax=[];
    for(const relative of managed.filter(p=>/\.(js|ts)$/.test(p))){const log='syntax-'+path.basename(relative)+'.log';syntax.push({relative,log,...command(process.execPath,['--check',safePath(stage,relative)],path.join(reportDir,log))});}
    writeJson(path.join(reportDir,'syntax.json'),syntax);
    check('javascript-typescript-syntax',()=>({ok:syntax.every(s=>s.ok)}));
    check('host-frame-music-bridge',()=>run(path.join(capsule,'tools/test-music-bridge.mjs'),[stage],path.join(reportDir,'music-bridge.log')));
    check('rua-admission-cancel',()=>run(path.join(capsule,'tools/test-interaction-kit.mjs'),[stage],path.join(reportDir,'interaction.log')));
    if(liveProbe)check('powershell-wasapi',()=>run(path.join(capsule,'tools/test-music-probe-live.mjs'),[path.join(stage,'web/music/probe.ps1')],path.join(reportDir,'wasapi.log')));
    else report.checks.push({name:'powershell-wasapi',ok:false,skipped:true});
    const afterSource=inspect({dir,pack});
    if(before.fingerprint!==afterSource.fingerprint)throw Error('检查期间安装目录发生变化，可能正在更新；本次方案作废。');
    report.changes=patched.filter(p=>p.hash!==before.files.find(f=>f.relative===p.relative).hash).map(p=>({relative:p.relative,beforeHash:before.files.find(f=>f.relative===p.relative).hash,afterHash:p.hash}));
    report.staged=patched;report.status=liveProbe?'prepared':'offline-checked';report.limitations=['未启动完整 Coo，未执行真实 AI 对话或桌面窗口验收。','语法/入口检查不能覆盖上游所有行为变化。'];
    // Bind plan + staged content to the source fingerprint, not just a marketing version number.
    assertRuntimeDependencies(report);
    report.planHash=hash(JSON.stringify({fingerprint:before.fingerprint,staged:patched,capsule:report.capsule,changes:report.changes,runtimeDependencies:report.runtimeDependencies}));
    save();return report;
  }catch(e){report.status='blocked';report.error=e.message;save();return report;}
}

function loadPrepared(reportDir) {
  const root=path.resolve(reportDir),report=json(path.join(root,'report.json'));
  if(report.schema!==1||report.status!=='prepared')throw Error('该报告没有通过完整隔离检查；不能应用。');
  if(report.reportDir!==root)throw Error('报告目录已移动，需重新准备。');
  if(!Array.isArray(report.staged)||report.staged.length!==managed.length||new Set(report.staged.map(p=>p.relative)).size!==managed.length||report.staged.some(p=>!managed.includes(p.relative)))throw Error('报告目标清单损坏。');
  if(!Array.isArray(report.changes)||report.changes.some(p=>!managed.includes(p.relative)))throw Error('报告修改清单损坏。');
  const expected=hash(JSON.stringify({fingerprint:report.before.fingerprint,staged:report.staged,capsule:report.capsule,changes:report.changes,runtimeDependencies:report.runtimeDependencies}));
  if(report.planHash!==expected)throw Error('方案内容已变化，需重新检查。');
  equalInventory(path.join(root,'staged-engine'),report.staged,'候选文件被修改');
  equalInventory(path.join(root,'capsule'),report.capsule,'检查工具或补丁资源被修改');
  return report;
}
function assertStopped(installation,processQuery) {
  const blockers=processQuery(installation);
  if(blockers.length)throw Error('请先完全退出 Coo，并等待更新安装结束：'+blockers.map(p=>p.name+' PID '+p.pid).join('、'));
}
export function atomicWrite(file,bytes) {
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const temp=file+'.compat-'+randomUUID()+'.tmp';
  try{fs.writeFileSync(temp,bytes,{flag:'wx'});fs.renameSync(temp,file);}finally{fs.rmSync(temp,{force:true});}
}
function restoreBytes(root,backupDir,entries) {
  for(const item of entries){const dest=safePath(root,item.relative);if(item.beforeHash===null)fs.rmSync(dest,{force:true});else atomicWrite(dest,fs.readFileSync(safePath(backupDir,item.relative)));}
}

function assertGeneration(installation,identity,engineIdentity) {
  const health=coreHealth(installation.appRoot);
  if(JSON.stringify(health.identity)!==JSON.stringify(identity))throw Error('Coo 主程序文件在操作期间变化。');
  const current=inspectEngineIdentity(installation.engine);
  if(JSON.stringify(current)!==JSON.stringify(engineIdentity))throw Error('引擎基础文件在操作期间变化');
}

function applyPrepared({reportDir,processQuery=queryProcesses}) {
  const report=loadPrepared(reportDir),{engine}=report.before.installation;
  assertStopped(report.before.installation,processQuery);
  assertRuntimeDependencies(report);
  if(inspect({dir:engine}).fingerprint!==report.before.fingerprint)throw Error('Coo 版本或文件已变化；必须重新 prepare，未写入。');
  if(!report.changes.length)return {status:'already-applied',reportDir};
  const marker=safePath(engine,stateName),backup=path.join(reportDir,'before'),entries=report.changes;
  const previousState=fs.existsSync(marker)?fs.readFileSync(marker).toString('base64'):null;
  for(const entry of entries)if(entry.beforeHash!==null){copy(safePath(engine,entry.relative),safePath(backup,entry.relative));if(digest(safePath(backup,entry.relative))!==entry.beforeHash)throw Error('备份内容与准备时不符：'+entry.relative);}
  const stagedBytes=new Map(entries.map(entry=>{const bytes=fs.readFileSync(safePath(path.join(reportDir,'staged-engine'),entry.relative));if(hash(bytes)!==entry.afterHash)throw Error('候选文件已变化：'+entry.relative);return [entry.relative,bytes];}));
  const transaction={schema:1,id:report.id,engine,appRoot:report.before.installation.appRoot,cooVersion:report.before.health.version,
    identity:report.before.health.identity,engineIdentity:report.before.identities,staged:report.staged,changes:entries,previousState,status:'writing',createdAt:new Date().toISOString()};
  const journal=path.join(reportDir,'transaction.json');writeJson(journal,transaction);
  // Check again after backups, before the first installation write.
  assertStopped(report.before.installation,processQuery);
  if(inspect({dir:engine}).fingerprint!==report.before.fingerprint)throw Error('备份期间安装目录发生变化；未写入。');
  assertRuntimeDependencies(report);
  let markerWritten=false;
  try {
    atomicWrite(marker,Buffer.from(JSON.stringify({schema:1,id:report.id,reportDir:path.resolve(reportDir),status:'writing'})));markerWritten=true;
    for(const entry of entries){const dest=safePath(engine,entry.relative);if(digest(dest)!==entry.beforeHash)throw Error('写入前目标发生变化：'+entry.relative);atomicWrite(dest,stagedBytes.get(entry.relative));}
    equalInventory(engine,report.staged,'写入后的内容校验失败');
    assertGeneration(report.before.installation,report.before.health.identity,report.before.identities);
    const checked=run(path.join(reportDir,'capsule',patchRelative(path.join(reportDir,'capsule'))),['--dir='+engine,'--check'],path.join(reportDir,'installed-check.log'));
    if(!checked.ok)throw Error('安装目录补丁复核失败');
    transaction.status='applied';transaction.appliedAt=new Date().toISOString();writeJson(journal,transaction);
    atomicWrite(marker,Buffer.from(JSON.stringify({schema:1,id:report.id,reportDir:path.resolve(reportDir),status:'applied'})));
    return {status:'applied',files:entries.length,reportDir,restarted:false};
  }catch(e){
    try{
      assertGeneration(report.before.installation,report.before.health.identity,report.before.identities);
      for(const entry of entries){const installed=digest(safePath(engine,entry.relative));if(installed!==entry.beforeHash&&installed!==entry.afterHash)throw Error('文件被其他程序修改，停止自动恢复：'+entry.relative);}
      restoreBytes(engine,backup,entries);if(markerWritten){if(previousState===null)fs.rmSync(marker,{force:true});else atomicWrite(marker,Buffer.from(previousState,'base64'));}transaction.status='rolled-back-after-error';
    }
    catch(recovery){transaction.status='recovery-required';transaction.recoveryError=recovery.message;}
    transaction.error=e.message;writeJson(journal,transaction);throw Error(e.message+'；恢复状态：'+transaction.status+'，报告：'+reportDir);
  }
}

function revertTransaction({reportDir,processQuery=queryProcesses}) {
  const root=path.resolve(reportDir),t=json(path.join(root,'transaction.json'));
  if(t.schema!==1||!['applied','writing','reverting'].includes(t.status))throw Error('此事务没有可回退的应用记录。');
  if(!Array.isArray(t.changes)||t.changes.some(p=>!managed.includes(p.relative)))throw Error('事务包含未知文件。');
  if(!Array.isArray(t.staged)||t.staged.length!==managed.length||t.staged.some(p=>!managed.includes(p.relative)))throw Error('事务缺少完整目标指纹。');
  const installation=resolveInstallation(t.engine);assertStopped(installation,processQuery);
  const marker=safePath(t.engine,stateName),current=json(marker);
  if(current.id!==t.id||current.reportDir!==root)throw Error('当前安装对应另一次补丁事务；拒绝覆盖。');
  const health=coreHealth(installation.appRoot);
  if(health.version!==t.cooVersion)throw Error('Coo 已更新，禁止跨版本回退。');
  if(JSON.stringify(health.identity)!==JSON.stringify(t.identity))throw Error('Coo 主程序文件清单或内容已变化，禁止回退。');
  if(installation.appRoot)equalInventory(installation.appRoot,t.identity,'Coo 主程序文件已变化，禁止回退');
  if(JSON.stringify(inspectEngineIdentity(t.engine))!==JSON.stringify(t.engineIdentity))throw Error('引擎基础文件已变化，禁止回退');
  for(const entry of t.staged){
    const changed=t.changes.find(p=>p.relative===entry.relative),installed=digest(safePath(t.engine,entry.relative));
    if(installed!==entry.hash&&!(changed&&['writing','reverting'].includes(t.status)&&installed===changed.beforeHash))throw Error('安装文件已被更新或修改，拒绝回退：'+entry.relative);
  }
  for(const entry of t.changes){
    const installed=digest(safePath(t.engine,entry.relative));
    if(installed!==entry.afterHash&&!(['writing','reverting'].includes(t.status)&&installed===entry.beforeHash))throw Error('安装文件已被更新或修改，拒绝回退：'+entry.relative);
    if(entry.beforeHash!==null&&digest(safePath(path.join(root,'before'),entry.relative))!==entry.beforeHash)throw Error('回退备份损坏：'+entry.relative);
  }
  // Keep current bytes so an ordinary write failure during revert can itself be undone.
  const recovery=path.join(root,'pre-revert');
  const oldMarker=fs.readFileSync(marker);
  const before=t.changes.map(entry=>{const file=safePath(t.engine,entry.relative),h=digest(file);if(h!==null)copy(file,safePath(recovery,entry.relative));return {...entry,beforeHash:h};});
  const previousStatus=t.status;
  t.status='reverting';writeJson(path.join(root,'transaction.json'),t);
  try {
    for(const entry of t.changes){
      const dest=safePath(t.engine,entry.relative),was=before.find(p=>p.relative===entry.relative);
      if(digest(dest)!==was.beforeHash)throw Error('回退时文件被其他程序修改：'+entry.relative);
      if(entry.beforeHash===null)fs.rmSync(dest,{force:true});else atomicWrite(dest,fs.readFileSync(safePath(path.join(root,'before'),entry.relative)));
    }
    assertGeneration(installation,t.identity,t.engineIdentity);
    if(t.previousState===null)fs.rmSync(marker,{force:true});else atomicWrite(marker,Buffer.from(t.previousState,'base64'));
    t.status='reverted';t.revertedAt=new Date().toISOString();writeJson(path.join(root,'transaction.json'),t);
    return {status:'reverted',restarted:false};
  }catch(e){
    try{
      assertGeneration(installation,t.identity,t.engineIdentity);
      for(const entry of t.changes){const installed=digest(safePath(t.engine,entry.relative)),was=before.find(p=>p.relative===entry.relative);if(installed!==entry.beforeHash&&installed!==was.beforeHash)throw Error('回退时检测到第三方修改：'+entry.relative);}
      restoreBytes(t.engine,recovery,before);atomicWrite(marker,oldMarker);t.status=previousStatus;
    }catch(recoveryError){t.status='recovery-required';t.recoveryError=recoveryError.message;}
    t.error=e.message;writeJson(path.join(root,'transaction.json'),t);throw Error(e.message+'；恢复状态：'+t.status);
  }
}

export function withInstallationLock(engine,fn) {
  const lock=safePath(engine,'.coo-compat-lock.json');
  if(fs.existsSync(lock)){
    let owner;try{owner=json(lock);}catch{throw Error('补丁锁损坏，停止写入：'+lock);}
    let alive=true;
    try{process.kill(owner.pid,0);}catch(e){if(e.code==='ESRCH')alive=false;}
    if(alive)throw Error('已有兼容工具在操作安装目录，PID '+owner.pid);
    fs.rmSync(lock); // Only reclaim a lock whose owner is confirmed absent.
  }
  const fd=fs.openSync(lock,'wx');
  try{fs.writeFileSync(fd,JSON.stringify({pid:process.pid,createdAt:new Date().toISOString()}));return fn();}
  finally{fs.closeSync(fd);fs.rmSync(lock,{force:true});}
}
export function apply(options) {
  const report=loadPrepared(options.reportDir);
  assertStopped(report.before.installation,options.processQuery||queryProcesses);
  return withInstallationLock(report.before.installation.engine,()=>applyPrepared(options));
}
export function revert(options) {
  const t=json(path.join(path.resolve(options.reportDir),'transaction.json'));
  const installation=resolveInstallation(t.engine);
  assertStopped(installation,options.processQuery||queryProcesses);
  return withInstallationLock(t.engine,()=>revertTransaction(options));
}
