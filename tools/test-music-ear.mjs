/** Actual PowerShell process + fake feature source: subscription, timestamps, release, restart. */
import { MusicEar } from './music/music-ear.ts';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const out=path.resolve(process.argv[2]??'../test-runs/2026-11-26-patch/ear');
fs.mkdirSync(out,{recursive:true});
const web=fs.mkdtempSync(path.join(out,'ear-'));fs.mkdirSync(path.join(web,'music'));
fs.writeFileSync(path.join(web,'music/NAudio.dll'),'fixture');
fs.writeFileSync(path.join(web,'music/probe.ps1'),`param($IntervalMs,$ParentPid)
Write-Output '{"ready":true}'
while ($true) { Write-Output '{"rms":0.03,"bands":[0.1,0.1,0.1],"apps":[["cloudmusic",0.3]]}'; Start-Sleep -Milliseconds 50 }
`);
class Client extends EventEmitter { rows=[];send(s){this.rows.push(JSON.parse(s));}close(){this.emit('close');} }
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const ear=new MusicEar(web);
try {
  ear.start();assert.equal(ear.probe,null,'no subscriber must not start capture');
  const a=new Client();ear.attach(a);
  for(let i=0;i<40&&a.rows.length<4;i++)await wait(100);
  assert.ok(a.rows.length>=4,'actual PowerShell must emit feature snapshots');
  assert.ok(a.rows.every(r=>Number.isFinite(r.sampleAt)),'server must stamp each packet');
  assert.ok(a.rows.every((r,i)=>!i||r.sampleAt>=a.rows[i-1].sampleAt));
  const child=ear.probe;const b=new Client();ear.attach(b);a.close();assert.equal(ear.probe,child,'remaining subscriber keeps one child');
  b.close();assert.equal(ear.probe,null);assert.equal(ear.watch,null);assert.equal(ear.retryTimer,null);
  const c=new Client();ear.attach(c);assert.ok(ear.probe);assert.notEqual(ear.probe,child);
  for(let i=0;i<40&&c.rows.length<2;i++)await wait(100);
  assert.ok(c.rows.length>=2);ear.stop();assert.equal(ear.probe,null);assert.equal(ear.clients.size,0);
  fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:true,firstPackets:a.rows.length,restartPackets:c.rows.length},null,2));
  console.log('PASS: lazy capture, actual process packets, sample timestamps, shared subscription, final release, restart, stop.');
}finally{ear.stop();}
