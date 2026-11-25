/** Isolated patch application / check / idempotence / rollback / failure tests.
 * Reads an engine fixture, never writes to or starts the installed Coo.
 * node tools/test-pet-kit-patch.mjs --engine=D:/.../cortico-world-desktop-pet --out=../test-runs/...
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const here=path.dirname(fileURLToPath(import.meta.url));
const arg=n=>process.argv.find(a=>a.startsWith('--'+n+'='))?.slice(n.length+3);
const engine=arg('engine');
if(!engine)throw Error('Pass --engine=<read-only source engine>');
const out=path.resolve(arg('out')??path.join(here,'../../test-runs/2026-11-26-patch'));
fs.mkdirSync(out,{recursive:true});
const fixture=fs.mkdtempSync(path.join(out,'engine-'));
const targets=['web/kit/body.js','web/body-host.js','web/figure-frame.js','web/pet-app.js','src/script.ts','src/model-text.ts','src/chat.ts','src/packs.ts','src/world.ts','src/server.ts'];
for(const p of targets){fs.mkdirSync(path.dirname(path.join(fixture,p)),{recursive:true});fs.copyFileSync(path.join(engine,p),path.join(fixture,p));}
const original=targets.map(p=>fs.readFileSync(path.join(fixture,p)));
const logs=[];
function run(args,status=0){const r=spawnSync(process.execPath,[path.join(here,'patch-pet-kit.mjs'),'--dir='+fixture,...args],{encoding:'utf8'});logs.push({args,status:r.status,stdout:r.stdout,stderr:r.stderr});fs.writeFileSync(path.join(out,'patch-tests.json'),JSON.stringify({fixture,logs},null,2));assert.equal(r.status,status,r.stdout+r.stderr);return r;}
run(['--check'],1);
run([]);
run(['--check']);
const patched=targets.map(p=>fs.readFileSync(path.join(fixture,p)));
run([]);
targets.forEach((p,i)=>assert.deepEqual(fs.readFileSync(path.join(fixture,p)),patched[i],'idempotence '+p));
// Same-length corruption must be detected, not mistaken for an identical asset.
const asset=path.join(fixture,'src/music-ear.ts'),saved=fs.readFileSync(asset),bad=Buffer.from(saved);bad[0]^=1;fs.writeFileSync(asset,bad);
run(['--check'],1);run([]);assert.deepEqual(fs.readFileSync(asset),saved);
run(['--revert']);
targets.forEach((p,i)=>assert.deepEqual(fs.readFileSync(path.join(fixture,p)),original[i],'rollback '+p));
assert.equal(fs.existsSync(asset),false);
// A missing required anchor must fail before any target is modified.
const body=path.join(fixture,targets[0]);fs.writeFileSync(body,original[0].toString().replace('rotate(${f(rot)})','rotate(0)'));
const before=targets.map(p=>fs.readFileSync(path.join(fixture,p)));
run([],1);
targets.forEach((p,i)=>assert.deepEqual(fs.readFileSync(path.join(fixture,p)),before[i],'failure atomicity '+p));
assert.equal(fs.existsSync(path.join(fixture,'.petkit-transaction.json')),false);
// Preserve resources that already existed before this patch, rather than deleting them.
fs.writeFileSync(body,original[0]);fs.mkdirSync(path.dirname(asset),{recursive:true});
fs.writeFileSync(asset,'previous music resource');run([]);run(['--revert']);
assert.equal(fs.readFileSync(asset,'utf8'),'previous music resource');
console.log('PASS: check, apply, byte equality, idempotence, same-size corruption, exact rollback, missing-anchor atomicity. '+fixture);
