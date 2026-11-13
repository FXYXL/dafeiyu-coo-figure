#!/usr/bin/env node
/**
 * 给 Coo 桌宠引擎打补丁 —— Coo 每次更新都会覆盖 web/kit/body.js，跑一次这个重新打上。
 *
 *   node patch-pet-kit.mjs          打补丁
 *   node patch-pet-kit.mjs --check  只检查状态，不写文件
 *   node patch-pet-kit.mjs --revert 从 .bak 还原
 *
 * 两个补丁：
 *   1. pointer   —— 把真实指针坐标传给形象。没有它，形象只能用 look 判断"鼠标动没动"，
 *                   而鼠标不在窗口时 look 是每 1.2~3 秒刷新的随机 glance，走神会被误判。
 *   2. drowse    —— 把随机打瞌睡的频率降下来（原版 sit 权重 16、转睡 60%、睡 8~12 秒）。
 */
import fs from 'node:fs';
import path from 'node:path';

const FILE = 'D:/Coopanion/resources/app/node_modules/cortico-world-desktop-pet/web/kit/body.js';
const BAK = FILE + '.bak-petkit';

const PATCHES = [
  {
    id: 'pointer',
    desc: '把真实指针坐标和瞬时朝向传给形象（走神/跟随/防抽搐要靠它）',
    detect: (s) => /pointer:\s*pointer\.inside\s*\?/.test(s) && /facingNow:\s*pet\.facing/.test(s),
    apply: (s) => {
      // 分两步：可能之前只打过 pointer，没有 facingNow
      let out = s;
      if (!/pointer:\s*pointer\.inside\s*\?/.test(out)) {
        const anchor = /(\n\s*look: pet\.look, legs, low: pet\.low, t: T, blink, eyeClose, acc: skin, swing: pet\.swing,)/;
        if (!anchor.test(out)) return null;
        out = out.replace(anchor, `$1
      // 指针的真实舞台坐标（不在窗口内就是 null）。形象靠它区分「人真的动了鼠标」
      // 和 pet.look —— 鼠标不在窗口时 look 是每 1.2~3 秒刷新的随机 glance。
      pointer: pointer.inside ? [pointer.x, pointer.y] : null,`);
      }
      if (!/facingNow:\s*pet\.facing/.test(out)) {
        const first = /(\n\s*pointer: pointer\.inside \? \[pointer\.x, pointer\.y\] : null,)/;
        if (!first.test(out)) return null;
        out = out.replace(first, `$1
      // 瞬时的朝向（±1），不是平滑的 faceVis。kit 算 look 时用的是这个，
      // 形象做镜像补偿也必须用同一个，否则翻转瞬间两边不同步，头会往回抽一下。
      facingNow: pet.facing,`);
      }
      return out;
    },
  },
  {
    id: 'noMirror',
    desc: '形象声明 noMirror 时不做整块镜像（Live2D 正面像翻面会左右手换边）',
    detect: (s) => /const faceK = custom\?\.noMirror/.test(s) && /lean = pet\.lean \* pet\.faceVis/.test(s),
    apply: (s) => s.replace(
      'const kx = S * pet.faceVis * sx, ky = S * sy, lean = pet.lean * pet.faceVis;',
      // 只让水平缩放受 noMirror 影响；lean 继续乘 faceVis，
      // 否则身体永远往同一边倒、胯的摆动也会变干。
      'const faceK = custom?.noMirror ? 1 : pet.faceVis;\n    const kx = S * faceK * sx, ky = S * sy, lean = pet.lean * pet.faceVis;',
    ),
  },
  {
    id: 'noTurn',
    desc: 'noMirror 的形象不做 facing 翻转（待机转身 + 张望动作两处）',
    detect: (s) => /!custom\?\.noMirror && pointer\.inside && !press/.test(s) && /!pet\.turned && !custom\?\.noMirror/.test(s),
    apply: (s) => s
      .replace(
        'if (pointer.inside && !press && pdx * pet.facing < -50 && pm < 600) {',
        'if (!custom?.noMirror && pointer.inside && !press && pdx * pet.facing < -50 && pm < 600) {',
      )
      .replace(
        'else if (mt < 1.8) { if (!pet.turned) { pet.turned = true; pet.facing *= -1; } lookT = [5, 0]; }',
        'else if (mt < 1.8) { if (!pet.turned && !custom?.noMirror) { pet.turned = true; pet.facing *= -1; } lookT = [5, 0]; }',
      ),
  },
  {
    id: 'drowse',
    desc: '降低随机打瞌睡的权重 / 概率 / 时长',
    detect: (s) => /\['sit', 6\]/.test(s) && /willSleep: Math\.random\(\) < \.18/.test(s),
    apply: (s) => s
      .replace("['sit', 16]", "['sit', 6]")
      .replace('willSleep: Math.random() < .6', 'willSleep: Math.random() < .18')
      .replace("setMode('sleep', { dur: rnd(8, 12) })", "setMode('sleep', { dur: rnd(4, 6) })"),
  },
];

const mode = process.argv.includes('--check') ? 'check'
  : process.argv.includes('--revert') ? 'revert' : 'apply';

if (!fs.existsSync(FILE)) {
  console.error(`找不到 ${FILE}\nCoo 的安装路径可能变了，改脚本顶部的 FILE。`);
  process.exit(1);
}

if (mode === 'revert') {
  if (!fs.existsSync(BAK)) { console.error('没有备份，无法还原'); process.exit(1); }
  fs.copyFileSync(BAK, FILE);
  console.log('已从备份还原');
  process.exit(0);
}

let src = fs.readFileSync(FILE, 'utf8');
const before = src;
const report = [];

for (const p of PATCHES) {
  if (p.detect(src)) { report.push(`  跳过 ${p.id}（已经打过了）`); continue; }
  const next = p.apply(src);
  if (next === null) { report.push(`  ✗ ${p.id} 失败：找不到锚点（Coo 可能改了结构）`); continue; }
  if (next === src) { report.push(`  ✗ ${p.id} 失败：替换没生效`); continue; }
  src = next;
  report.push(`  ✓ ${p.id} ${p.desc}`);
}

console.log(`补丁目标：${FILE}`);
console.log(report.join('\n'));

if (mode === 'check') {
  console.log(src === before ? '\n（检查模式，未写入）' : '\n（检查模式，未写入；上面有可打的补丁）');
  process.exit(0);
}

if (src === before) {
  console.log('\n没有改动，无需写入');
  process.exit(0);
}

if (!fs.existsSync(BAK)) fs.copyFileSync(FILE, BAK);
fs.writeFileSync(FILE, src);
console.log(`\n已写入（备份在 ${path.basename(BAK)}）\n完全退出 Coo 再启动才生效。`);
