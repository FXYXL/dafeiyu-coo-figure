#!/usr/bin/env node
/**
 * 给 Coo 桌宠引擎打补丁 —— Coo 每次更新都会覆盖 web/kit、web/pet-app、src/script，
 * 跑一次这个重新打上全部。
 *
 *   node patch-pet-kit.mjs          打补丁
 *   node patch-pet-kit.mjs --check  只检查状态，不写文件
 *   node patch-pet-kit.mjs --revert 从 .bak-* 还原
   node patch-pet-kit.mjs --dir="C:/xxx/.../cortico-world-desktop-pet"   指定桌宠引擎位置（别人的机器）
 *
 * 补丁清单（file: id）：
 *   body.js  : pointer / noMirror / noTurn / drowse          （1.11 时代）
 *   body.js  : wordBase / actWord / setTrans                  （表演系统 1.12~1.13）
 *   pet-app.js : actBatch（同帧下发）/ beatNotice（气泡通知）  （1.12~1.13）
 *   script.ts  : actModifier（修饰词放行）                     （1.12）
 */
import fs from 'node:fs';
import path from 'node:path';

// 桌宠引擎位置：默认作者的机器，其他人用 --dir= 传自己的安装目录
//   node patch-pet-kit.mjs --dir="C:/我的Coo路径/resources/app/node_modules/cortico-world-desktop-pet"
const argDir = process.argv.find((a) => a.startsWith('--dir='));
const DIR = (argDir ? argDir.slice(6).replace(/[\\/]+$/, '') : 'D:/Coopanion/resources/app/node_modules/cortico-world-desktop-pet');
const FILES = {
  body: `${DIR}/web/kit/body.js`,
  petapp: `${DIR}/web/pet-app.js`,
  script: `${DIR}/src/script.ts`,
};

