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
  host: `${DIR}/web/body-host.js`,
  frame: `${DIR}/web/figure-frame.js`,
  petapp: `${DIR}/web/pet-app.js`,
  script: `${DIR}/src/script.ts`,
  mtext: `${DIR}/src/model-text.ts`,
  packs: `${DIR}/src/packs.ts`,
  world: `${DIR}/src/world.ts`,
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
    file: 'body', id: 'groupMove',
    desc: '整图平移：figure.groupMove() 的位移乘模型缩放加到组变换（他们 main.cpp:649 的 bodyX/bodyY）',
    detect: (s) => /custom\?\.groupMove/.test(s) && /\* kx; AY \+=/.test(s),
    apply: (s) => {
      // 幂等：先去掉任何旧版本（NDC 那版留下的是 * W / 2）
      let out = s.replace(/\n?    \/\/ figure\.groupMove[^\n]*\n    const mv = custom\?\.groupMove\?\.\(pet\.mode\);\n    if \(mv\) \{[^\n]*\}\n/g, '\n');
      return out.replace(
        '    pet.xf = { AX, AY, ax, ay, kx, ky, rot };',
        '    // figure.groupMove：整图平移（figure 返回值的 1 = 半个形象宽/高），乘模型自身缩放变像素。\n'
        + '    const mv = custom?.groupMove?.(pet.mode);\n'
        + '    if (mv) { AX += (mv.x ?? 0) * kx; AY += (mv.y ?? 0) * ky; }\n'
        + '    pet.xf = { AX, AY, ax, ay, kx, ky, rot };',
      );
    },
  },,
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
    const touching = pointer.inside && (press || ruaDown || hitPet(pointer));
    const free = roam !== 'off' && T > hold && !opts.dialogOpen?.() && !still && !touching;`,
      );
      if (!out.includes('const touching = pointer.inside')) throw new Error('busyTouch：free 锚点未命中');
      return out;
    },
  },
  {
    file: 'host', id: 'ruaTouchGate',
    desc: '4.2 rua 事件放行：body-host 的 touchGate 是 kind 白名单（TOUCHES），rua-start/rua-tier/rua-still/rua-end/stroke 全不在里面 → 整条事件被 continue 丢掉（交互文本全没的真因）。放行前缀 rua- 与 stroke',
    detect: (s) => /startsWith\('rua-'\)/.test(s),
    apply: (s) => {
      const out = s.replace(
        '      if (!TOUCHES.has(kind)) return false;',
        `      if (kind.startsWith('rua-') || kind === 'stroke') return true;   // 4.2：摸头/分区事件不走指针时间窗白名单（TOUCHES 里没有，曾被整条丢掉）\n      if (!TOUCHES.has(kind)) return false;`,
      );
      if (!out.includes("startsWith('rua-')")) throw new Error('ruaTouchGate：TOUCHES 锚点未命中');
      return out;
    },
  },
  {
    file: 'body', id: 'idleWordPick',
    desc: '3.9 统一闲时调度：decide() 删 expr 硬编码六张脸，换 idle-word 选项（权重 25，用户 2026-11-20 定：让我们自己的内容占比 ~26%）——从形象包 idlePool() 按权重抽词走 doWord 正常入口（音效/爱心/挤压白拿），25~50 秒冷却',
    detect: (s) => /pick === 'idle-word'/.test(s),
    apply: (s) => {
      const out = s
        .replace(
          "['sit', 6], ['expr', 12], ['wait', calm ? 30 : 10]]",
          "['sit', 6], ['idle-word', T >= (pet.idleWordAt ?? 0) ? 25 : 0], ['wait', calm ? 30 : 10]]",
        )
        .replace(
          "    else if (pick === 'expr') { setExpr(['happy', 'wink', 'love', 'sleepy', 'surprised', 'shy'][Math.floor(Math.random() * 6)]); pet.lastAct = 'expr'; }",
          `    else if (pick === 'idle-word') {   // 3.9 统一闲时池：表情+小动作归形象包管（kit 原六张脸已收编进池子）
      const pool = custom?.idlePool?.() ?? [];
      const total = pool.reduce((a, m) => a + (m.w ?? 1), 0);
      let r2 = Math.random() * total, pick2 = pool[pool.length - 1];
      for (const m of pool) { r2 -= (m.w ?? 1); if (r2 <= 0) { pick2 = m; break; } }
      const word = typeof pick2 === 'object' ? pick2.word : pick2;
      pet.idleWordAt = T + rnd(25, 50);   // 冷却先记上：词被拒（busy）也不连着掷。2026-11-20 用户反馈随机动作难触发，40~80 → 25~50（对齐旧待机换手节奏）
      if (word) doWord(word, { idle: true, life: pick2.life });
      pet.lastAct = 'idle-word';
    }`,
        );
      if (!out.includes("pick === 'idle-word'")) throw new Error('idleWordPick：expr 分支锚点未命中');
      if (!out.includes("['idle-word', T >= (pet.idleWordAt ?? 0) ? 25 : 0]")) throw new Error('idleWordPick：opts2 锚点未命中');
      return out;
    },
  },
  {
    file: 'body', id: 'calmPace',
    desc: '3.9a 「多待着」节奏放缓（2026-11-20 用户反馈几乎一直在动）：calm 掷骰间隔 2~4s → 5~10s（原节奏的 2.5 倍；6~14 试过太安静），wait 权重 30→40',
    detect: (s) => /calm \? rnd\(5, 10\) : rnd\(2, 4\)/.test(s),
    apply: (s) => {
      const out = s
        .replace(
          "if (pet.mode === 'idle' && T >= pet.nextAt) pet.nextAt = T + rnd(2, 4);",
          "if (pet.mode === 'idle' && T >= pet.nextAt) pet.nextAt = T + (calm ? rnd(5, 10) : rnd(2, 4));   // 3.9a calm 掷骰放缓：原节奏的 2.5 倍（6~14 试过太安静，2026-11-20 用户定）",
        )
        .replace("['wait', calm ? 30 : 10]]", "['wait', calm ? 40 : 10]]   // 3.9a 多待着：发呆权重上调");
      if (!out.includes('calm ? rnd(5, 10) : rnd(2, 4)')) throw new Error('calmPace：nextAt 锚点未命中');
      if (!out.includes("['wait', calm ? 40 : 10]]")) throw new Error('calmPace：wait 权重锚点未命中');
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
  // ===== body.js：4.2 rua 摸头（2026-11-20，参考他们家 PetWindow.Touch.cs）=====
  {
    file: 'body', id: 'ruaHead',
    desc: '4.2 rua 摸头状态机：分区判定（figure.touchZones）→ 按住头区 = rua（不抓起）；速度平滑/计时/档位（3s 脸红、8s 眉眼软、20s 融化）/单闭眼侧判/融化渐变，每帧 frame.rua 传形象画视觉；其他分区划过摸一下（带分区的事件）；开始/升档/持续心跳/结束四类事件',
    detect: (s) => /function stepRua/.test(s),
    apply: (s) => {
      let out = s
        .replace(
          '  let press = null, strokeAcc = 0, petCool = 0;',
          `  let press = null, strokeAcc = 0, petCool = 0;
  // ===== 4.2 rua 摸头（参考他们家 PetWindow.Touch.cs）=====
  let ruaDown = false, ruaLast = null, ruaVel = { x: 0, y: 0 }, ruaTravel = 0;
  let ruaHeadTime = 0, ruaDeepTime = 0, ruaMax = 0, ruaTier = 0, ruaStillAt = 0, ruaMelted = false;
  let rua = null;   // 活跃时每帧传给形象：{ ux, uy, side, face, seconds, melt, moving, fx }`,
        )
        .replace(
          `  function hitPet(p) {
    return hits().some((c) => Math.hypot(p.x - c.x, p.y - c.y) < c.r);
  }`,
          `  function hitPet(p) {
    return hits().some((c) => Math.hypot(p.x - c.x, p.y - c.y) < c.r);
  }
  /** 4.2 摸摸分区：figure 提供 touchZones（256 逻辑坐标椭圆），返回踩中的第一个 id 或 null。 */
  function zoneAt(p) {
    const zones = custom?.touchZones?.();
    if (!Array.isArray(zones)) return null;
    const xf = pet.xf ?? {};
    const kx = xf.kx ?? S, ky = xf.ky ?? S;   // 用模型自身缩放（含用户形象缩放），不再用 stage S——半径和中心同一坐标系
    return zones.find((z) => {
      const c = toStage(z.x, z.y);
      const dx = (p.x - c.x) / (z.rx * kx), dy = (p.y - c.y) / (z.ry * ky);
      return dx * dx + dy * dy <= 1;
    })?.id ?? null;
  }
  /** rua 每次移动的推进：速度指数平滑、计时衰减、档位与事件（照抄他们 StepStroke 的节奏）。 */
  function stepRua(p) {
    const t = now(p);
    const dt = Math.max(.016, (t - ((ruaLast && ruaLast.t) || t)) / 1000);
    const dx = p.x - ruaLast.x, dy = p.y - ruaLast.y;
    const raw = { x: dx / dt, y: dy / dt };
    ruaTravel += Math.hypot(dx, dy);
    ruaLast = { x: p.x, y: p.y, t };
    ruaVel.x += (raw.x - ruaVel.x) * (1 - Math.exp(-dt / .06));
    ruaVel.y += (raw.y - ruaVel.y) * (1 - Math.exp(-dt / .06));
    const speed = Math.hypot(ruaVel.x, ruaVel.y);
    const zone = zoneAt(p);
    const onHead = zone === 'head' || zone === 'face';
    const engaged = ruaTravel > 8;   // 真的移动了才算在摸（防按下误触）
    const moving = engaged && onHead && speed > 40;
    if (moving) { ruaHeadTime += dt; ruaDeepTime += dt; }
    else { ruaHeadTime = Math.max(0, ruaHeadTime - dt * .25); ruaDeepTime = Math.max(0, ruaDeepTime - (onHead ? dt * .1 : dt)); }
    ruaMax = Math.max(ruaMax, ruaHeadTime);
    if (!ruaMelted && ruaDeepTime >= 20) ruaMelted = true;
    const head = (custom?.touchZones?.() ?? []).find((z) => z.id === 'head') ?? { x: 128, y: 50, rx: 74, ry: 40 };
    const c = toStage(head.x, head.y);
    const xf2 = pet.xf ?? {};
    const hkx = xf2.kx ?? S, hky = xf2.ky ?? S;   // 动态头盒：半径用模型自身缩放（形象可缩放/拖拽拉伸都跟着走）
    const ux = Math.max(-1.3, Math.min(1.3, (p.x - c.x) / (head.rx * hkx * .35)));   // 2026-11-20：增益 2.86——脸上摸范围小，原来 ux 才 0.2 头只动 2 度
    if (t - (globalThis.__ruaDbg ?? 0) > 2000) { globalThis.__ruaDbg = t; try { new Image().src = '/api/figure-log?m=' + encodeURIComponent('rua p=' + Math.round(p.x) + ',' + Math.round(p.y) + ' c=' + Math.round(c.x) + ',' + Math.round(c.y) + ' ux=' + ux.toFixed(2) + ' uy=' + uy.toFixed(2) + ' on=' + onHead + ' S=' + S.toFixed(2)); } catch {} }
    const uy = Math.max(-1.3, Math.min(1.3, (p.y - c.y) / (head.ry * hky)));
    if (engaged && !rua) { rua = { ux: 0, uy: 0, side: 0, face: false, seconds: 0, melt: 0, moving: false, fx: 0 }; onEvent('touch', { kind: 'rua-start' }); }
    if (!rua) return;
    // 单闭哪只眼：手越过头的左右两侧才闭，进出各有一道门槛（带滞后，别在交界处来回抖）
    if (rua.side === 0) rua.side = ux > .35 ? 1 : ux < -.35 ? -1 : 0;
    else if (rua.side > 0 && ux < .22) rua.side = 0;
    else if (rua.side < 0 && ux > -.22) rua.side = 0;
    rua.ux = ux; rua.uy = uy; rua.on = engaged && onHead;   // 后端弹簧的开关（他们 amp 同口径）
    rua.face = zone === 'face' && rua.side === 0;
    rua.seconds = Math.round(ruaHeadTime * 10) / 10;
    rua.melt = Math.round(Math.min(1, Math.max(0, (ruaDeepTime - 17) / 3)) * 30) / 30;
    rua.moving = moving;
    rua.fx = Math.max(-1, Math.min(1, ruaVel.x / 600));
    // 档位：3s 轻摸（脸红）→ 8s 温柔（眉眼软）→ 20s 融化；升档发事件；8s 后每 2.5s 一次「还在摸」
    const tier = rua.melt >= 1 ? 3 : ruaHeadTime >= 8 ? 2 : ruaHeadTime >= 3 ? 1 : 0;
    if (tier > ruaTier) {
      ruaTier = tier;
      onEvent('touch', { kind: 'rua-tier', tier, seconds: Math.max(rua.seconds, ruaMax) });   // 用峰值：headTime 会衰减，直接发会倒退
      ruaStillAt = t + 2500;
    } else if (ruaTier >= 2 && t > ruaStillAt) {
      ruaStillAt = t + 2500;
      onEvent('touch', { kind: 'rua-still', tier: ruaTier, seconds: Math.max(rua.seconds, ruaMax) });   // 峰值，防倒退
    }
  }
  /** rua 结算：按总时长四档发结束事件（失落 <3s / 不舍 3~8 / 腻歪 8~20 / 融化 20+）。返回是否真的结束了一场 rua。 */
  function endRua() {
    if (!ruaDown) return false;
    ruaDown = false;
    const held = Math.round(ruaMax * 10) / 10;
    const tier = ruaMelted ? 3 : held >= 8 ? 2 : held >= 3 ? 1 : 0;
    onEvent('touch', { kind: 'rua-end', tier, seconds: held });
    rua = null; ruaMax = 0; ruaTier = 0; ruaMelted = false;
    press = null;   // press 一并清掉：残留会让下一次移动被当成拖拽（2026-11-20 用户实测）
    petCool = Math.max(petCool, 3);   // 抑制原生划过摸头反应：否则 setExpr(shy) 半眯眼残留（2026-11-20）
    return true;
  }`,
        )
        .replace(
          `  function pointerDown(p) {
    Object.assign(pointer, { x: p.x, y: p.y, inside: true });
    if (!hitPet(p)) return false;
    press = { x: p.x, y: p.y, t: now(p) };
    pointer.samples = [{ t: now(p), x: p.x, y: p.y }];
    // caught while falling or flying: held at once, since the body would fall on while the pointer moved the drag threshold
    if (pet.mode === 'air') grab();
    return true;
  }`,
          `  function pointerDown(p) {
    Object.assign(pointer, { x: p.x, y: p.y, inside: true });
    if (!hitPet(p)) return false;
    const rz0 = zoneAt(p);
    try { new Image().src = '/api/figure-log?m=' + encodeURIComponent('down zone=' + (rz0 ?? 'none') + ' p=' + Math.round(p.x) + ',' + Math.round(p.y)); } catch {}   // 诊断
    // 4.2 rua：按在头部附近一律进 rua、**绝不抓起**——crash 刷屏的根因是按头掉进拖拽→松手摔。
    // 宽松头区（2.2 倍椭圆）兜底：即使 touchZones 坐标偏了，也不会摔人，只是手感差。
    let headish = rz0 === 'head' || rz0 === 'face';
    if (!headish) {
      const hz = (custom?.touchZones?.() ?? []).find((z) => z.id === 'head');
      if (hz) {
        const c0 = toStage(hz.x, hz.y), xf0 = pet.xf ?? {};
        const kx0 = xf0.kx ?? S, ky0 = xf0.ky ?? S;
        const dx0 = (p.x - c0.x) / (hz.rx * kx0 * 2.2), dy0 = (p.y - c0.y) / (hz.ry * ky0 * 2.2);
        headish = dx0 * dx0 + dy0 * dy0 <= 1;
      }
    }
    if (headish) {
      if (pet.mode === 'walk' || pet.mode === 'run') setMode('idle');
      press = null;   // 头区绝不 press：抓起→拖拽→松手 throw/drop→落地 crash 就是这条链
      pointer.samples = [{ t: now(p), x: p.x, y: p.y }];
      ruaDown = true; rua = null; ruaLast = { x: p.x, y: p.y, t: now(p) };
      ruaVel = { x: 0, y: 0 }; ruaTravel = 0; ruaHeadTime = 0; ruaDeepTime = 0;
      ruaMax = 0; ruaTier = 0; ruaStillAt = 0; ruaMelted = false;
      return true;
    }
    press = { x: p.x, y: p.y, t: now(p) };
    pointer.samples = [{ t: now(p), x: p.x, y: p.y }];
    // caught while falling or flying: held at once, since the body would fall on while the pointer moved the drag threshold
    if (pet.mode === 'air') { grab(); return true; }
    return true;
  }`,
        )
        .replace(
          `    pointer.vx = lerp(pointer.vx, velocity().x, .35);

    if (press && pet.mode !== 'drag' && Math.hypot(p.x - press.x, p.y - press.y) > 6) grab();`,
          `    pointer.vx = lerp(pointer.vx, velocity().x, .35);

    // 4.2 rua：按住头区期间走 rua 推进，指针本体隐藏（页面上的手接管），绝不转成拖拽
    if (ruaDown) { stepRua(p); return (pet.cursor = 'grab'); }   // 4.2：沿用原有手形（用户：不要换指针）
    if (press && pet.mode !== 'drag' && Math.hypot(p.x - press.x, p.y - press.y) > 6) grab();`,
        )
        .replace(
          `        else setExpr(Math.random() < .5 ? 'love' : 'shy');
        onEvent('touch', { kind: 'pet', asleep: pet.mode === 'sleep' });`,
          `        else setExpr(Math.random() < .5 ? 'love' : 'shy');
        // 4.2 分区：摸到哪个区发哪个区（头区划过仍是 pet 轻摸），文本由 World 组装
        const rz = zoneAt(p);
        onEvent('touch', rz && rz !== 'head' ? { kind: 'stroke', zone: rz } : { kind: 'pet', asleep: pet.mode === 'sleep' });`,
        )
        .replace(
          `  function pointerUp(p) {
    pet.cursor = '';
    if (!press) return;`,
          `  function pointerUp(p) {
    pet.cursor = '';
    if (ruaDown) { endRua(); return; }   // 4.2 头区 rua：press 是 null（防 crash），必须在 !press 判断前清 ruaDown——否则 rua 永不结束（用户实测「脱手还是 rua 状态」）
    if (!press) return;`,
        )
        .replace(
          `  function pointerLeave() { if (!press) pointer.inside = false; }`,
          `  function pointerLeave() { if (!press) pointer.inside = false; }   // 4.2：rua 出窗不结算（头贴窗口边，摸出去很正常）——headTime 冻结、回窗继续`,
        )
        .replace(
          `      facingNow: pet.facing,`,
          `      facingNow: pet.facing,
      // 4.2 rua 摸头的实时状态（null = 没在摸）：形象据此画「头朝手的反方向 + 表情档位」
      rua: rua ? { on: rua.on !== false, ux: rua.ux, uy: rua.uy, side: rua.side, face: rua.face, seconds: rua.seconds, melt: rua.melt, moving: rua.moving, fx: rua.fx } : null,   // on：弹簧开关（必须透传，漏了头就不动）`,
        );
      for (const probe of ['function stepRua', "kind: 'rua-start'", 'endRua()', "kind: 'stroke', zone", 'rua: rua ?', 'headish', 'down zone=', '头区绝不 press']) {
        if (!out.includes(probe)) throw new Error('ruaHead：锚点未命中 ' + probe);
      }
      return out;
    },
  },
  // ===== world.ts：4.2 rua 事件直达（不进聚合）=====
  {
    file: 'world', id: 'crashDedup',
    desc: 'crash/drop 文本去重：8 秒内同一条「重重落地，摔晕了一会儿」不重复 push（rua 误入拖拽时刷屏的兜底）',
    detect: (s) => /__lastCrashText/.test(s),
    apply: (s) => {
      const out = s.replace(
        "      case 'crash': text = m.crashed; break;",
        "      case 'crash': { const now = Date.now(); try { new Image().src = '/api/figure-log?m=' + encodeURIComponent('crash-src kind=crash t=' + JSON.stringify(t).slice(0, 80)); } catch {} if (this.__lastCrashText && now - this.__lastCrashText < 8000) return; this.__lastCrashText = now; text = m.crashed; break; }   // 4.2 去重 + 源头打点",
      );
      if (!out.includes('__lastCrashText')) throw new Error('crashDedup：锚点未命中');
      return out;
    },
  },
  {
    file: 'world', id: 'ruaEvents',
    desc: 'rua 事件（开始/升档/持续心跳/结束）立即直达给 AI，不走 2.5s 触摸聚合——文本只描述状态（谁在摸/多久/什么档位），她的回应自己组织',
    detect: (s) => /rua-start' \|\| kind === 'rua-tier'/.test(s),
    apply: (s) => s
      .replace(
        `  private onTouch(msg: PageMessage): void {
    if (!this.cfg.touch.enabled) return;
    const kind = String(msg.kind);
    if (kind === 'grab') return;`,
        `  private onTouch(msg: PageMessage): void {
    if (!this.cfg.touch.enabled) return;
    const kind = String(msg.kind);
    if (kind === 'grab') return;
    // 4.2 rua：开始/升档/持续心跳/结束各立即直达，不进 2.5s 聚合（摸头状态要实时）。
    // 文本只描述状态事实（谁在摸/摸了多久/她现在什么表情档位），她的回应完全自己组织。
    if (kind === 'rua-start' || kind === 'rua-tier' || kind === 'rua-still' || kind === 'rua-end') {
      // 残留的 drop/crash 聚合静默丢弃——flushTouch 会把它刷成「重重落地，摔晕了一会儿」
      // （rua 期间刷屏的真因：之前拖拽/掉落的 touch 对象还挂着 timer）
      if (this.touch) { clearTimeout(this.touch.timer); this.touch = null; }
      const u = this.userName, m = this.t;
      const tier = Number(msg.tier) || 0, seconds = Number(msg.seconds) || 0;
      const text = kind === 'rua-start' ? m.ruaStart(u)
        : kind === 'rua-tier' ? m.ruaTier(u, tier)
        : kind === 'rua-still' ? m.ruaStill(u, seconds)
        : m.ruaEnd(u, tier, seconds);
      void this.push('desktop-pet.touch', 'desktop-pet.touch', m.touch(text), 'flush',
        { meta: { touch: { kind, tier, seconds } } });
      return;
    }`,
      )
      .replace(
        `      case 'crash': text = m.crash; break;`,
        `      case 'crash': text = m.crash; break;
      case 'stroke': text = m.stroked(u, t.zone ?? 'head'); break;   // 4.2 分区摸一下`,
      )
      .replace(
        `      x: typeof msg.x === 'number' ? msg.x : null,`,
        `      x: typeof msg.x === 'number' ? msg.x : null,
      zone: typeof msg.zone === 'string' ? msg.zone : null,`,
      ),
  },
  // ===== model-text.ts：4.2 rua 事件文本（状态描述，非台词——她的回应自己想）=====
  {
    file: 'mtext', id: 'ruaText',
    desc: 'rua 事件文本模板（zh+en）：状态事实——谁在摸/摸了多久/她的表情档位（脸红/眉眼软/腻歪/融化），开始条带「先文字后表情」提示',
    detect: (s) => /ruaStart:/.test(s),
    apply: (s) => s
      .replace(
        '  petted: (user: string, n: number) => (n > 1 ? `${user}摸了你好几下` : `${user}摸了摸你的头`),',
        `  petted: (user: string, n: number) => (n > 1 ? \`\${user}摸了你好几下\` : \`\${user}摸了摸你的头\`),
  ruaStart: (user: string) => \`\${user}开始摸你的头啦，手还在头上没有停下。想说什么就先用文字说，不用急着发表情或动作——摸着的时候它们会被轻轻接住\`,
  stroked: (user: string, zone: string) => \`\${user}摸了摸你的\${({ face: '脸', chest: '胸口', tail: '尾巴', skirt: '裙子', legs: '腿' } as Record<string, string>)[zone] ?? zone}\`,
  ruaStill: (user: string, seconds: number) => \`\${user}的手还留在你头上，还在继续摸（已经摸了约 \${Math.round(seconds)} 秒）\`,
  ruaTier: (user: string, tier: number) => \`\${user}还在摸你的头\${tier >= 3 ? '，摸了好久好久，整个人都在慢慢融化' : tier === 2 ? '，摸得很温柔，眉眼都软下来了（已经脸红+眼睛眯起来了）' : '，轻轻地摸（脸已经红了）'}（rua 进行中）\`,
  ruaEnd: (user: string, tier: number, seconds: number) => \`\${user}停手了，这次摸了你的头约 \${Math.round(seconds)} 秒\${tier >= 3 ? '，摸了好久好久，整个人都融化掉了' : tier === 2 ? '，被摸得整个人腻歪腻歪的' : tier === 1 ? '，有点不舍得' : '，就轻轻摸了一下下'}\`,`,
      )
      .replace(
        '  petted: (user, n) => (n > 1 ? `${user} patted you several times` : `${user} patted your head`),',
        `  petted: (user, n) => (n > 1 ? \`\${user} patted you several times\` : \`\${user} patted your head\`),
  ruaStart: (user: string) => \`\${user} started stroking your head, the hand is still there. Say what you want in words first — expressions and moves are gently held back while being stroked\`,
  stroked: (user: string, zone: string) => \`\${user} stroked your \${({ face: 'face', chest: 'chest', tail: 'tail', skirt: 'skirt', legs: 'legs' } as Record<string, string>)[zone] ?? zone}\`,
  ruaStill: (user: string, seconds: number) => \`\${user}\'s hand is still on your head (about \${Math.round(seconds)}s now)\`,
  ruaTier: (user: string, tier: number) => \`\${user} keeps stroking your head\${tier >= 3 ? ' for a long long time — you are melting' : tier === 2 ? ' tenderly, your brows softening (cheeks flushed, eyes squeezed shut)' : ' gently (your cheeks are flushed)'} (rua ongoing)\`,
  ruaEnd: (user: string, tier: number, seconds: number) => \`\${user} stopped after about \${Math.round(seconds)}s of head pats\${tier >= 3 ? ' — you melted completely' : tier === 2 ? ' — you are all gooey and content' : tier === 1 ? ' — you feel a bit reluctant it ended' : ' — just a light little pat'}\`,`,
      )
  },
  // ===== figure-frame.js：帧间隙探测（摸头冻结 bug 定位，2026-11-20）=====
  {
    file: 'frame', id: 'tickGapLog',
    desc: '诊断：iframe 收到 tick 的墙上时钟间隙 >800ms 时打点——主线程卡（tick 断流）和 iframe 自身卡都在这里现形，配合 rAF-gap/后端 frame-gap 三层定位',
    detect: (s) => /tick-gap/.test(s),
    apply: (s) => {
      const out = s.replace(
        `    } else if (m.t === 'tick') {
      body.step(m.dt, m.draw);`,
        `    } else if (m.t === 'tick') {
      const __w = Date.now(), __g = __w - (globalThis.__lastTickW ?? __w);   // 诊断：tick 断流探测（摸头冻结定位）。Date.now：iframe 沙箱里 performance.now 不可用（形象包踩过）
      if (__g > 800) { try { new Image().src = '/api/figure-log?m=' + encodeURIComponent('tick-gap ' + Math.round(__g) + 'ms'); } catch { /* 诊断不致命 */ } }
      globalThis.__lastTickW = __w;
      const __s = Date.now();
      body.step(m.dt, m.draw);
      const __sd = Date.now() - __s;   // 诊断：step 自身耗时——tick-gap 伴随 step-slow = 形象代码卡；只有 tick-gap = 帧没送到（上层/IPC）
      if (__sd > 300) { try { new Image().src = '/api/figure-log?m=' + encodeURIComponent('step-slow ' + __sd + 'ms dt=' + (typeof m.dt === 'number' ? m.dt.toFixed(3) : m.dt)); } catch { /* 诊断不致命 */ } }`,
      );
      if (!out.includes('tick-gap')) throw new Error('tickGapLog：tick 锚点未命中');
      return out;
    },
  },
  // ===== pet-app.js：主线程 rAF 探测 + 触摸时间戳 =====
  {
    file: 'body', id: 'noHoverPet',
    desc: '关掉「划过 320px 就摸头」的原生反应（用户：鼠标从身上划过去就触发，还不用按键）',
    detect: (s) => /划过不再有任何反应/.test(s),
    apply: (s) => {
      const a = `    const over = hitPet(p);
    if (over && ['idle', 'look', 'sit', 'sleep'].includes(pet.mode)) {
      strokeAcc += Math.hypot(ddx, ddy);
      if (strokeAcc > 320 && petCool <= 0) {
        strokeAcc = 0; petCool = 2.5;
        play('purr', 'touch');
        if (pet.mode === 'sleep') emitHeart();
        else setExpr(Math.random() < .5 ? 'love' : 'shy');
        // 4.2 分区：摸到哪个区发哪个区（头区划过仍是 pet 轻摸），文本由 World 组装
        const rz = zoneAt(p);
        onEvent('touch', rz && rz !== 'head' ? { kind: 'stroke', zone: rz } : { kind: 'pet', asleep: pet.mode === 'sleep' });
      }
    }
    return (pet.cursor = over ? 'grab' : '');`;
      const b = `    const over = hitPet(p);
    // 2026-11-22：划过不再有任何反应（用户：鼠标从她身上划过去就触发摸头，还不用按键）。
    // 轻摸改成必须右键按住：头/脸是持续 rua，其它区在 pointerDown 里一次性处理。
    return (pet.cursor = over ? 'grab' : '');`;
      if (!s.includes(a)) throw new Error('noHoverPet：划过段锚点未命中');
      return s.replace(a, b);
    },
  },
  {
    file: 'body', id: 'emitEvent',
    desc: 'figure → 页面的事件桥：custom.emitEvent(kind, d) 透传 opts.onEvent（彩蛋台词气泡用）',
    detect: (s) => /custom\.emitEvent = /.test(s),
    apply: (s) => {
      const a = "  const onEvent = opts.onEvent || (() => {});";
      if (!s.includes(a)) throw new Error('emitEvent：onEvent 锚点未命中');
      return s.replace(a, a + "\n  custom.emitEvent = (kind, d) => onEvent(kind, d);   // figure 自己发的事件（彩蛋台词等）走同一条上报路");
    },
  },
  {
    file: 'petapp', id: 'rightHoldMenu',
    desc: '右键长按 = rua（kit 里按头区），单击 = 原来的菜单：250ms 内松开才算单击',
    detect: (s) => /右键长按 = rua/.test(s),
    apply: (s) => {
      const a = "document.addEventListener('contextmenu', (e) => {\n  e.preventDefault();\n  if (body?.hit({ x: e.clientX, y: e.clientY })) openMenu();\n});";
      const b = "/* 2026-11-22：右键长按 = rua（kit 里按头区），单击才是菜单。\n   在 Windows 上 contextmenu 是「右键松开」时触发，所以用按住的时长区分：\n   250ms 内松开 = 单击（菜单），超过 = 长按（rua 已经由 kit 接管，不弹菜单）。 */\nlet rightDownAt = 0;\ndocument.addEventListener('pointerdown', (e) => { if (e.button === 2) rightDownAt = performance.now(); }, { capture: true });\ndocument.addEventListener('pointerup', (e) => {\n  // 在别处（比如桌面）松开不会有 contextmenu，300ms 后自己清掉，免得影响下一次\n  if (e.button === 2) setTimeout(() => { rightDownAt = 0; }, 300);\n}, { capture: true });\ndocument.addEventListener('contextmenu', (e) => {\n  e.preventDefault();\n  const held = rightDownAt ? performance.now() - rightDownAt : 999;\n  rightDownAt = 0;\n  if (held < 250 && body?.hit({ x: e.clientX, y: e.clientY })) openMenu();\n});";
      if (!s.includes(a)) throw new Error('rightHoldMenu：contextmenu 锚点未命中');
      return s.replace(a, b);
    },
  },
  {
    file: 'petapp', id: 'ruaHand',
    desc: 'rua 的白手：照他们 HandWindow.cs 的顶点 + 逐顶点透视（手指并排、缝 2.5、拇指斜出），每帧重算 SVG path；大小/倾斜用 HandPoseFor 原公式',
    detect: (s) => /HAND_FINGER_X/.test(s),
    apply: (s) => {
      let out = s.replace('/* ---------- body events → World ---------- */', "/* ---------- rua 的白手（照他们 HandWindow.cs：顶点 + 逐顶点透视，不是一张平贴图）---------- */\nconst ruaHand = document.createElement('div');\nruaHand.className = 'rua-hand';\nruaHand.hidden = true;\nruaHand.style.cssText = 'position:fixed;left:0;top:0;width:160px;height:160px;pointer-events:none;z-index:2;opacity:0;transition:opacity .1s ease;will-change:transform';\nruaHand.innerHTML = '<svg viewBox=\"0 0 160 160\" width=\"160\" height=\"160\" aria-hidden=\"true\">'\n  + '<path class=\"h-edge\" fill=\"#ffffff\" stroke=\"#b9bdc9\" stroke-width=\"2.2\" stroke-linejoin=\"round\"/>'\n  + '</svg>';\nstage.append(ruaHand);\nconst ruaHandPath = ruaHand.querySelector('.h-edge');\n\n/* 他们的几何（HandWindow.cs:78-95）。局部坐标：x 向右、y 向指尖，原点在手掌中心。\n   手掌 = 切角矩形；四根手指 = **并排**的直边方块（FingerX 间距 11.5、宽 9 → 缝只有 2.5，\n   所以看起来是并拢的四指，不是张开的）；拇指从左下斜出去。 */\nconst HAND_PALM = [[-22, 17], [22, 17], [22, -6], [11, -17], [-11, -17], [-22, -6]];\nconst HAND_FINGER_X = [-17.25, -5.75, 5.75, 17.25];\nconst HAND_FINGER_LEN = [36, 41, 37, 29];\n\n/** 一根手指：宽 w、长 len，指尖两角切 cut；从 (bx,by) 往上，绕根部转 angle。 */\nfunction handBlock(bx, by, len, w, cut, angle) {\n  const h = w / 2;\n  const pts = [[bx - h, by], [bx - h, by + len - cut], [bx - h + cut, by + len],\n    [bx + h - cut, by + len], [bx + h, by + len - cut], [bx + h, by]];\n  if (!angle) return pts;\n  const c = Math.cos(angle), s = Math.sin(angle);\n  return pts.map(([x, y]) => {\n    const dx = x - bx, dy = y - by;\n    return [bx + dx * c - dy * s, by + dx * s + dy * c];\n  });\n}\nconst HAND_SHAPES = [\n  HAND_PALM,\n  handBlock(HAND_FINGER_X[0], 15, HAND_FINGER_LEN[0], 9, 2.8, 0),\n  handBlock(HAND_FINGER_X[1], 15, HAND_FINGER_LEN[1], 9, 2.8, 0),\n  handBlock(HAND_FINGER_X[2], 15, HAND_FINGER_LEN[2], 9, 2.8, 0),\n  handBlock(HAND_FINGER_X[3], 15, HAND_FINGER_LEN[3], 9, 2.8, 0),\n  handBlock(-12, -9, 36, 10.5, 3, 1.0),   // 拇指：从左下往左上斜出去\n];\n/* 他们 HandVisual.Persp：沿「头心→手」方向的距离越小，远端越扁、越缩。 */\nconst HAND_PERSP = .0065;\n\n/** 每个顶点单独做透视（他们 Project()：先按手朝向转+缩放，再沿方向压扁、远的变小）。 */\nfunction handProject([px, py], pose, cx, cy) {\n  const sx = px, sy = -py;                     // 局部 y 向指尖 → 屏幕 y 向下，取负\n  const c = Math.cos(pose.rot), s = Math.sin(pose.rot);\n  let vx = (sx * c - sy * s) * pose.k, vy = (sx * s + sy * c) * pose.k;\n  if (pose.sin > 0) {\n    const along = vx * pose.ux + vy * pose.uy;\n    const qx = vx - along * pose.ux, qy = vy - along * pose.uy;\n    const f = 1 / (1 + along * pose.sin * HAND_PERSP);\n    const a2 = along * pose.cos * f;\n    vx = qx * f + a2 * pose.ux; vy = qy * f + a2 * pose.uy;\n  }\n  return [cx + vx, cy + vy];\n}\n\n/* 头盒（屏幕上）：rua-start 时由 kit 带上来（他们 Behavior.HeadBox）。 */\nlet ruaHandHead = null;\n/* 他们的姿态（HandPoseFor）：按光标相对头心的位置倾斜，掌心朝头心，指尖朝左上约 40°。 */\nfunction ruaHandPose(cur) {\n  const hb = ruaHandHead;\n  if (!hb) return { rot: -40 * Math.PI / 180, k: .46, cos: 1, sin: 0, ux: 0, uy: 0 };\n  const ux0 = (cur.x - hb.x) / hb.rx, uy0 = (cur.y - hb.y) / hb.ry;\n  const r = Math.min(Math.hypot(ux0, uy0), 1.05);\n  const nz = Math.max(.52, Math.sqrt(Math.max(0, 1 - r * r * .7)));\n  const rest = -Math.PI / 2 - 40 * Math.PI / 180;\n  const angle = rest + clamp(ux0, -1, 1) * .22;\n  // 手的大小按**屏幕高度**推（用户 2026-11-22：现在能盖住脸，要跟眼睛差不多大；\n  // 而且缩放窗口时要跟着变）。620px 高的舞台 → k≈0.46，手高 73*k≈34px。\n  // 不用他们的 rx/78*.4：我们 touchZones.rx 是逻辑单位、比实际头宽偏大，\n  // 套进去手会大一倍（实测盖住整张脸）。\n  const k = innerHeight * 0.00052 * (1.15 + .1 * (1 - r));   // 620 高 → 手高 ≈24px（眼睛约 25~30px）\n  const len = Math.hypot(cur.x - hb.x, cur.y - hb.y);\n  const dx = len < 1 ? 0 : (cur.x - hb.x) / len, dy = len < 1 ? 0 : (cur.y - hb.y) / len;\n  return { rot: angle + Math.PI / 2, k, cos: nz, sin: Math.sqrt(1 - nz * nz), ux: dx, uy: dy };\n}\n/** 重算 path：每帧 6 组多边形逐顶点投影（和他们的 OnRender 一样）。 */\nfunction ruaHandDraw() {\n  if (ruaHand.hidden) return;\n  const p0 = cursor.at;\n  if (!p0) return;\n  const pose = ruaHandPose(p0);\n  const cx = 80, cy = 80;                       // 窗口 160 的中心 = 手掌中心\n  let d = '';\n  for (const shape of HAND_SHAPES) {\n    const [x0, y0] = handProject(shape[0], pose, cx, cy);\n    d += 'M' + x0.toFixed(2) + ' ' + y0.toFixed(2);\n    for (let i = 1; i < shape.length; i++) {\n      const [x, y] = handProject(shape[i], pose, cx, cy);\n      d += 'L' + x.toFixed(2) + ' ' + y.toFixed(2);\n    }\n    d += 'Z';\n  }\n  ruaHandPath.setAttribute('d', d);\n  ruaHand.style.transform = 'translate(' + (p0.x - 80) + 'px,' + (p0.y - 80) + 'px)';\n}\nlet ruaCursorCss = null;\nfunction showRuaHand(d) {\n  if (d && typeof d.hx === 'number') ruaHandHead = { x: d.hx, y: d.hy, rx: d.rx, ry: d.ry };\n  if (!ruaHand.hidden) return;\n  ruaHand.hidden = false;\n  ruaCursorCss = document.createElement('style');\n  ruaCursorCss.textContent = 'html, body, body * { cursor: none !important; }';\n  document.head.append(ruaCursorCss);\n  ruaHandDraw();\n  requestAnimationFrame(() => { ruaHand.style.opacity = '1'; });\n}\nfunction hideRuaHand() {\n  if (ruaHand.hidden) return;\n  ruaHand.style.opacity = '0';\n  if (ruaCursorCss) { ruaCursorCss.remove(); ruaCursorCss = null; }\n  setTimeout(() => { ruaHand.hidden = true; }, 110);\n}\ndocument.addEventListener('pointermove', ruaHandDraw, { passive: true });\n" + '\n/* ---------- body events → World ---------- */');
      if (!out.includes('function showRuaHand')) throw new Error('ruaHand：插入锚点未命中');
      out = out.replace(
        "    if (d.kind === 'grab') closeMenu();",
        "    if (d.kind === 'grab') closeMenu();\n    // rua 的白手（他们 HandWindow）：开始摸出现（带头的盒子）、松手淡出\n    if (d.kind === 'rua-start') showRuaHand(d);\n    else if (d.kind === 'rua-end') hideRuaHand();",
      );
      if (!out.includes('showRuaHand(d);')) throw new Error('ruaHand：onBody 分支未命中');
      return out;
    },
  },
  {
    file: 'petapp', id: 'skitNote',
    desc: '彩蛋台词气泡：figure 发 bubble 事件 → 头顶临时气泡，逐字打出 + 每字一声 babble + 宽度随字数增长（不进 queue/上下文）',
    detect: (s) => /function showSkitNote/.test(s),
    apply: (s) => {
      let out = s.replace('/* ---------- body events → World ---------- */', "/* ---------- 彩蛋气泡：figure 自己的台词，不排队、不发给 World ---------- */\nconst skitNote = document.createElement('div');\nskitNote.className = 'bubble say skit-note';\nskitNote.hidden = true;\nskitNote.style.pointerEvents = 'none';\nstage.append(skitNote);\nlet skitNoteAt = -Infinity, skitNoteText = '', skitNoteShown = 0, skitNotePause = 0;\n/* 打字速度 13 字/秒，句读停一下（和她说真话时的节奏接近） */\nconst SKIT_RATE = 13, SKIT_PAUSE = 0.16, SKIT_PUNCT = /[,.!?;:…，。！？；：、]/;\nconst SKIT_SILENT = /[\\s,.!?;:…，。！？；：、「」『』()（）]/;\n/* 相对身体中线左移（px）：模型边界框被右侧尾巴撑宽，锚点中心偏右约 24px。\n   只修彩蛋气泡，不动她的对话气泡（那个是 Coo 的原定位）。 */\nconst SKIT_DX = -24;\n/** 正对头顶居中；宽度随字数增长（打字时气泡会一格格变大）。 */\nfunction placeSkitNote(a) {\n  const bw = skitNote.offsetWidth, bh = skitNote.offsetHeight;\n  const cx = a.x + SKIT_DX;\n  const left = clamp(cx - bw / 2, 8, Math.max(8, innerWidth - bw - 8));\n  const top = Math.max(6, a.y - bh - 10 * prefs.bubbleSize);\n  skitNote.style.left = f(left) + 'px';\n  skitNote.style.top = f(top) + 'px';\n  skitNote.style.setProperty('--tail', f(clamp(cx - left, 16, Math.max(16, bw - 16))) + 'px');\n}\n/** 她说的小声一句：只在气泡空着时出现，逐字打出来（每个字一声），到点自己消失，跟着身体走。 */\nfunction showSkitNote(text, seconds) {\n  const a = at()?.bubble;\n  if (!text || !a || item || !bubble.hidden) return;   // 正在对话/有问答挂着：不插嘴\n  skitNoteText = text;\n  skitNoteShown = 0;\n  skitNotePause = 0;\n  skitNote.textContent = '';\n  skitNote.hidden = false;\n  skitNote.classList.remove('pop');\n  void skitNote.offsetWidth;\n  skitNote.classList.add('pop');\n  sfx.pop();                            // 和对话气泡一样的弹出音\n  placeSkitNote(a);\n  skitNoteAt = T + clamp(Number(seconds) || 3.4, 1.5, 6);\n}\nfunction stepSkitNote(dt) {\n  if (skitNote.hidden) return;\n  const a = at()?.bubble;\n  if (T >= skitNoteAt || !a || item || !bubble.hidden) { skitNote.hidden = true; return; }\n  if (skitNoteShown < skitNoteText.length) {\n    if (skitNotePause > 0) skitNotePause -= dt;\n    else {\n      const was = skitNote.textContent.length;\n      skitNoteShown = Math.min(skitNoteText.length, skitNoteShown + SKIT_RATE * dt);\n      const n = Math.floor(skitNoteShown);\n      // 每个新字一声（和她说真话时同一个 babble：有配音就用配音，没有就合成）\n      for (let i = was; i < n; i++) { const ch = skitNoteText[i]; if (!SKIT_SILENT.test(ch)) sfx.babble(ch); }\n      const head = skitNoteText.slice(0, n);\n      skitNote.textContent = head;\n      if (head && SKIT_PUNCT.test(head[head.length - 1])) skitNotePause = SKIT_PAUSE;   // 省略号逐点、句号停一下\n    }\n  }\n  placeSkitNote(a);\n}\n" + '\n/* ---------- body events → World ---------- */');
      if (!out.includes('function showSkitNote')) throw new Error('skitNote：插入锚点未命中');
      out = out.replace(
        "  } else if (kind === 'mode') {\n    reportPosition();",
        "  } else if (kind === 'bubble') {\n    showSkitNote(d?.text, d?.seconds);\n  } else if (kind === 'mode') {\n    reportPosition();",
      );
      if (!out.includes("kind === 'bubble'")) throw new Error('skitNote：onBody 分支未命中');
      out = out.replace('      stepStatus();\n', '      stepStatus();\n      stepSkitNote(dt);\n');
      if (!out.includes('stepSkitNote(dt);')) throw new Error('skitNote：frame 推进未命中');
      return out;
    },
  },
  {
    file: 'petapp', id: 'rafGapLog',
    desc: '诊断：pet 页 rAF 间隙 >800ms 时打点——主线程被同步工作卡住（呼吸/浮动全停的画面定住）在这里现形',
    detect: (s) => /rAF-gap/.test(s),
    apply: (s) => {
      const out = s.replace(
        "runFrames(frame, { refreshed: () => { if (windowShown) lastFrameAt = performance.now(); } });",
        `runFrames(frame, {
  refreshed: (now) => {
    const __g = now - (globalThis.__lastRF ?? now);   // 诊断：主线程卡顿探测（摸头冻结定位）
    if (windowShown && __g > 800) { try { new Image().src = '/api/figure-log?m=' + encodeURIComponent('rAF-gap ' + Math.round(__g) + 'ms'); } catch { /* 诊断不致命 */ } }
    globalThis.__lastRF = now;
    if (windowShown) lastFrameAt = performance.now();
  } });`,
      );
      if (!out.includes('rAF-gap')) throw new Error('rafGapLog：runFrames 锚点未命中');
      return out;
    },
  },
  {
    file: 'petapp', id: 'touchMark',
    desc: '诊断：触摸事件上报时刻打点（对齐冻结时间线用）',
    detect: (s) => /'touch ' \+ /.test(s),
    apply: (s) => {
      const out = s.replace(
        `  } else if (kind === 'touch') {
    send({ t: 'touch', ...d });`,
        `  } else if (kind === 'touch') {
    try { new Image().src = '/api/figure-log?m=' + encodeURIComponent('touch ' + (d?.kind ?? '?') + ' @' + new Date().toTimeString().slice(0, 8)); } catch { /* 诊断不致命 */ }   // 诊断：对齐时间线
    send({ t: 'touch', ...d });`,
      );
      if (!out.includes("'touch ' + ")) throw new Error('touchMark：onBody touch 锚点未命中');
      return out;
    },
  },
  // ===== packs.ts / world.ts：形象包自带身体说明书（阶段一，2026-11-20）=====
  {
    file: 'packs', id: 'manualManifest',
    desc: 'figure.json 新增 manual 字段（{zh,en}，教修饰/方向/叠加这些词表外的语法）——manifest 白名单式构造，不加这层字段会被丢弃',
    detect: (s) => /manual\?: Names/.test(s),
    apply: (s) => s
      .replace(
        `  /** The words the bot may use while this body is on: every expression and motion it does. */
  vocab: VocabWord[];`,
        `  /** The words the bot may use while this body is on: every expression and motion it does. */
  vocab: VocabWord[];
  /** 形象包自带身体说明书（figure.json 的 manual 字段）：拼在 {{pet.vocab}} 词表后的语法补充，词表里没有的（修饰/方向/叠加节奏）。 */
  manual?: Names;`,
      )
      .replace(
        '    ...(raw.thumb ? { thumb: raw.thumb as string } : {}),',
        `    ...(raw.thumb ? { thumb: raw.thumb as string } : {}),
    ...(namesOf(raw.manual) ? { manual: namesOf(raw.manual)! } : {}),`,
      ),
  },
  {
    file: 'world', id: 'manualPrompt',
    desc: '{{pet.vocab}} 渲染时把形象包 manual 拼到词表后面——说明书随形象走，换形象自动切换',
    detect: (s) => /manualSuffix/.test(s),
    apply: (s) => s
      .replace(
        `  private vocab(): VocabWord[] {`,
        `  /** 形象包自带的身体说明书（figure.json `+"`manual`"+`）：拼在 {{pet.vocab}} 词表后的语法补充。 */
  private manualSuffix(language: ModelLanguage): string {
    const m = this.currentPack()?.manifest?.manual;
    if (!m) return '';
    const t = m[language] ?? m.zh ?? '';
    return t ? '\\n\\n' + t : '';
  }
  private vocab(): VocabWord[] {`,
      )
      .replace(
        `      'pet.vocab': vocabTable(this.vocab(), language),`,
        `      'pet.vocab': vocabTable(this.vocab(), language) + this.manualSuffix(language),`,
      ),
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
  if (!it.bubbleOpen && it.kind === 'say') {   // 只管 say：ask 的气泡在开始时已用 ask 样式打开（带 .b-opts 按钮容器），用 say 重开会毁掉按钮（2026-11-20 更新气泡无按钮修复）
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
    // 2026-11-21 修：×3 是后缀（原来 ^ 匹配开头永远剥不掉）、:左/:右 方向后缀也没剥 → 带参数词全被 dropped。
    const bare = w.replace(/^[微大快慢轻猛]+/, '').replace(/[×xX]\\d+$/, '').replace(/[:：](左|右)$/, '');
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
  // ===== 2026-11-21 对齐 DeepFish：每改一处都必须登记在这里（否则 Coo 更新就丢） =====
  {
    file: 'body', id: 'noBrSquash',
    desc: '去掉 canvas 呼吸正弦 br（整图一上一下的真凶）：呼吸交给 figure 的 ParamBreath 走物理，kit 不再叠一层',
    detect: (s) => /const sy = \(1 - pet\.sq\)/.test(s) && !/1 \+ \.016 \* br/.test(s),
    apply: (s) => {
      let out = s;
      out = out.replace(/(const sx = \(1 \+ pet\.sq \* \.7\) \* \(1 - \.05 \* pet\.stretch\)) \* \(1 - \.009 \* br\);/, '$1;');
      out = out.replace(/(const sy = \(1 - pet\.sq\) \* \(1 \+ \.09 \* pet\.stretch\)) \* \(1 \+ \.016 \* br\);/, '$1;');
      if (out === s) return null;
      return out;
    },
  },
  {
    file: 'body', id: 'blinkBd',
    desc: '眨眼总时长 .16 → .3（对齐 SDK CubismEyeBlink 的 0.1 降 + 0.05 停 + 0.15 升）',
    detect: (s) => /const bd = \.3 \+ \.3 \* pet\.drowse/.test(s),
    apply: (s) => {
      const out = s.replace('const bd = .16 + .3 * pet.drowse', 'const bd = .3 + .3 * pet.drowse');
      return out === s ? null : out;
    },
  },
  {
    file: 'body', id: 'trackPos',
    desc: '鼠标跟随从「方向」改成「位置」（PetWindow.cs:948 的 /500 /400）：原来鼠标在左任意位置头都只转固定 5 度，穿中心还会猛甩',
    detect: (s) => /\(pointer\.x - head\.x\) \/ 500/.test(s),
    apply: (s) => {
      const out = s.replace(
        /      const k = Math\.min\(1, pm \/ 120\);\r?\n      return \[pdx[\s\S]*?\];/,
        [
          '      // 2026-11-21 完全对齐 DeepFish（PetWindow.cs 940行）：',
          '      //   x = clamp((cursor.X - headX) / 500, -1, 1)',
          '      //   y = clamp((headY - cursor.Y) / 400, -1, 1)',
          '      // 他们用**固定像素 500/400**（几乎半个屏幕的范围）——鼠标越远影响越大。之前用形象宽/头半径都太窄，稍远就饱和。',
          '      const _px0 = Math.max(-1, Math.min(1, (pointer.x - head.x) / 500));',
          '      const _py0 = Math.max(-1, Math.min(1, (head.y - pointer.y) / 400));',
          '      return [_px0 * 5 * pet.facing, _py0 * 4];',
        ].join('\n'),
      );
      return out === s ? null : out;
    },
  },
  {
    file: 'body', id: 'ruaDtCap',
    desc: 'rua 的 dt 照他们的定时器 clamp(.001,.05)。下限不能用 .016 —— stepRua 是每个 pointermove 调一次，高回报率鼠标 1~2ms 一个事件全被抬到 16ms，时间按倍数膨胀（15 秒变 25 秒）',
    detect: (s) => /Math\.min\(\.05, Math\.max\(0,/.test(s),
    apply: (s) => {
      const a = "    const dt = Math.max(.016, (t - ((ruaLast && ruaLast.t) || t)) / 1000);";
      if (!s.includes(a)) return null;   // 容错：ruaHead 没打上时安静跳过
      return s.replace(a, "    // 2026-11-22：上下限照他们的定时器 clamp(.001,.05)。\n    // 下限原来是 .016 —— 那是「一帧」，但 stepRua 是每个 pointermove 调一次，\n    // 高回报率鼠标 1~2ms 一个事件，全被抬到 16ms，rua 15 秒被算成 25 秒（1.67 倍）。\n    // 上限 .05 保留：鼠标停住再动，不该把停顿算成在摸。\n    const dt = Math.min(.05, Math.max(0, (t - ((ruaLast && ruaLast.t) || t)) / 1000));");
    },
  },
  {
    file: 'body', id: 'ruaTune',
    desc: 'rua 事件节奏 + 1.5 秒宽限 + crash 抑制：20 秒后每 5.5 秒一次「还在摸」；手短暂离开/停下 1.5 秒内不结束；rua 后 3 秒内不发 crash（刷屏）',
    detect: (s) => /ruaLingerAt/.test(s),
    apply: (s) => {
      let out = s;
      // 1) 变量
      out = out.replace("  let rua = null;   // 活跃时每帧传给形象：{ ux, uy, side, face, seconds, melt, moving, fx }",
        "  let rua = null;   // 活跃时每帧传给形象：{ ux, uy, side, face, seconds, melt, moving, fx }\n  let ruaLingerAt = 0;   // 1.5 秒宽限开始时刻（手离开头区/停下时）\n  let lastRuaAt = -9;    // 最近一次 rua 活动（crash 抑制用）");
      if (!out.includes('ruaLingerAt = 0')) throw new Error('ruaTune：变量未插入');
      // 2) 事件间隔：融化档（20s+）5.5 秒，其余 2.5 秒（用户：20 秒后每 5~6 秒才推一次）
      out = out.split('ruaStillAt = t + 2500;').join('ruaStillAt = t + (ruaTier >= 3 || tier >= 3 ? 5500 : 2500);');
      if (!out.includes('5500')) throw new Error('ruaTune：间隔未替换');
      // 3) 1.5 秒宽限（放在 stepRua 末尾）
      const a2 = "      onEvent('touch', { kind: 'rua-still', tier: ruaTier, seconds: Math.max(rua.seconds, ruaMax) });   // 峰值，防倒退\n    }\n  }";
      if (!out.includes(a2)) throw new Error('ruaTune：stepRua 尾部锚点未命中');
      out = out.replace(a2, "      onEvent('touch', { kind: 'rua-still', tier: ruaTier, seconds: Math.max(rua.seconds, ruaMax) });   // 峰值，防倒退\n    }\n    // 1.5 秒宽限（用户 2026-11-22）：手短暂离开头区、或停下来歇一下，不立刻结束——\n    // 这段时间内回来就接着摸，超时才结算并发结束文本。松手（pointerup）仍然立即结束。\n    lastRuaAt = t;\n    // 只对「手离开头区」宽限：手停在头上不动（慢慢摸/歇一下）不算断开。\n    if (onHead) ruaLingerAt = 0;\n    else if (!ruaLingerAt) ruaLingerAt = t;\n    else if (t - ruaLingerAt > 1500) { endRua(); return; }\n  }");
      // 4) crash 抑制：rua 后 3 秒内不算摔晕
      const a3 = "    if (kind === 'throw' && impact > 1000) { setMode('dizzy'); onEvent('touch', { kind: 'crash' }); return; }";
      if (!out.includes(a3)) throw new Error('ruaTune：crash 锚点未命中');
      out = out.replace(a3, "    // 2026-11-22：rua 之后 3 秒内的「摔飞」不算摔晕——摸头时偶尔会顺着拖拽链\n    // 把她甩出去，World 把 crash 聚合成「你重重落地，摔晕了一会儿」刷进聊天。\n    if (kind === 'throw' && impact > 1000) {\n      // 2026-11-22：**先不发 crash 事件**。摔晕的表现（dizzy）保留，只是不往聊天推文本。\n      // 原因：这条在 web 层，重启 world 就生效；World 那边「单独 crash 丢弃」要整个应用重启。\n      // 摸头时会顺着拖拽链产生一堆 throw，World 把残留 crash 聚合成\n      // 「你重重落地，摔晕了一会儿」刷屏（用户实测 14 条）。\n      setMode('dizzy'); return;\n    }");
      // 5) 松手后 6 秒不做闲时动作（摸后 mood 要演 3.4~6 秒）
      const a5 = "    ruaDown = false;\n    const held = Math.round(ruaMax * 10) / 10;";
      if (!out.includes(a5)) throw new Error('ruaTune：endRua 锚点未命中');
      out = out.replace(a5, "    ruaDown = false;\n    // 松手后 6 秒不做闲时动作：摸后 mood 还在演，插动作会抢表情\n    pet.idleHoldUntil = T + 6;\n    const held = Math.round(ruaMax * 10) / 10;");
      // 6) decide 尊重冷却
      const a6 = "  function decide() {";
      if (!out.includes(a6)) throw new Error('ruaTune：decide 锚点未命中');
      out = out.replace(a6, a6 + "\n    if (T < (pet.idleHoldUntil ?? 0)) return;   // rua 收尾期：摸后 mood 还在演");
      return out;
    },
  },
  {
    file: 'body', id: 'ruaNoIdle',
    desc: 'rua 期间不做闲时动作（他们 behavior.Touching：摸头时她不会自己走/跳/坐，只保持站着被摸）',
    detect: (s) => /rua\\.\\n\\.\\n\\.\\n/.test(s) || s.includes('rua 期间不做闲时动作'),
    apply: (s) => {
      const a = "  function decide() {";
      if (!s.includes(a)) throw new Error('ruaNoIdle：锚点未命中');
      return s.replace(a, a + "\n    if (ruaDown) return;   // rua 期间不做闲时动作（他们 behavior.Touching = true）\n    if (T < (pet.idleHoldUntil ?? 0)) return;   // rua 刚结束：摸后 mood 还在演，别插动作");
    },
  },
  {
    file: 'body', id: 'ruaHeadBox',
    desc: 'rua-start 带上头的盒子（hx/hy/rx/ry）：白手要按他们的 HandPoseFor 算大小和倾斜，必须知道头心与半宽',
    detect: (s) => /hx: c\.x, hy: c\.y, rx:/.test(s),
    apply: (s) => {
      const a = "onEvent('touch', { kind: 'rua-start' });";
      if (!s.includes(a)) throw new Error('ruaHeadBox：锚点未命中');
      return s.replace(a, "onEvent('touch', { kind: 'rua-start', hx: c.x, hy: c.y, rx: head.rx * hkx, ry: head.ry * hky });");
    },
  },
  {
    file: 'world', id: 'ruaCrashGuard',
    desc: 'rua 期间丢弃 crash/drop/throw：右键摸头会顺带发出 drag 链的 touch，World 把残留 crash 聚合成「你重重落地，摔晕了一会儿」刷进聊天',
    detect: (s) => /ruaActive/.test(s),
    apply: (s) => {
      let out = s.replace(
        "  private touch: TouchBatch | null = null;",
        "  private touch: TouchBatch | null = null;\n  /** rua（右键摸头）进行中：这期间的拖拽/掉落事件一律丢弃（2026-11-22 修刷屏） */\n  private ruaActive = false;",
      );
      if (!out.includes('ruaActive')) throw new Error('ruaCrashGuard：字段未插入');
      out = out.replace(
        "    const kind = String(msg.kind);\n    if (kind === 'grab') return;",
        "    const kind = String(msg.kind);\n    if (kind === 'grab') return;\n    // 2026-11-22：rua 期间丢掉 crash/drop/throw —— 右键长按摸头时页面偶尔还顺着拖拽链\n    // 发出 throw/crash，World 把残留的 crash 聚合成「你重重落地，摔晕了一会儿」刷进聊天。\n    if (this.ruaActive && (kind === 'crash' || kind === 'drop' || kind === 'throw')) return;",
      );
      if (!out.includes("kind === 'crash' || kind === 'drop'")) throw new Error('ruaCrashGuard：丢弃分支未命中');
      out = out.replace(
        "      if (this.touch) { clearTimeout(this.touch.timer); this.touch = null; }",
        "      if (this.touch) { clearTimeout(this.touch.timer); this.touch = null; }\n      this.ruaActive = kind !== 'rua-end';",
      );
      if (!out.includes("this.ruaActive = kind !== 'rua-end';")) throw new Error('ruaCrashGuard：开关未插入');
      // 更根本的一条：crash 只是 throw/drop 的「摔晕了」补充标记，单独出现一律丢弃。
      const oldCrash = "    if (kind === 'crash' && this.touch && (this.touch.kind === 'throw' || this.touch.kind === 'drop')) {\n      this.touch.crashed = true;\n      return;\n    }";
      if (!out.includes(oldCrash)) throw new Error('ruaCrashGuard：crash 分支未命中');
      out = out.replace(oldCrash, "    // 2026-11-22：crash 只给 throw/drop 打标记，**单独出现一律丢弃**。\n    // 之前没有对应 throw/drop 时会新建一个 touch，2.5 秒后 flush 成「你重重落地，摔晕了一会儿」\n    // —— rua 时页面顺着拖拽链反复发 crash，聊天里就刷屏了（用户截图 10 条相同）。\n    if (kind === 'crash') {\n      if (this.touch && (this.touch.kind === 'throw' || this.touch.kind === 'drop')) this.touch.crashed = true;\n      return;\n    }");
      return out;
    },
  },
  {
    file: 'body', id: 'ruaSpeed',
    desc: 'rua 帧里多带一个真实手速 speed（猛摸判据：|ruaVel| 不做 clamp，fx 只是水平的 1/600）',
    detect: (s) => /rua\.speed = speed/.test(s),
    apply: (s) => {
      const a = "    rua.fx = Math.max(-1, Math.min(1, ruaVel.x / 600));";
      if (!s.includes(a)) throw new Error('ruaSpeed：锚点未命中');
      let out = s.replace(a, a + "\n    rua.speed = speed;   // 2026-11-22：真实手速（px/s），猛摸瞪眼用它判定");
      // frame.rua 也要带 speed（漏了的话 figure 收不到）
      out = out.replace('melt: rua.melt, moving: rua.moving, fx: rua.fx', 'melt: rua.melt, moving: rua.moving, fx: rua.fx, speed: rua.speed');
      return out;
    },
  },
  {
    file: 'body', id: 'rightClickRua',
    desc: '右键 = rua、左键 = 拖拽（和 DeepFish 一样左拖右摸）：crash 链（按头→拖拽→松手摔）从根断掉，不再靠头区判断分叉',
    detect: (s) => /p\.button === 2/.test(s),
    apply: (s) => {
      const out = s.replace(
        /    const rz0 = zoneAt\(p\);[\s\S]*?\n    press = \{/,
        [
          '    // 2026-11-21 用户定：右键 = rua（和 DeepFish 一样左拖右摸）。彻底和拖拽分开——crash 链断掉。',
          '    // 右键永远 press=null，不进 grab/drop，摸哪都行（不再判头区，头区只影响手感分区）。',
          "    if (p.button === 2) {",
          "      if (pet.mode === 'walk' || pet.mode === 'run') setMode('idle');",
          '      press = null;',
          '      pointer.samples = [{ t: now(p), x: p.x, y: p.y }];',
          '      ruaDown = true; rua = null; ruaLast = { x: p.x, y: p.y, t: now(p) };',
          '      ruaVel = { x: 0, y: 0 }; ruaTravel = 0; ruaHeadTime = 0; ruaDeepTime = 0;',
          '      ruaMax = 0; ruaTier = 0; ruaStillAt = 0; ruaMelted = false;',
          '      return true;',
          '    }',
          '    // 左键 = 拖拽/戳（原版）',
          '    press = {',
        ].join('\n'),
      );
      return out === s ? null : out;
    },
  },
  {
    file: 'body', id: 'ruaHeadOnly',
    desc: '右键只有头/脸区进入 rua（用户：摸哪里都算摸头）；其它区不接管，留给页面区分单击/长按',
    detect: (s) => /只有头\/脸才进入 rua/.test(s),
    apply: (s) => {
      const a = `    if (p.button === 2) {
      if (pet.mode === 'walk' || pet.mode === 'run') setMode('idle');
      press = null;`;
      const b = `    if (p.button === 2) {
      if (pet.mode === 'walk' || pet.mode === 'run') setMode('idle');
      press = null;
      // 2026-11-22：只有头/脸才进入 rua（用户：摸哪里都算摸头）。其它区右键不接管，
      // 交给页面区分单击（菜单）和长按（P3 的一次性轻摸）。
      {
        const _z = zoneAt(p);
        if (_z !== 'head' && _z !== 'face') { pointer.samples = [{ t: now(p), x: p.x, y: p.y }]; return true; }
      }`;
      if (!s.includes(a)) throw new Error('ruaHeadOnly：pointerDown 锚点未命中');
      return s.replace(a, b);
    },
  },
  {
    file: 'body', id: 'blinkFrame',
    desc: 'frame 加 blinkAge/blinkDur（figure 用 SDK 眨眼时需要年龄/时长；kit 只给曲线值不够）',
    detect: (s) => /blinkAge: pet\.blinkAge/.test(s),
    apply: (s) => {
      const out = s.replace('t: T, blink, eyeClose,', 't: T, blink, blinkAge: pet.blinkAge, blinkDur: bd, eyeClose,');
      return out === s ? null : out;
    },
  },
  {
    file: 'body', id: 'velY',
    desc: '垂直速度 velY + frame 传 velX/velY（figure 的拖拽惯性 sway 要用；原来只有 velX）',
    detect: (s) => /velY: pet\.velY/.test(s),
    apply: (s) => {
      let out = s
        .replace('prevA: null, velX: 0,', 'prevA: null, prevAY: null, velX: 0, velY: 0,')
        .replace(
          "    const AX = pet.mode === 'drag' ? pet.dx : pet.x;\n    if (pet.prevA != null) pet.velX = lerp(pet.velX, (AX - pet.prevA) / dt, .25);",
          "    const AX = pet.mode === 'drag' ? pet.dx : pet.x;\n    const AY = pet.mode === 'drag' ? pet.dy : pet.y;\n    if (pet.prevA != null) pet.velX = lerp(pet.velX, (AX - pet.prevA) / dt, .25);\n    // 2026-11-21 垂直速度（拖拽惯性 sway 要它；和 velX 同法）\n    if (pet.prevAY != null) pet.velY = lerp(pet.velY, (AY - pet.prevAY) / dt, .25);",
        )
        .replace('    pet.prevA = AX;', '    pet.prevA = AX;\n    pet.prevAY = AY;')
        .replace('swing: pet.swing,', 'swing: pet.swing, velX: pet.velX, velY: pet.velY,');
      return out === s ? null : out;
    },
  },
  {
    file: 'petapp', id: 'rightButton',
    desc: '右键放行 + button 透传（原来 e.button !== 0 直接 return，右键被丢掉，rua 没法用右键）',
    detect: (s) => /e\.button !== 0 && e\.button !== 2/.test(s),
    apply: (s) => {
      let out = s
        .replace("stage.addEventListener('pointerdown', (e) => {\n  if (e.button !== 0) return;", "stage.addEventListener('pointerdown', (e) => {\n  if (e.button !== 0 && e.button !== 2) return;   // 2026-11-21：右键放行（rua 用，和 DeepFish 一样左拖右摸）")
        .replace(
          'const p = { x: e.clientX, y: e.clientY, t: e.timeStamp };',
          'const p = { x: e.clientX, y: e.clientY, t: e.timeStamp, button: e.button };',
        );
      return out === s ? null : out;
    },
  },
  {
    file: 'script', id: 'actModifierSuffix',
    desc: '修饰词正则：×3 与 :左/:右 都是后缀（原来只剥前缀，带参数的词全被 dropped）',
    detect: (s) => /\.replace\(\/\[×xX\]\\d\+\$\/, ''\)/.test(s),
    apply: (s) => {
      const out = s.replace(
        "const bare = w.replace(/^[微大快慢轻猛]+/, '').replace(/^[×xX]\\d+/, '');",
        [
          "// 2026-11-21 修：×3 是后缀（原来 ^ 匹配开头永远剥不掉）、:左/:右 方向后缀也没剥 → 带参数词全被 dropped。",
          "    const bare = w.replace(/^[微大快慢轻猛]+/, '').replace(/[×xX]\\d+$/, '').replace(/[:：](左|右)$/, '');",
        ].join('\n'),
      );
      return out === s ? null : out;
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
