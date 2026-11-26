#!/usr/bin/env node
/** Public, version-bound host patch entry. Copied to both packs as patch-pet-kit.mjs. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {inspect,prepare,apply,revert,resolveInstallation,queryProcesses} from './coo-compat/manager.mjs';
const pack=path.resolve(import.meta.dirname,'..');
const arg=n=>process.argv.find(a=>a.startsWith('--'+n+'='))?.slice(n.length+3);
try{
  if(Number(process.versions.node.split('.')[0])<24)throw Error('请安装 Node.js 24 或更新版本。');
  if(process.argv.includes('--help')){
    console.log('node tools/patch-pet-kit.mjs --dir="Coo安装目录" [--check | --prepare | --revert --report="本次报告目录"]\n默认：退出Coo后，隔离检查、备份、应用宿主39项补丁，不重启Coo。\n--check 只读；--prepare 只准备；回退必须指定本次报告，不使用历史.bak。');
    process.exit(0);
  }
  if(process.argv.includes('--revert')){
    if(!arg('report'))throw Error('回退必须提供 --report="本次已应用报告目录"；禁止使用历史全局备份。');
    console.log(JSON.stringify(revert({reportDir:path.resolve(arg('report'))}),null,2));
  }else{
    const dir=arg('dir')||[process.env.LOCALAPPDATA&&path.join(process.env.LOCALAPPDATA,'Programs/Coopanion'),'C:/Program Files/Coopanion','C:/Program Files (x86)/Coopanion','D:/Coopanion','E:/Coopanion'].filter(Boolean).find(p=>fs.existsSync(path.join(p,'resources/app/node_modules/cortico-world-desktop-pet')));
    if(!dir)throw Error('未发现 Coo；请提供 --dir="实际安装目录"。');
    if(process.argv.includes('--check')){
      const result=inspect({dir,pack});
      console.log(JSON.stringify({cooVersion:result.health.version,healthy:result.health.healthy,patchStatus:result.patchStatus,runtime:'pack-owned-kit',requiredMissing:result.requiredMissing},null,2));
      if(result.patchStatus!=='applied'||!result.health.healthy||result.requiredMissing.length)process.exitCode=1;
    }else{
      const prepareOnly=process.argv.includes('--prepare');
      if(!prepareOnly){const blockers=queryProcesses(resolveInstallation(dir));if(blockers.length)throw Error('请先从托盘完全退出 Coo 并等待更新安装结束，再运行。仅检查可用 --check 或 --prepare。');}
      const base=process.env.LOCALAPPDATA||os.tmpdir();
      const out=arg('out')||path.join(base,'DaFeiYu/patch-reports',new Date().toISOString().replace(/[:.]/g,'-'));
      const report=prepare({dir,pack,out,liveProbe:!process.argv.includes('--offline')});
      console.log('报告与回退备份目录：'+report.reportDir);
      if(report.status!=='prepared'){if(report.status==='offline-checked'&&prepareOnly)console.log('离线检查完成，不能应用。');else throw Error(report.error||'检查不完整，未应用。');}
      else if(prepareOnly)console.log('隔离检查通过；安装目录未修改。');
      else{console.log(JSON.stringify(apply({reportDir:report.reportDir}),null,2));console.log('完成，Coo 未启动。请自行启动。请保留本次报告目录以备同版本回退。');}
    }
  }
}catch(e){console.error('未完成：'+e.message);process.exitCode=1;}