const PATCHES = [
  // ===== body.js：1.11 时代的四个 =====
  {
    file: 'body', id: 'pointer',
    desc: '把真实指针坐标和瞬时朝向传给形象（走神/跟随/防抽搐要靠它）',
    detect: (s) => /pointer:\s*pointer\.inside\s*\?/.test(s) && /facingNow:\s*pet\.facing/.test(s),
    apply: (s) => {
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
    file: 'body', id: 'noMirror',
    desc: '形象声明 noMirror 时不做整块镜像（Live2D 正面像翻面会左右手换边）',
    detect: (s) => /const faceK = custom\?\.noMirror/.test(s) && /lean = pet\.lean \* pet\.faceVis/.test(s),
    apply: (s) => s.replace(
      'const kx = S * pet.faceVis * sx, ky = S * sy, lean = pet.lean * pet.faceVis;',
      'const faceK = custom?.noMirror ? 1 : pet.faceVis;\n    const kx = S * faceK * sx, ky = S * sy, lean = pet.lean * pet.faceVis;',
    ),
  },
  {
    file: 'body', id: 'noTurn',
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
    file: 'body', id: 'drowse',
    desc: '降低随机打瞌睡的权重 / 概率 / 时长',
    detect: (s) => /\['sit', 6\]/.test(s) && /willSleep: Math\.random\(\) < \.18/.test(s),
    apply: (s) => s
      .replace("['sit', 16]", "['sit', 6]")
      .replace('willSleep: Math.random() < .6', 'willSleep: Math.random() < .18')
      .replace("setMode('sleep', { dur: rnd(8, 12) })", "setMode('sleep', { dur: rnd(4, 6) })"),
  },
  // ===== body.js：表演系统（1.12~1.13）=====
  {
    file: 'body', id: 'wordBase',
    desc: 'doWord 词还原：修饰词（微/大/快/慢/×几）+ 中文别名由形象包解析',
    detect: (s) => /custom\?\.baseWord\?\.\(w\)/.test(s),
    apply: (s) => s.replace(
      '  function doWord(w) {',
      '  function doWord(w) {\n    const base = custom?.baseWord?.(w);\n    if (base) w = base;',
    ),
  },
  {
    file: 'body', id: 'actWord',
    desc: '通道接管：动作交给形象包的 actWord（返回 true 则 kit 直接成功）',
    detect: (s) => /custom\?\.actWord\?\.\(w\)/.test(s),
    apply: (s) => s.replace(
      '    const base = custom?.baseWord?.(w);\n    if (base) w = base;',
      '    const base = custom?.baseWord?.(w);\n    if (base) w = base;\n    if (custom?.actWord?.(w)) return true;',
    ),
  },
  {
    file: 'body', id: 'setTrans',
    desc: 'set 透传生命周期事件：speechStart / speechDone / beat（表情寿命跟句用）',
    detect: (s) => /onSpeechStart/.test(s),
    apply: (s) => s.replace(
      "      if (typeof s.hold === 'number') ctl.holdRoam(s.hold);",
      `      if (typeof s.hold === 'number') ctl.holdRoam(s.hold);
      if (s.speechStart) opts.figure?.onSpeechStart?.();
      if (s.speechDone) opts.figure?.onSpeechEnd?.();
      if (s.beat !== undefined) opts.figure?.onBeat?.(s.beat);`,
    ),
  },
  {
    file: 'body', id: 'wordExtras',
    desc: 'actWord 接管的词补回 kit 表情附加动作：音效（host.sound 桥）/ 爱心粒子（kitHearts 挂载）/ 挤压脉冲（sqv）',
    detect: (s) => /wordExtras/.test(s),
    apply: (s) => s.replace(
      `  function doWord(w) {
    const base = custom?.baseWord?.(w);
    if (base) w = base;
    if (custom?.actWord?.(w)) return true;`,
      `  function doWord(w) {
    const orig = w;
    const base = custom?.baseWord?.(w);
    if (base) w = base;
    if (custom?.actWord?.(w)) {
      // wordExtras：词被 figure 通道接管后，kit 表情槽的"附加动作"照常发生。
      // 表情名的确定：orig 是 kit 表情名（script.ts 已解析的【】词）直接用；
      // 否则问 figure 的 emotionFace（pet_act 传中文原词，baseWord 还原成
      // 配方 id 如 blush/heart-eyes，用 emotionArc 换算回 kit 表情名 shy/love）。
      // 音效走 host.sound（body-host 桥 → 主页 sfx.play）——play 闭包在 createPet 里，
      // doWord 作用域没有，之前用 play 直接 ReferenceError 被上层吞掉（静默无声的根因）。
      const face = KIT_EXPRESSIONS.includes(orig) ? orig : custom?.emotionFace?.(w);
      if (face) {
        const tone = FACE_TONES[face];
        if (tone) sfx?.play?.(tone, 'face');   // doWord 实际在 createPet 内（createBody 只是包装），sfx 可见、host 不可见——用 host 会 ReferenceError 崩形象
        if (face === 'love') custom?.kitHearts?.();
        pet.sqv += face === 'surprised' ? -2.2 : .8;
      }
      return true;
    }`,
    ),
  },
  {
    file: 'body', id: 'kitHeartsMount',
    desc: 'createPet 把爱心粒子发射器挂到 figure 上（doWord/控制侧拿不到 emitHeart，借 figure 对象桥过去）',
    detect: (s) => /custom.kitHearts = /.test(s),   // 精确匹配挂载赋值——/kitHearts/ 会被 wordExtras 里的调用字样误判
    apply: (s) => s.replace(
      `  let custom = opts.figure;`,
      `  let custom = opts.figure;
  custom.kitHearts = () => { for (let i = 0; i < 4; i++) emitHeart(); };   // emitHeart 函数声明提升，此处可用`,
    ),
  },
  {
    file: 'body', id: 'faceShakeHook',
    desc: '渲染组抖钩子：figure 的 faceShake()（情绪词的浑身抖动）叠加到整组 AX——对齐 fc.shake 的组级抖动',
    detect: (s) => /faceShake/.test(s),
    apply: (s) => s.replace(
      `    else if (pet.pulse?.kind === 'shiver') AX += Math.sin(T * 75) * 1.1 * envelope((T - pet.pulse.t0) / pet.pulse.dur, .08, .85);`,
      `    else if (pet.pulse?.kind === 'shiver') AX += Math.sin(T * 75) * 1.1 * envelope((T - pet.pulse.t0) / pet.pulse.dur, .08, .85);
    AX += custom?.faceShake?.(T) ?? 0;   // 通道情绪词的组级抖动（生气/害怕）——figure 实现见形象包`,
    ),
  },
  // ===== pet-app.js =====
  {
    file: 'petapp', id: 'actBatch',
    desc: '动作同帧下发（4 处 acts.push 全改 body.do：say 气泡/<词> inline/pet_act/d.actions）',
    detect: (s) => !/acts.push/.test(s) && /body\?\.do\(a\)/.test(s),
    apply: (s) => s
      .replace(
        "case 'act': acts.push(...m.actions); holdRoam(20); break;",
        "case 'act': for (const a of m.actions) body?.do(a); holdRoam(20); break;",
      )
      .replace(
        'for (const a of b.actions || []) { acts.push(a); lead = .45; }',
        'for (const a of b.actions || []) { body?.do(a); lead = .45; }',
      )
      .replace(
        'while (it.fired < anchors.length && anchors[it.fired].at <= it.shown) acts.push(...anchors[it.fired++].actions);',
        'while (it.fired < anchors.length && anchors[it.fired].at <= it.shown) for (const a of anchors[it.fired++].actions) body?.do(a);',
      )
      .replace(
        'for (const a of d.actions || []) acts.push(a);',
        'for (const a of d.actions || []) body?.do(a);',
      ),
  },
  {
    file: 'petapp', id: 'beatNotice',
    desc: '气泡生命周期通知：say 开始 / beat 开始 / 说完（表情寿命跟句的信号源）',
    detect: (s) => /beat: it\.i/.test(s) && /speechStart: 1/.test(s),
    apply: (s) => s
      .replace(
        "    case 'say': dropAsks(); queue.push({ kind: 'say', id: m.id, beats: m.beats, i: -1 }); holdRoam(20); break;",
        "    case 'say': dropAsks(); body?.set({ speechStart: 1 }); queue.push({ kind: 'say', id: m.id, beats: m.beats, i: -1 }); holdRoam(20); break;",
      )
      .replace(
        '      if (it.i >= it.beats.length) { closeBubble(); return; }',
        '      if (it.i >= it.beats.length) { body?.set({ speechDone: 1 }); closeBubble(); return; }',
      )
      .replace(
        '      const b = it.beats[it.i];\n      let lead = 0;',
        '      body?.set({ beat: it.i });\n      const b = it.beats[it.i];\n      let lead = 0;',
      ),
  },
  // ===== script.ts =====
  {
    file: 'script', id: 'actModifier',
    desc: '修饰词放行：微/大/快/慢/×几 不算新词，剥掉修饰后的词去校验',
    detect: (s) => /「微\/大\/快\/慢」前缀/.test(s),
    apply: null,   // 已在源文件（138 行注释为锚），Coo 更新后需按当日实现重写——TODO
  },
];

const mode = process.argv.includes('--check') ? 'check'
  : process.argv.includes('--revert') ? 'revert' : 'apply';

if (mode === 'revert') {
  for (const [k, f] of Object.entries(FILES)) {
    const bak = f + '.bak-petkit';
    if (fs.existsSync(bak)) { fs.copyFileSync(bak, f); console.log(`已还原 ${k}`); }
  }
  process.exit(0);
}

for (const [k, f] of Object.entries(FILES)) {
  if (!fs.existsSync(f)) { console.error(`找不到 ${k}: ${f}`); process.exit(1); }
}

// 按文件分组打补丁（每个文件独立读源 / 独立备份 .bak-petkit）
for (const [k, f] of Object.entries(FILES)) {
  let src = fs.readFileSync(f, 'utf8');
  const before = src;
  const report = [];
  const bak = f + '.bak-petkit';

  for (const p of PATCHES.filter((x) => x.file === k)) {
    if (p.detect(src)) { report.push(`  跳过 ${p.id}（已打）`); continue; }
    if (!p.apply) { report.push(`  ⚠ ${p.id} 无自动 apply（Coo 更新后需手动按当日实现重写）`); continue; }
    const next = p.apply(src);
    if (next === null) { report.push(`  ✗ ${p.id} 失败：找不到锚点（Coo 可能改了结构）`); continue; }
    if (next === src) { report.push(`  ✗ ${p.id} 失败：替换没生效`); continue; }
    src = next;
    report.push(`  ✓ ${p.id} ${p.desc}`);
  }

  console.log(`\n补丁目标[${k}]：${f}`);
  console.log(report.join('\n') || '  （全部已打）');

  if (mode === 'check') continue;
  if (src === before) { console.log('  无改动'); continue; }
  if (!fs.existsSync(bak)) fs.copyFileSync(f, bak);
  fs.writeFileSync(f, src);
  console.log(`  已写入（备份 ${path.basename(bak)}）`);
}

if (mode !== 'check') console.log('\n完全退出 Coo 再启动才生效。');
