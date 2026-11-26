/** Compile and run the actual shipped probe with Windows PowerShell 5.1 + WASAPI. */
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const script=path.resolve(process.argv[2]??fileURLToPath(new URL('./music/probe.ps1',import.meta.url)));
const expectFailure=process.argv.includes('--expect-failure');
if(!expectFailure)assert(fs.readFileSync(script).every(b=>b<128),'Shipped probe must stay ASCII: Windows PowerShell reads unmarked UTF-8 using the ANSI code page');
const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-IntervalMs','50','-ParentPid',String(process.pid)],{windowsHide:true,stdio:['ignore','pipe','pipe']});
const rows=[];let buf='',stderr='',exitCode;
child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
child.stdout.on('data',chunk=>{buf+=chunk;let n;while((n=buf.indexOf('\n'))>=0){const line=buf.slice(0,n).trim();buf=buf.slice(n+1);try{rows.push(JSON.parse(line));}catch{}}});
child.stderr.on('data',chunk=>{stderr+=chunk;});
child.on('exit',code=>{exitCode=code;});
try{
  for(let i=0;i<100;i++){if(exitCode!==undefined||rows.filter(r=>Number.isFinite(r.rms)).length>=40)break;await new Promise(r=>setTimeout(r,100));}
  const samples=rows.filter(r=>Number.isFinite(r.rms));
  if(expectFailure){assert.notEqual(exitCode,undefined,'old probe must exit');assert.notEqual(exitCode,0);assert(stderr.includes('Add-Type')&&stderr.includes('name'),'must reproduce the compiler error');}
  else{assert.equal(exitCode,undefined,stderr);assert(rows.some(r=>r.ready));assert(samples.length>=40,stderr||'No feature snapshots');assert(samples.every(r=>Array.isArray(r.bands)&&r.bands.length===16&&Array.isArray(r.apps)));}
  console.log(JSON.stringify({passed:true,expectedFailure:expectFailure,samples:samples.length,ready:rows.some(r=>r.ready),maxRms:Math.max(0,...samples.map(r=>r.rms)),apps:[...new Set(samples.flatMap(r=>r.apps.map(a=>a[0])))],compilerError:expectFailure}));
}finally{child.kill();}
