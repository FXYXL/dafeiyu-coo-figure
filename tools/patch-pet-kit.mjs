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
 *   body.js  : wordBase / actWord / setTrans / wordExtras / kitHeartsMount / faceShakeHook （表演系统 1.12~1.13）
 *   body.js  : busyTouch / idleWordPick / doWordOpts          （3.9 统一闲时调度 2026-11-20）
 *   pet-app.js : actBatch（同帧下发）/ beatNotice（气泡通知）/ typingHold（动作阻塞文字）（1.12~1.13）
 *   script.ts  : actModifier（修饰词放行）/ beatWaitTone（阻塞秒数+tone）（1.12~2.3）
 *   server.ts  : figureLog（审计端点 + CSP）
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
  server: `${DIR}/src/server.ts`,
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
    detect: (s) => /custom\?\.actWord\?\.\(w[,)]/.test(s),   // doWordOpts 打完后是 (w, null, o)——兼容两种，重跑幂等
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
      if (s.tone !== undefined) opts.figure?.onTone?.(s.tone);   // 2.3 tone：当前 beat 的语气传给 actWord
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
  // ===== body.js：3.9 统一闲时调度（2026-11-20）=====
  {
    file: 'body', id: 'busyTouch',
    desc: '3.9 忙闸门补「鼠标在碰我」：悬停在她身上或按住/拖动都算碰——busy 时 decide 不掷骰（乱走/换表情/做动作全停）。气泡/工具（holdRoam）/对话框（dialogOpen）原本就有；眨眼/呼吸是渲染层常驻不受影响',
    detect: (s) => /const touching = pointer\.inside/.test(s),
    apply: (s) => {
      const out = s.replace(
        "    const free = roam !== 'off' && T > hold && !opts.dialogOpen?.() && !still;",
        `    // 3.9 忙闸门补「鼠标在碰我」：人正在跟她互动，她不该自己加戏。
    // 气泡还在显示/有工具在跑（holdRoam 20）/对话框开着 kit 原本就有，这里只补触摸这一项。
    const touching = pointer.inside && (press || hitPet(pointer));
    const free = roam !== 'off' && T > hold && !opts.dialogOpen?.() && !still && !touching;`,
      );
      if (!out.includes('const touching = pointer.inside')) throw new Error('busyTouch：free 锚点未命中');
      return out;
    },
  },
  {
    file: 'body', id: 'idleWordPick',
    desc: '3.9 统一闲时调度：decide() 删 expr 硬编码六张脸，换 idle-word 选项——从形象包 idlePool() 按权重抽词走 doWord 正常入口（音效/爱心/挤压白拿），40~80 秒冷却',
    detect: (s) => /pick === 'idle-word'/.test(s),
    apply: (s) => {
      const out = s
        .replace(
          "['sit', 6], ['expr', 12], ['wait', calm ? 30 : 10]]",
          "['sit', 6], ['idle-word', T >= (pet.idleWordAt ?? 0) ? 12 : 0], ['wait', calm ? 30 : 10]]",
        )
        .replace(
          "    else if (pick === 'expr') { setExpr(['happy', 'wink', 'love', 'sleepy', 'surprised', 'shy'][Math.floor(Math.random() * 6)]); pet.lastAct = 'expr'; }",
          `    else if (pick === 'idle-word') {   // 3.9 统一闲时池：表情+小动作归形象包管（kit 原六张脸已收编进池子）
      const pool = custom?.idlePool?.() ?? [];
      const total = pool.reduce((a, m) => a + (m.w ?? 1), 0);
      let r2 = Math.random() * total, pick2 = pool[pool.length - 1];
      for (const m of pool) { r2 -= (m.w ?? 1); if (r2 <= 0) { pick2 = m; break; } }
      const word = typeof pick2 === 'object' ? pick2.word : pick2;
      pet.idleWordAt = T + rnd(40, 80);   // 冷却先记上：词被拒（busy）也不连着掷
      if (word) doWord(word, { idle: true, life: pick2.life });
      pet.lastAct = 'idle-word';
    }`,
        );
      if (!out.includes("pick === 'idle-word'")) throw new Error('idleWordPick：expr 分支锚点未命中');
      if (!out.includes("['idle-word', T >= (pet.idleWordAt ?? 0) ? 12 : 0]")) throw new Error('idleWordPick：opts2 锚点未命中');
      return out;
    },
  },
  {
    file: 'body', id: 'doWordOpts',
    desc: 'doWord 透传第二参：闲时调度 doWord(word, {idle, life}) → actWord(w, null, o)——o.idle 登记收尾（走跑跳开始按 src 撤）、o.life 心情挂更久',
    detect: (s) => /actWord\?\.\(w, null, o\)/.test(s),
    apply: (s) => {
      const out = s
        .replace('  function doWord(w) {', '  function doWord(w, o) {   // o：闲时调度透传（{idle:true, life:秒}），对话词不传')
        .replace('    if (custom?.actWord?.(w)) {', '    if (custom?.actWord?.(w, null, o)) {');
      if (!out.includes('function doWord(w, o)')) throw new Error('doWordOpts：doWord 签名锚点未命中');
      if (!out.includes('actWord?.(w, null, o)')) throw new Error('doWordOpts：actWord 调用锚点未命中');
      return out;
    },
  },
  // ===== pet-app.js =====
  {
    file: 'petapp', id: 'actBatch',
    desc: '动作同帧下发（4 处 acts.push 全改 body.do：say 气泡/<词> inline/pet_act/d.actions）',
    detect: (s) => /tone: b\.tone/.test(s),   // 补丁特征行（全局反证会被别处 acts.push 干扰误报）
    apply: (s) => s
      .replace(
        "case 'act': acts.push(...m.actions); holdRoam(20); break;",
        "case 'act': for (const a of m.actions) body?.do(a); holdRoam(20); break;",
      )
      .replace(
        'for (const a of b.actions || []) { acts.push(a); lead = .45; }',
        `if (b.tone) body?.set({ tone: b.tone });   // 2.3 tone 先下发，动作的幅度/速度跟着语气走
        for (const a of b.actions || []) { body?.do(a); lead = .45; }
        if (b.wait) it.typeHold = T + lead + b.wait;   // 2.1 动作阻塞文字：motion 词演完再打字
        it.bubbleOpen = false;   // 有阻塞时气泡延到动作演完才出现（typingHold）——不留空气泡
        if (b.text && !b.wait) { openBubble('say', '<p class="b-text"></p>'); sfx.pop(); it.bubbleOpen = true; }
        else if (!b.text) bubble.hidden = true;`,
      )
      .replace(
        "      if (b.text) { openBubble('say', '<p class=\"b-text\"></p>'); sfx.pop(); } else { bubble.hidden = true; }",
        '      // 原版 beat 开始立即开气泡——已移到 typingHold 的 bubbleOpen 逻辑（阻塞期不出气泡）',
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
    file: 'petapp', id: 'typingHold',
    desc: '2.1 动作阻塞文字（打字在 typeHold 期暂停，anchors 触发同样阻塞）+ 2.2 打字速度解耦（20→12 字/秒，bubbleSpeed 只管停留）',
    detect: (s) => /typeHold/.test(s) && /dt \* 12 \* prefs\.bubbleSpeed/.test(s),
    apply: (s) => {
      const out = s
        .replace(
          "function typeText(it, text, dt, anchors) {\n  const p = bubble.querySelector('.b-text');\n  if (!p || it.shown >= text.length) return;",
          `  function typeText(it, text, dt, anchors) {
  // 2.1 动作阻塞文字 + 气泡延迟：这两条必须在 !p 守卫之前——阻塞期气泡还没开，
  // .b-text 不存在，放在守卫后面会先 return 导致气泡永远开不出来（先有鸡还是先有蛋）。
  if (T < (it.typeHold ?? 0)) return;
  if (!it.bubbleOpen) {
    it.bubbleOpen = true;
    if (text) { openBubble('say', '<p class="b-text"></p>'); sfx.pop(); }
    else bubble.hidden = true;
  }
  const p = bubble.querySelector('.b-text');
  if (!p || it.shown >= text.length) return;`,
        )
        .replace(
          "  if (it.spoken !== text && !it.rush && !it.hushed) { it.spoken = text; speech.begin(text); }\n  // with speech, each pause mark waits its own time, letters type faster, and the voice makes the sound;\n  // estimateSeconds in src/script.ts mirrors these steps, this rate and the holds in stepDialog\n  const spoken = speech.active && !it.hushed;\n  it.acc += dt * 20 * prefs.bubbleSpeed * (it.rush ? RUSH : 1);",
          `  if (it.spoken !== text && !it.rush && !it.hushed) { it.spoken = text; speech.begin(text); }
  // with speech, each pause mark waits its own time, letters type faster, and the voice makes the sound;
  // estimateSeconds in src/script.ts mirrors these steps, this rate and the holds in stepDialog
  const spoken = speech.active && !it.hushed;
  it.acc += dt * 12 * prefs.bubbleSpeed * (it.rush ? RUSH : 1);   // 2.2 打字速度独立（他们 9 字/秒，中文折中 12）；bubbleSpeed 只管停留`,
        )
        .replace(
          "    while (it.fired < anchors.length && anchors[it.fired].at <= it.shown) for (const a of anchors[it.fired++].actions) body?.do(a);",
          `    while (it.fired < anchors.length && anchors[it.fired].at <= it.shown) {
    const an = anchors[it.fired++];
    for (const a of an.actions) body?.do(a);
    if (an.wait) it.typeHold = T + an.wait;   // 2.1 锚点动作同样阻塞打字
  }`,
        );
      // 命中校验：replace 静默失败（锚点不匹配）会让补丁半打且无报错——此处必须 throw
      if (!out.includes('先有鸡还是先有蛋')) throw new Error('typingHold：typeText 开头锚点未命中（原版结构变了）');
      if (!out.includes('dt * 12 * prefs.bubbleSpeed')) throw new Error('typingHold：速度替换未命中');
      return out;
    },
  },
  {
    file: 'body', id: 'squashBridge',
    desc: '2.7 动作驱动整图压扁：把 figure 的 squash()（虚拟参数 ViewSquash，通道 key 帧驱动）叠加进 kit 的 sq 弹簧目标——弹簧（280/14）、锚点、阴影、与落地/拖拽/哈欠的叠加全部白拿。不能 sqT +=（idle 分支不重置 sqT，会每帧累加），改在弹簧积分行叠加目标值（每帧读、无状态残留）',
    detect: (s) => /custom\?\.squash\?\.\(\)/.test(s),
    apply: (s) => {
      const out = s.replace(
        '    pet.sqv += ((sqT - pet.sq) * 280 - pet.sqv * 14) * dt;',
        '    pet.sqv += (((sqT + (custom?.squash?.() ?? 0)) - pet.sq) * 280 - pet.sqv * 14) * dt;   // 2.7 整图压扁：figure 虚拟参数 ViewSquash 叠加进弹簧目标',
      );
      if (!out.includes('custom?.squash?.()')) throw new Error('squashBridge：弹簧积分行锚点未命中');
      return out;
    },
  },
  {
    file: 'body', id: 'actFaceSkip',
    desc: 'kit 内置动作（wave/bow/dance/flap）不再附带 holdFace——动作不动脸，脸由词表/弧度管；否则 holdFace 触发 face 清场会把挂着的表情（笑眼等 keep 条目）全删',
    detect: (s) => /actFaceSkip/.test(s),
    apply: (s) => s
      .replace("      case 'wave': pulse('wave', 1.6); holdFace('happy', 1.8); break;", "      case 'wave': pulse('wave', 1.6); break;   // actFaceSkip：挥手不附带 happy 脸（Live2D 的脸由词/弧度管）")
      .replace("      case 'bow': if (!seated) setMode('idle'); pulse('bow', 1.6); holdFace('bowing', 1.5); play('tick', 'move'); break;", "      case 'bow': if (!seated) setMode('idle'); pulse('bow', 1.6); play('tick', 'move'); break;   // actFaceSkip")
      .replace("      case 'flap': setMode('crouch', { jumpV: 540, jumpVx: 0 }); pulse('flap', 1.4); holdFace('happy', 1.6); play('chirps', 'move'); break;", "      case 'flap': setMode('crouch', { jumpV: 540, jumpVx: 0 }); pulse('flap', 1.4); play('chirps', 'move'); break;   // actFaceSkip")
      .replace("      case 'dance': setMode('dance', { dur: 3.2 }); holdFace('happy', 3.4); play('dance', 'move'); break;", "      case 'dance': setMode('dance', { dur: 3.2 }); play('dance', 'move'); break;   // actFaceSkip"),
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
    detect: (s) => /actModifier：修饰词不算新词/.test(s),
    apply: (s) => {
      const out = s.replace(
        `    const id = vocabId(w, vocab);
    if (id) out.push(id);
    else dropped.push(w);`,
        `    const id = vocabId(w, vocab);
    if (id) { out.push(id); continue; }
    // actModifier：修饰词不算新词——剥掉前缀修饰（微/大/快/慢/轻/猛/×几）再校验，
    // 通过就把原词放行给 kit baseWord（那边解析修饰为幅度/速度）。
    const bare = w.replace(/^[微大快慢轻猛]+/, '').replace(/^[×xX]\\d+/, '');
    if (bare && bare !== w && vocabId(bare, vocab)) { out.push(w); continue; }
    dropped.push(w);`,
      );
      if (!out.includes('actModifier：修饰词不算新词')) throw new Error('actModifier：words() 锚点未命中');
      return out;
    },
  },
  {
    file: 'script', id: 'beatWaitTone',
    desc: '2.1 动作阻塞文字 + 2.3 tone：Beat/Anchor 加 wait（motion && !lasting 才算秒）、Beat 加 tone（含！→感叹/末尾…→省略）；wait/anchor.wait 乘 tone pace 与动作实际时长精确同步',
    detect: (s) => /sumWait/.test(s) && /toneOf/.test(s),
    apply: (s) => {
      const out = s
        .replace(
          `export interface Anchor {
  /** Character offset in the beat's text. */
  at: number;
  actions: string[];
}

export interface Beat {
  actions: string[];
  text: string;
  anchors: Anchor[];
}`,
          `export interface Anchor {
  /** Character offset in the beat's text. */
  at: number;
  actions: string[];
  /** 2.1 动作阻塞文字：锚点动作（motion && !lasting）演多久，打字就停多久。 */
  wait?: number;
}

export interface Beat {
  actions: string[];
  text: string;
  anchors: Anchor[];
  /** 2.1 beat 开头动作的阻塞秒数。 */
  wait?: number;
  /** 2.3 tone：beat 文本含「！」→ '!'（动作放大加速）、末尾「…」→ '…'（收着放慢）——他们 Body.cs:536 同款判定。 */
  tone?: string;
}

/** 2.1+2.4 动作节拍（他们 Body.cs:322/371-373 同款）：文字不等动作真实时长，等固定节拍——
 *  普通 0.35 / 手势 0.7 / 吓一跳 0.45，多词取 max，上限 2.4（动作继续后台演，文字该说就说）。
 *  纯动作行（无文字）：max(0.8, 动作时长封顶2.4, 手势1.1)。 */
const BEAT = 0.35, HAND_BEAT = 0.7, STARTLE_BEAT = 0.45, LONGEST_WAIT = 2.4;
const HANDISH = new Set(['wave', 'finger-point', 'chest-hand', 'grass-hand', 'swing']);
function sumWait(ids: string[], vocab: readonly VocabWord[], hasText: boolean): number {
  let wait = 0;
  for (const id of ids) {
    const v = vocab.find((x) => x.id === id);
    if (!v || v.kind !== 'motion' || v.lasting) continue;
    const handish = (v as any).handish || HANDISH.has(id);
    if (!hasText) {
      wait = Math.max(wait, Math.min(v.seconds || 0, LONGEST_WAIT), handish ? 1.1 : 0);
    } else {
      wait = Math.max(wait, id === 'startle' ? STARTLE_BEAT : handish ? HAND_BEAT : BEAT);
    }
  }
  if (!hasText) wait = Math.max(wait, 0.8);
  return Math.min(wait, LONGEST_WAIT);
}

/** 2.3 tone 判定（他们 Body.cs:536 同款）：含 ！/! 优先 → '!'；否则末尾 …/⋯ → '…'。 */
function toneOf(text: string): string {
  const t = text.trimEnd();
  if (t.includes('！') || t.includes('!')) return '!';
  if (t.endsWith('…') || t.endsWith('⋯')) return '…';
  return '';
}`,
        )
        .replace(
          `      if (cur.text.trim() || cur.actions.length || cur.anchors.length) beats.push(cur);`,
          `      if (cur.text.trim() || cur.actions.length || cur.anchors.length) {
        const tone = toneOf(cur.text);
        const pace = tone === '!' ? 0.85 : tone === '…' ? 1.25 : 1;   // 2.3 阻塞时长也吃 tone——与动作实际时长精确同步
        for (const a of cur.anchors) a.wait = (a.wait ?? 0) * pace;
        beats.push({ ...cur, wait: sumWait(cur.actions, vocab, !!cur.text.trim()) * pace, tone });
      }`,
        )
        .replace(
          `      if (acts.length) cur.anchors.push({ at: cur.text.length, actions: acts });`,
          `      if (acts.length) cur.anchors.push({ at: cur.text.length, actions: acts, wait: sumWait(acts, vocab, true) });`,
        )
        .replace(
          `  if (cur.text.trim() || cur.actions.length || cur.anchors.length) beats.push(cur);`,
          `  if (cur.text.trim() || cur.actions.length || cur.anchors.length) {
    const tone = toneOf(cur.text);
    const pace = tone === '!' ? 0.85 : tone === '…' ? 1.25 : 1;   // 2.3 阻塞时长也吃 tone——与动作实际时长精确同步
    for (const a of cur.anchors) a.wait = (a.wait ?? 0) * pace;
    beats.push({ ...cur, wait: sumWait(cur.actions, vocab, !!cur.text.trim()) * pace, tone });
  }`,
        );
      if ((out.match(/sumWait\(cur\.actions, vocab, !!cur\.text\.trim\(\)\) \* pace/g) || []).length !== 2) throw new Error('beatWaitTone：beats.push 锚点未命中（应 2 处）');
      if (!out.includes('actions: acts, wait: sumWait(acts, vocab, true)')) throw new Error('beatWaitTone：anchors.push 锚点未命中');
      return out;
    },
  },
  // ===== server.ts：figure 诊断日志通道 =====
  {
    file: 'server', id: 'figureLog',
    desc: '/api/figure-log 诊断端点（形象页通道审计 → core.log）+ PACK_CSP 放行 img-src self（image beacon 通道）',
    detect: (s) => s.includes('/api/figure-log'),
    apply: (s) => {
      const out = s
        .replace(
          `const PACK_CSP = "sandbox allow-scripts; default-src 'none'";`,
          `const PACK_CSP = "sandbox allow-scripts; default-src 'none'; img-src 'self';";`,
        )
        .replace(
          `    if (req.method === 'GET' && path === '/figure-frame') {`,
          `    if (req.method === 'GET' && path === '/api/figure-log') {
      // 形象页通道审计（image beacon：figure-frame CSP img-src self 放行）——写入插件日志（core.log）
      console.warn('[figure]', url.searchParams.get('m') ?? '');
      return json(res, 200, { ok: 1 });
    }
    if (req.method === 'GET' && path === '/figure-frame') {`,
        );
      if (!out.includes("/api/figure-log') {")) throw new Error('figureLog：路由锚点未命中');
      if (!(out.match(/img-src 'self';/g) ?? []).length) throw new Error('figureLog：PACK_CSP 未改');
      return out;
    },
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
