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
  chat: `${DIR}/src/chat.ts`,
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
    // 2026-11-23 用户：「头盒子…这个能抄吗？」—— 抄。
    // 他们 Behavior.HeadBox(shape) 按**形象包围盒的比例**给头中心/半宽/半高：
    //   chibi (X .5, Y .31, Rx .26, Ry .22) / full (.5,.19,.12,.085) / 其它 (.5,.225,.19,.095)
    // 我们之前用 touchZones 里那套 256 逻辑坐标 —— 实测 rx=205，视觉头宽只有 ~120，
    // 虚高 1.6 倍，所以 side .65 要手离头心 133px 才触发（摸右脸永远够不着 → 单闭眼失效）。
    // 中心仍沿用 touchZones 的 head（已验证能摸到），只有半径换成他们的比例。
    const _zones = custom?.touchZones?.() ?? [];
    const _zHead = _zones.find((z) => z.id === 'head') ?? { x: 128, y: 50, rx: 74, ry: 40 };
    const c = toStage(_zHead.x, _zHead.y);
    const xf2 = pet.xf ?? {};
    const hkx = xf2.kx ?? S, hky = xf2.ky ?? S;
    // touchZones 现在是 figure 按包围盒比例算的（模型坐标），这里乘缩放转屏幕像素。
    const headRx = _zHead.rx * hkx, headRy = _zHead.ry * hky;
    const head = { x: _zHead.x, y: _zHead.y, rx: headRx, ry: headRy };
    // 2026-11-22 用户：左右摆得比他们大得多。之前 *.35 等于 2.86 倍增益（当时为了脸上小范围也能动），\n    // 但 touchZones.rx 本身虚高（实测 205，真实头半宽约 125），再放大就一碰就顶到极限。改回 .75。\n    // 2026-11-23 用户：rua 到右脸要闭右眼、摸脸中间要双眼闭 —— 现在都不行。
    // 根因：side / face 判定和「头角度摆动幅度」共用了一个带 .75 增益的 ux（那个增益是为了
    // 压左右摆幅），结果侧向阈值被一起调迟钝。他们把两件事分得很清楚：
    //   ux = clamp((x-hx)/rx)  ← 没有增益，头边缘 = ±1，side .65 就在这个尺度上
    // 所以这里恢复他们的口径：uxRaw 给 side/face，ux（打折后的）只给头角度。
    const uxRaw = Math.max(-1.3, Math.min(1.3, (p.x - c.x) / headRx));
    const ux = Math.max(-1.3, Math.min(1.3, uxRaw / .75));   // 驱动头角度：我们 touchZones.rx 虚高，打折
    const uy = Math.max(-1.3, Math.min(1.3, (p.y - c.y) / headRy));
    if (t - (globalThis.__ruaDbg ?? 0) > 2000) { globalThis.__ruaDbg = t; try { new Image().src = '/api/figure-log?m=' + encodeURIComponent('rua p=' + Math.round(p.x) + ',' + Math.round(p.y) + ' c=' + Math.round(c.x) + ',' + Math.round(c.y) + ' uxRaw=' + uxRaw.toFixed(2) + ' uy=' + uy.toFixed(2) + ' side=' + rua.side + ' face=' + rua.face + ' on=' + onHead + ' rx=' + Math.round(headRx) + ' ry=' + Math.round(headRy)); } catch {} }
    if (engaged && !rua) { rua = { ux: 0, uy: 0, side: 0, face: false, seconds: 0, melt: 0, moving: false, fx: 0 }; onEvent('touch', { kind: 'rua-start' }); }
    if (!rua) return;
    // 单闭哪只眼：手越过头的左右两侧才闭，进出各有一道门槛（带滞后，别在交界处来回抖）
    // 他们对齐（Touch.cs:311）：越过 .65 才算在侧面，回到 .5 以内算回中间。
    // 我们之前 .35/.22 太敏感 —— 摸脸中间也判成侧面，rua.face 永远是 false（用户：摸不到脸）。
    // 他们的阈值 .65/.5 是相对**他们的头半宽**。我们的头盒子按包围盒算是 236px 半宽，
    // 等比例换算 .65 = 离头心 153px —— 摸脸颊（100~150px）永远够不到，所以一次都没闭过。
    // 这里按手感换算成 .35/.25（≈83px / 59px）：手明显偏向一边就闭那只眼，回中间就松开。
    // （滞后区间保留，避免在交界处抖。）
    if (rua.side === 0) rua.side = uxRaw > .35 ? 1 : uxRaw < -.35 ? -1 : 0;
    else if (rua.side > 0 && uxRaw < .25) rua.side = 0;
    else if (rua.side < 0 && uxRaw > -.25) rua.side = 0;
    rua.ux = ux; rua.uy = uy; rua.on = engaged && onHead;   // 后端弹簧的开关（他们 amp 同口径）
    // 2026-11-22：不再只认 zone id。touchZones 的 face 椭圆是按 256 逻辑坐标手写的，
    // 和视觉上的脸对不上（用户：摸脸颊双眼闭不上）。按他们的语义来：
    // face = 头的**下半部分**且手在中间（他们 SmallZone 里 face 就是 y .125~.245 的中间段）。
    // 他们的 SmallZone：y 在 .125~.245 之间且 x 在 .3~.7（中间 40%）才算 face。
    // 换成头盒子坐标就是：头心以下（uyRaw > 0）+ 中间 70% 宽（|uxRaw| < .7）。
    rua.face = onHead && rua.side === 0 && uy > 0 && Math.abs(uxRaw) < .7;
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
      // 起摸时把还没 flush 的零散 touch 丢掉，免得摸头正起劲时补一条「戳了你一下」
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
    desc: 'rua 的白手：照他们 HandWindow.cs 的顶点 + 逐顶点透视 + 两遍绘制 + 投影；归一化用真实头半宽',
    detect: (s) => /HAND_FINGER_X/.test(s),
    apply: (s) => {
      let out = s.replace('/* ---------- body events → World ---------- */', "/* ---------- rua 的白手（照他们 HandWindow.cs：顶点 + 逐顶点透视，不是一张平贴图）---------- */\nconst ruaHand = document.createElement('div');\nruaHand.className = 'rua-hand';\nruaHand.hidden = true;\nruaHand.style.cssText = 'position:fixed;left:0;top:0;width:160px;height:160px;pointer-events:none;z-index:2;opacity:0;transition:opacity .1s ease;will-change:transform;filter:drop-shadow(1px 2px 3px rgba(0,0,0,.28))';\nruaHand.innerHTML = '<svg viewBox=\"0 0 160 160\" width=\"160\" height=\"160\" aria-hidden=\"true\">'\n  + '<path class=\"h-edge\" fill=\"#ffffff\" stroke=\"#b9bdc9\" stroke-width=\"2.2\" stroke-linejoin=\"round\"/>'\n  + '<path class=\"h-fill\" fill=\"#ffffff\" stroke=\"none\"/>'\n  + '</svg>';\nstage.append(ruaHand);\nconst ruaHandPath = ruaHand.querySelector('.h-edge');\nconst ruaHandFill = ruaHand.querySelector('.h-fill');\n\n/* 他们的几何（HandWindow.cs:78-95）。局部坐标：x 向右、y 向指尖，原点在手掌中心。\n   手掌 = 切角矩形；四根手指 = **并排**的直边方块（FingerX 间距 11.5、宽 9 → 缝只有 2.5，\n   所以看起来是并拢的四指，不是张开的）；拇指从左下斜出去。 */\nconst HAND_PALM = [[-22, 17], [22, 17], [22, -6], [11, -17], [-11, -17], [-22, -6]];\nconst HAND_FINGER_X = [-17.25, -5.75, 5.75, 17.25];\nconst HAND_FINGER_LEN = [36, 41, 37, 29];\n\n/** 一根手指：宽 w、长 len，指尖两角切 cut；从 (bx,by) 往上，绕根部转 angle。 */\nfunction handBlock(bx, by, len, w, cut, angle) {\n  const h = w / 2;\n  const pts = [[bx - h, by], [bx - h, by + len - cut], [bx - h + cut, by + len],\n    [bx + h - cut, by + len], [bx + h, by + len - cut], [bx + h, by]];\n  if (!angle) return pts;\n  const c = Math.cos(angle), s = Math.sin(angle);\n  return pts.map(([x, y]) => {\n    const dx = x - bx, dy = y - by;\n    return [bx + dx * c - dy * s, by + dx * s + dy * c];\n  });\n}\nconst HAND_SHAPES = [\n  HAND_PALM,\n  handBlock(HAND_FINGER_X[0], 15, HAND_FINGER_LEN[0], 9, 2.8, 0),\n  handBlock(HAND_FINGER_X[1], 15, HAND_FINGER_LEN[1], 9, 2.8, 0),\n  handBlock(HAND_FINGER_X[2], 15, HAND_FINGER_LEN[2], 9, 2.8, 0),\n  handBlock(HAND_FINGER_X[3], 15, HAND_FINGER_LEN[3], 9, 2.8, 0),\n  handBlock(-12, -9, 36, 10.5, 3, 1.0),   // 拇指：从左下往左上斜出去\n];\n/* 他们 HandVisual.Persp：沿「头心→手」方向的距离越小，远端越扁、越缩。 */\nconst HAND_PERSP = .0065;\n\n/** 每个顶点单独做透视（他们 Project()：先按手朝向转+缩放，再沿方向压扁、远的变小）。 */\nfunction handProject([px, py], pose, cx, cy) {\n  const sx = px, sy = -py;                     // 局部 y 向指尖 → 屏幕 y 向下，取负\n  const c = Math.cos(pose.rot), s = Math.sin(pose.rot);\n  let vx = (sx * c - sy * s) * pose.k, vy = (sx * s + sy * c) * pose.k;\n  if (pose.sin > 0) {\n    const along = vx * pose.ux + vy * pose.uy;\n    const qx = vx - along * pose.ux, qy = vy - along * pose.uy;\n    const f = 1 / (1 + (along / Math.max(.15, pose.k)) * pose.sin * HAND_PERSP);   // 除以 k：纵深跟手的局部尺寸走，不跟屏幕像素走\n    const a2 = along * pose.cos * f;\n    vx = qx * f + a2 * pose.ux; vy = qy * f + a2 * pose.uy;\n  }\n  return [cx + vx, cy + vy];\n}\n\n/* 头盒（屏幕上）：rua-start 时由 kit 带上来（他们 Behavior.HeadBox）。 */\nlet ruaHandHead = null;\n/* 他们的姿态（HandPoseFor）：按光标相对头心的位置倾斜，掌心朝头心，指尖朝左上约 40°。 */\nfunction ruaHandPose(cur) {\n  const hb = ruaHandHead;\n  if (!hb) return { rot: -40 * Math.PI / 180, k: .3, cos: 1, sin: 0, ux: 0, uy: 0 };\n  /* 归一化用「视觉上的头半径」而不是 touchZones.rx —— 实测 rx=205.8（虚高约 1.6 倍），\n     用它算出来的 r 永远很小 → nz≈1 → sin≈0 → 透视压扁几乎为零（用户：只有上下、没有左右纵深）。\n     0.62 倍后约 127px，和实际头半宽一致，手一到侧面就被明显压扁。 */\n  // 2026-11-23：0.62 是当年 rx 虚高（205 vs 真实 122）时的补偿系数。\n  // 现在头盒子按包围盒算准了（日志 rx=122），再乘 0.62 等于把分母砍到 76 ——\n  // 手在脸颊中间 r 就 0.4，透视直接压扁（用户：脸颊中间就已经是纵深形态）。\n  // 用真实头半宽归一化：中间 ≈ 平，到边缘才压。\n  const ux0 = (cur.x - hb.x) / hb.rx, uy0 = (cur.y - hb.y) / hb.ry;\n  const r = Math.min(Math.hypot(ux0, uy0), 1.05);\n  const nz = Math.max(.52, Math.sqrt(Math.max(0, 1 - r * r * .7)));\n  const rest = -Math.PI / 2 - 40 * Math.PI / 180;\n  const angle = rest + clamp(ux0, -1, 1) * .22;\n  /* 手的大小按**头的半宽**算（hb.rx 已含当前缩放，窗口放大缩小都跟着变）。\n     不用 innerHeight：不同窗口高度下不可控（实测三次都偏大）。\n     也不直接用他们的 rx/78*.4：我们 touchZones.rx 比实际头宽偏大，套进去手会大一倍。\n     系数 0.0021：rx≈160 时 k≈0.34，手高 73×0.34 ≈ 25px（她眼睛直径约 25px）。 */\n  // 2026-11-23：头盒子改成按包围盒比例后 rx 从 205 变 236，同一个系数让手大了 16%\n  // （用户：「在脸上的时候更糟糕」）。系数按新 rx 折算，回到之前认可的大小（≈0.43）。\n  // rx 现在 ≈122（真实头半宽）。0.0028 → k≈0.34，手高 73k≈25px（和她眼睛直径相当）。\n  const k = hb.rx * 0.0028 * (1.15 + .1 * (1 - r));\n  const len = Math.hypot(cur.x - hb.x, cur.y - hb.y);\n  const dx = len < 1 ? 0 : (cur.x - hb.x) / len, dy = len < 1 ? 0 : (cur.y - hb.y) / len;\n\n  // 近头心也保留倾斜：他们原曲线 r=0 时 sin≈0，手贴着头就是平的；给下限 .55，远处不变\n  const sin = Math.max(.55, Math.sqrt(1 - nz * nz));\n  const cos = Math.sqrt(Math.max(0, 1 - sin * sin));\n  return { rot: angle + Math.PI / 2, k, cos, sin, ux: dx, uy: dy };\n}\n/** 重算 path：每帧 6 组多边形逐顶点投影（和他们的 OnRender 一样）。 */\nfunction ruaHandDraw() {\n  if (ruaHand.hidden) return;\n  const p0 = cursor.at;\n  if (!p0) return;\n  const pose = ruaHandPose(p0);\n  const cx = 80, cy = 80;                       // 窗口 160 的中心 = 手掌中心\n  let d = '';\n  for (const shape of HAND_SHAPES) {\n    const xy0 = handProject(shape[0], pose, cx, cy);\n    d += 'M' + xy0[0].toFixed(2) + ' ' + xy0[1].toFixed(2);\n    for (let i = 1; i < shape.length; i++) {\n      const xy = handProject(shape[i], pose, cx, cy);\n      d += 'L' + xy[0].toFixed(2) + ' ' + xy[1].toFixed(2);\n    }\n    d += 'Z';\n  }\n  ruaHandPath.setAttribute('d', d);\n  ruaHandFill.setAttribute('d', d);   // 第二遍：纯白无描边盖住内侧，只留外轮廓一圈灰边\n  ruaHand.style.transform = 'translate(' + (p0.x - 80) + 'px,' + (p0.y - 80) + 'px)';\n}\nlet ruaCursorCss = null;\nfunction showRuaHand(d) {\n  if (d && typeof d.hx === 'number') ruaHandHead = { x: d.hx, y: d.hy, rx: d.rx, ry: d.ry };\n  if (!ruaHand.hidden) return;\n  ruaHand.hidden = false;\n  ruaCursorCss = document.createElement('style');\n  ruaCursorCss.textContent = 'html, body, body * { cursor: none !important; }';\n  document.head.append(ruaCursorCss);\n  ruaHandDraw();\n  requestAnimationFrame(() => { ruaHand.style.opacity = '1'; });\n}\nfunction hideRuaHand() {\n  if (ruaHand.hidden) return;\n  ruaHand.style.opacity = '0';\n  if (ruaCursorCss) { ruaCursorCss.remove(); ruaCursorCss = null; }\n  setTimeout(() => { ruaHand.hidden = true; }, 110);\n}\ndocument.addEventListener('pointermove', ruaHandDraw, { passive: true });\n" + '\n/* ---------- body events → World ---------- */');
      if (!out.includes('function showRuaHand')) throw new Error('ruaHand：插入锚点未命中');
      out = out.replace(
        "    if (d.kind === 'grab') closeMenu();",
        "    if (d.kind === 'grab') closeMenu();\n    if (d.kind === 'rua-start') showRuaHand(d);\n    else if (d.kind === 'rua-end') hideRuaHand();",
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
    // squashDirect 之后这行会变成 `(1 - sqAll)`，检测要同时认这两种形态，否则 --check 会误报失败
    detect: (s) => /const sy = \(1 - (pet\.sq|sqAll)\)/.test(s) && !/1 \+ \.016 \* br/.test(s),
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
      out = out.replace(a2, "      onEvent('touch', { kind: 'rua-still', tier: ruaTier, seconds: Math.max(rua.seconds, ruaMax) });   // 峰值，防倒退\n    }\n    lastRuaAt = T;   // 秒（T 是同单位）；别写 now(p)，那是毫秒\n    // 2026-11-22 用户：1.5 秒宽限不要了 —— 手离开头区就算了，只在松手时结算。\n  }");
      // 4)（已删）原来这里把落地 crash 事件整个掐掉，理由是「rua 后 3 秒不算摔晕」。
      // 2026-11-23 查明刷屏真因是控制台 touch 渲染器的 default 分支（见 chat 的 ruaChat 补丁），
      // 跟 crash 事件无关；这条抑制只会让「真被甩出去」也不再告诉她。恢复上游原样，不再改。
      // 5) 松手后按档位压住闲时动作：摸后 mood 最长 6 秒（融化）+ 0.8 秒空档。
      //    之前固定 +6 秒，融化档最后那一秒会被闲时动作插进来抢表情（用户实测「一松手就做别的」）。
      const a5 = "    ruaDown = false;\n    const held = Math.round(ruaMax * 10) / 10;";
      if (!out.includes(a5)) throw new Error('ruaTune：endRua 锚点未命中');
      out = out.replace(a5, "    ruaDown = false;\n    const held = Math.round(ruaMax * 10) / 10;\n    // 摸后 mood 还在演：按档位压住闲时动作（融化 6s+0.8s 空档，留一点余量）\n    pet.idleHoldUntil = T + (ruaMelted ? 25 : held >= 8 ? 20 : held >= 3 ? 15 : 10);");
      return out;
    },
  },
  {
    file: 'body', id: 'pokeZone',
    desc: '左键戳：带上分区和左右侧，交给形象演（他们 ClickMood 的六条）；去掉 kit 自己的随机表情',
    detect: (s) => s.includes("kind: 'poke', zone: _pz"),
    apply: (s) => {
      const a = "    } else if (now(p) - press.t < 400) {";
      if (!s.includes(a)) throw new Error('pokeZone：锚点未命中');
      s = s.replace(a, a + "\n      // 戳哪儿、戳在左边还是右边：形象按 Behavior.ClickMood 演对应的那一条\n      const _pz = zoneAt(p) ?? 'body';\n      // 标定：把屏幕点反解回 logo 坐标，和 touchZones 的数值对照（用户 17:50 要求「在已知高度打日志」）\n      try { const _xf = pet.xf || {}; const _lx = (p.x - (_xf.AX ?? 0)) / (_xf.kx || 1) + (_xf.ax ?? 128); const _ly = (p.y - (_xf.AY ?? 0)) / (_xf.ky || 1) + (_xf.ay ?? 256); new Image().src = '/api/figure-log?m=' + encodeURIComponent('zone p=' + Math.round(p.x) + ',' + Math.round(p.y) + ' logo=' + _lx.toFixed(0) + ',' + _ly.toFixed(0) + ' pz=' + _pz + ' ay=' + (_xf.ay ?? 256) + ' ky=' + (_xf.ky || 1).toFixed(2)); } catch {}\n      // 侧别用他们 Behavior.Click 的约定：**左 = +1，右 = -1**（PetWindow.cs:1133 `at.X / Width < .5 ? 1 : -1`）。\n      // 形象侧 `Pushed && side < 0` 才对镜像——之前这里传反了，于是戳左边往左躲（同向）。\n      const _ps = p.x < toStage(128, 0).x ? 1 : -1;");
      const b = "        onEvent('touch', { kind: 'poke', woke: wasAsleep });";
      if (!s.includes(b)) throw new Error('pokeZone：woke 锚点未命中');
      s = s.replace(b, "        onEvent('touch', { kind: 'poke', woke: wasAsleep, zone: _pz, side: _ps });\n        custom?.poke?.(_pz, _ps);");
      const c = "        play('poke', 'touch');\n        const r = ['happy', 'wink', 'surprised', 'love', 'angry'][Math.floor(Math.random() * 5)];\n        setExpr(r);\n        if (Math.random() < .5 && pet.mode === 'idle') setMode('crouch', { jumpV: 480, jumpVx: 0 });\n        onEvent('touch', { kind: 'poke' });";
      if (!s.includes(c)) throw new Error('pokeZone：随机表情锚点未命中');
      return s.replace(c, "        play('poke', 'touch');\n        // 2026-11-23：随机表情和随机蹦一下都删掉——它们会和形象按分区演的那条抢脸/抢动作\n        // （用户：戳完先歪一下头，然后就没了）。改成把分区和侧别交给形象。\n        custom?.poke?.(_pz, _ps);\n        onEvent('touch', { kind: 'poke', zone: _pz, side: _ps });");
    },
  },
  {
    file: 'body', id: 'squashDirect',
    desc: '形象给的 ViewSquash 直通（他们的 renderer 直接乘矩阵）；以前并进 kit 的弹簧（k280/c14，ζ≈0.42）会过冲抖动，看着像「啪一下压扁又弹回来」',
    detect: (s) => s.includes('const figSq = custom?.squash?.() ?? 0;'),
    apply: (s) => {
      const a = "    pet.sqv += (((sqT + (custom?.squash?.() ?? 0)) - pet.sq) * 280 - pet.sqv * 14) * dt;   // 2.7 整图压扁：figure 虚拟参数 ViewSquash 叠加进弹簧目标";
      if (!s.includes(a)) throw new Error('squashDirect：弹簧锚点未命中');
      s = s.replace(a, "    pet.sqv += ((sqT - pet.sq) * 280 - pet.sqv * 14) * dt;   // 弹簧只跟 kit 自己的 sqT（落地/跳舞）");
      const b = "    const sx = (1 + pet.sq * .7) * (1 - .05 * pet.stretch);\n    const sy = (1 - pet.sq) * (1 + .09 * pet.stretch);";
      if (!s.includes(b)) throw new Error('squashDirect：缩放锚点未命中');
      return s.replace(b, "    // 形象给的压扁（ViewSquash）直通：他们的 renderer 是 bodySquash 直接乘进矩阵，不过弹簧\n    const figSq = custom?.squash?.() ?? 0;\n    const sqAll = pet.sq + figSq;\n    const sx = (1 + sqAll * .7) * (1 - .05 * pet.stretch);\n    const sy = (1 - sqAll) * (1 + .09 * pet.stretch);");
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
      return s.replace(a, "onEvent('touch', { kind: 'rua-start', hx: c.x, hy: c.y, rx: headRx, ry: headRy });");
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
  {
    file: 'world', id: 'touchLog',
    desc: '诊断：把页面发来的每个 touch 事件追加到 D:/AI/rua-debug.log（查「重重摔晕」到底谁发的）。调完把这条删掉即可',
    detect: (s) => /rua-debug\.log/.test(s),
    apply: (s) => {
      let out = s;
      // world.ts 本来就有 import { existsSync } from 'node:fs'，直接合并
      if (out.includes("import { existsSync } from 'node:fs';")) {
        out = out.replace("import { existsSync } from 'node:fs';", "import { existsSync, appendFileSync } from 'node:fs';");
      } else if (!out.includes('appendFileSync')) {
        const _m = out.match(/^import [^\n]*\n/m);
        if (!_m) throw new Error('touchLog：找不到 import 行');
        out = out.slice(0, _m.index) + "import { appendFileSync } from 'node:fs';\n" + out.slice(_m.index);
      }
      const a = "    const kind = String(msg.kind);";
      if (!out.includes(a)) throw new Error('touchLog：onTouch 锚点未命中');
      out = out.replace(a, a + "\n    try { appendFileSync('D:/AI/rua-debug.log', new Date().toISOString() + ' ' + kind + ' ' + JSON.stringify(msg).slice(0, 240) + '\\n'); } catch { /* 日志失败不影响功能 */ }");
      return out;
    },
  },
  {
    file: 'body', id: 'noGrabAfterRua',
    desc: 'rua 前后禁止拖拽：点在窗口内但没打中她时清掉残留 press；rua 后 3 秒内不 grab —— 这是「摸头 0 秒 + 立刻重重摔晕」的源头（残留 press 被当成拖拽，松手就甩出去）',
    detect: (s) => /T - lastRuaAt > 3/.test(s),
    apply: (s) => {
      let out = s;
      const a1 = "    if (!hitPet(p)) return false;";
      if (!out.includes(a1)) throw new Error('noGrabAfterRua：hitPet 锚点未命中');
      out = out.replace(a1, "    // 2026-11-22：点在窗口里但没打中她 —— 也要清掉残留 press，否则下一次移动会被当成拖拽\n    if (!hitPet(p)) { press = null; return false; }");
      const a2 = "    if (press && pet.mode !== 'drag' && Math.hypot(p.x - press.x, p.y - press.y) > 6) grab();";
      if (!out.includes(a2)) throw new Error('noGrabAfterRua：grab 锚点未命中');
      out = out.replace(a2, "    // rua 刚结束的 3 秒内绝不 grab：残留 press + 鼠标一动就会被当成拖拽，松手甩出去就是\n    // 「摸头 0 秒 + 你重重落地，摔晕了一会儿」（用户 2026-11-22 实测）。\n    if (press && pet.mode !== 'drag' && T - lastRuaAt > 3 && Math.hypot(p.x - press.x, p.y - press.y) > 6) grab();");
      return out;
    },
  },
  {
    file: 'body', id: 'grabUnitFix',
    desc: '修 lastRuaAt 的单位：它存的是 now(p)（毫秒），而 noGrabAfterRua 拿它和 T（秒）比 —— 差值恒为负数，于是「摸过一次头之后左键永远拖不动」（用户 2026-11-24 报「触发不了长按拖拽」）',
    detect: (s) => /lastRuaAt = T;/.test(s),
    apply: (s) => {
      const a = "    lastRuaAt = t;";
      if (!s.includes(a)) return null;   // 已经是 T，或者 ruaTune 没打上
      return s.replace(a, "    lastRuaAt = T;   // 秒：和 T 同单位（原来写 now(p) 的毫秒，则 T - lastRuaAt 恒为负 → 摸过一次就再也拖不动）");
    },
  },
  {
    file: 'body', id: 'dragStretch',
    desc: '拖拽形变改成跟垂直速度：原来一进 drag 就把 stretch 拉到 1（横向 −5%、纵向 +9% 恒定），用户「一拉起来她就拉伸一样」；改成快速甩才变形、停下归零',
    detect: (s) => /pointer\.vy/.test(s),
    apply: (s) => {
      let out = s;
      const p1 = "  const pointer = { x: -1e4, y: -1e4, inside: false, vx: 0, samples: [] };";
      if (!out.includes(p1)) throw new Error('dragStretch：pointer 定义未命中');
      out = out.replace(p1, "  const pointer = { x: -1e4, y: -1e4, inside: false, vx: 0, vy: 0, samples: [] };");
      const p2 = "    pointer.vx = lerp(pointer.vx, velocity().x, .35);";
      if (!out.includes(p2)) throw new Error('dragStretch：pointer.vx 未命中');
      out = out.replace(p2, p2 + "\n    pointer.vy = lerp(pointer.vy, velocity().y, .35);");
      const p3 = "    pet.stretch = lerp(pet.stretch, m === 'drag' ? 1 : 0, ease(8, dt));";
      if (!out.includes(p3)) throw new Error('dragStretch：stretch 未命中');
      out = out.replace(p3,
        "    // 2026-11-24 用户：「一拉起来她就拉伸一样」。原版一进 drag 就恒定拉满（sx −5% / sy +9%），\n"
        + "    // 看着像橡皮。他们的 ViewSquash 是跟手相对头的位置（±8%，手不动就不变），\n"
        + "    // 我们的抓取点可以是身上任意高度，没有「后颈」这个基准 —— 改成跟**垂直速度**：\n"
        + "    // 快速甩才变形，停下就归零（-1 压扁 / +1 拉长，1200 px/s 打满）。\n"
        + "    const stT = m === 'drag' ? clamp(-pointer.vy / 1200, -.8, 1) : 0;\n"
        + "    pet.stretch = lerp(pet.stretch, stT, ease(8, dt));");
      return out;
    },
  },
  {
    file: 'body', id: 'dragTiltPivot',
    desc: '拖拽倾斜的支点与幅度：原版支点是脖子（ay=36）→ 绕脖子转，头定、脚在 220 单位外被甩飞（用户「头跟着鼠标、脚反方向飘」）；改成接近脚（220）。幅度也从 ±40 收到 ±12（他们 body 4° + ViewRoll 4°），弹簧换他们的 70/7',
    detect: (s) => /ay = drag \? 220 : 256/.test(s),
    apply: (s) => {
      let out = s;
      const p1 = "    const ax = 128, ay = drag ? 36 : 256;";
      if (!out.includes(p1)) throw new Error('dragTiltPivot：支点未命中');
      out = out.replace(p1,
        "    // 2026-11-24 用户：「往左拖，头跟着鼠标，但身体到脚那部分往反方向飘」。\n"
        + "    // 原因是拖拽把旋转支点从脚（256）改到了脖子（36）—— 绕脖子转，头在支点附近几乎不动，\n"
        + "    // 脚离支点 220 单位，被甩到相反方向。支点下移到接近脚，就变成「站姿整体倾倒」。\n"
        + "    const ax = 128, ay = drag ? 220 : 256;");
      const p2 = "        tiltT = clamp(pointer.vx * .035, -40, 40); tk = 90; tc = 5;";
      if (!out.includes(p2)) throw new Error('dragTiltPivot：drag tilt 未命中');
      out = out.replace(p2,
        "        // 幅度照他们（body 4° + ViewRoll 4°）：原来 ±40 是他们的 10 倍，甩起来像被风吹。\n"
        + "        // 弹簧用他们的 body 70/7（原来是 90/5，更软更荡）。\n"
        + "        tiltT = clamp(pointer.vx * .012, -12, 12); tk = 70; tc = 7;");
      return out;
    },
  },
  {
    file: 'body', id: 'landKind',
    desc: '落地判据按真实松手速度：原作者把 pet.airKind 无条件写成 throw，事件却按速度分 throw/drop —— 轻轻放下落地也会按「抛出去」判 crash（用户 22:32 的「重重摔晕」就是这么来的）',
    detect: (s) => /airKind = speed > 700/.test(s),
    apply: (s) => {
      const a = "      pet.airKind = 'throw';";
      if (!s.includes(a)) throw new Error('landKind：锚点未命中');
      return s.replace(a, "      // 2026-11-22：原来无条件写 'throw'，但事件按速度分 throw/drop ——\n      // 轻轻放下落地也会走「抛出去」的判据（impact>1000 就 crash）。按速度对齐。\n      pet.airKind = speed > 700 ? 'throw' : 'drop';");
    },
  },
  // ===== chat.ts：rua 事件不进对话页 =====
  {
    file: 'chat', id: 'ruaChat',
    desc: "rua-start/tier/still/end 不给对话页条目：控制台前端 touch 渲染器只认 poke/pet/throw/drop，其余全落 default，被渲染成「雅汐 重重落地，摔晕了一会儿」（摸头每 2.5 秒一条，满屏）。事件照常投递给模型，只是不生成页面条目",
    detect: (s) => s.includes("t.kind.startsWith('rua-')"),
    apply: (s) => {
      const a = "      if (t && typeof t.kind === 'string') {";
      if (!s.includes(a)) throw new Error('ruaChat：锚点未命中');
      return s.replace(a, a + "\n        // 2026-11-23（真因）：控制台 build/console/index.js 里 touch 渲染器的 default 分支是\n        //   default: return `${t} 重重落地，摔晕了一会儿`\n        // 只要 kind 不是 poke/pet/throw/drop 就全落进去。rua-* 正好都不认识 → 摸头每 2.5 秒一条。\n        // 事件照常给模型（她该知道的秒数一个字不少），只是不给对话页生成条目。\n        if (t.kind.startsWith('rua-')) return null;");
    },
  },
  // ===== model-text.ts / world.ts：戳一戳按分区说话（2026-11-23）=====
  {
    file: 'mtext', id: 'pokeZoneText',
    desc: '戳一戳的文本带上分区（之前是死的「戳了你一下」，她不知道被戳的是哪儿）',
    detect: (s) => s.includes('戳了戳你的${z}'),
    apply: (s) => {
      const a = "  poked: (user: string, n: number) => (n > 1 ? `${user}戳了你 ${n} 下` : `${user}戳了你一下`),";
      if (!s.includes(a)) throw new Error('pokeZoneText：中文锚点未命中');
      s = s.replace(a, "  poked: (user: string, n: number, zone?: string) => {\n"
        + "    const z = ({ head: '头', face: '脸', hand: '手', chest: '胸口', belly: '肚子', skirt: '裙摆', legs: '腿', tail: '尾巴', body: '身上' } as Record<string, string>)[zone ?? ''];\n"
        + "    if (n > 1) return z ? `${user}连着戳了你的${z} ${n} 下` : `${user}戳了你 ${n} 下`;\n"
        + "    return z ? `${user}戳了戳你的${z}` : `${user}戳了你一下`;\n"
        + "  },");
      const b = "  poked: (user, n) => (n > 1 ? `${user} poked you ${n} times` : `${user} poked you`),";
      if (!s.includes(b)) throw new Error('pokeZoneText：英文锚点未命中');
      return s.replace(b, "  poked: (user, n, zone?: string) => {\n"
        + "    const z = ({ head: 'head', face: 'cheek', hand: 'hand', chest: 'chest', belly: 'belly', skirt: 'skirt', legs: 'leg', tail: 'tail', body: 'body' } as Record<string, string>)[zone ?? ''];\n"
        + "    if (n > 1) return z ? `${user} poked your ${z} ${n} times` : `${user} poked you ${n} times`;\n"
        + "    return z ? `${user} poked your ${z}` : `${user} poked you`;\n"
        + "  },");
    },
  },
  {
    file: 'world', id: 'pokeZonePass',
    desc: '把戳的分区传给文本',
    detect: (s) => s.includes('m.poked(u, t.count, t.zone)'),
    apply: (s) => {
      const a = "case 'poke': text = t.woke ? m.pokedAwake(u) : m.poked(u, t.count); break;";
      if (!s.includes(a)) throw new Error('pokeZonePass：锚点未命中');
      return s.replace(a, "case 'poke': text = t.woke ? m.pokedAwake(u) : m.poked(u, t.count, t.zone); break;");
    },
  },
  {
    file: 'body', id: 'hoverAct',
    desc: '鼠标停在某个部位上 10 秒（不点不拖）+ 30 秒冷却 → custom.hover(zone)，形象演他们那 6 条悬停反应',
    detect: (s) => s.includes('pet.hoverT >= 10'),
    apply: (s) => {
      const a = `    T += dt; pet.modeT += dt;
    A = anchors();`;
      if (!s.includes(a)) throw new Error('hoverAct：step 锚点未命中');
      // 幂等升级：先把旧的那段（0.45 秒版）整块删掉，再插新的，不然改了常量重跑无效
      s = s.replace(/\n {4}\/\/ 悬停：[\s\S]*?pet\.hoverFired = 0; \}\n {4}\}\n/, '\n');
      return s.replace(a, a + "\n    // 悬停：鼠标停在某个部位上、不按不拖，**10 秒**后演一条轻微反应（他们 Behavior.cs:70-75）。\n"
        + "    // 10 秒 / 30 秒冷却照 PetWindow.Touch.cs:478（HoverAfter=10s, HoverCooldown=30s）。\n"
        + "    // 2026-11-23 23:35 用户实测：原来写 0.45 秒太容易触发 —— 想戳一下，戳之前就先被 hover 演了一遍。\n"
        + "    // 只在没有按键、没在摸头时算；一按下就归零重计，所以「戳」永远不会先触发悬停。\n"
        + "    {\n"
        + "      const hz = pointer.inside && !press && !ruaDown ? (zoneAt(pointer) ?? null) : null;\n"
        + "      if (hz && hz === pet.hoverZone) {\n"
        + "        pet.hoverT = (pet.hoverT ?? 0) + dt;\n"
        + "        if (pet.hoverT >= 10 && !pet.hoverFired && T > (pet.hoverCool ?? 0)) {\n"
        + "          pet.hoverFired = 1; pet.hoverCool = T + 30; custom?.hover?.(hz);\n"
        + "        }\n"
        + "      } else { pet.hoverZone = hz; pet.hoverT = 0; pet.hoverFired = 0; }\n"
        + "    }");

      return s;
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
