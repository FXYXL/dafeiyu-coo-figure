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
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// 桌宠引擎位置。三种找法（按顺序）：
//   1. --dir="..."  显式指定。可以传 Coo 根目录，也可以直接传引擎目录，两种都认
//   2. 依次探测常见安装位置
//   3. 作者的机器（只有本机开发时才会命中）
//   node patch-pet-kit.mjs --dir="C:/Program Files/Coopanion"
const argDir = process.argv.find((a) => a.startsWith('--dir='));
const ENGINE_SUFFIX = '/resources/app/node_modules/cortico-world-desktop-pet';
const lookLikeEngine = (d) => !!d && fs.existsSync(path.join(d, 'web/kit/body.js'));
const CANDIDATES = [
  process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}/Programs/Coopanion${ENGINE_SUFFIX}`,
  `C:/Program Files/Coopanion${ENGINE_SUFFIX}`,
  `C:/Program Files (x86)/Coopanion${ENGINE_SUFFIX}`,
  `D:/Coopanion${ENGINE_SUFFIX}`,
  `E:/Coopanion${ENGINE_SUFFIX}`,
].filter(Boolean);
function resolveDir() {
  if (argDir) {
    const d = argDir.slice(6).replace(/["']/g, '').replace(/[\\/]+$/, '');
    if (lookLikeEngine(d)) return d;
    if (lookLikeEngine(d + ENGINE_SUFFIX)) return d + ENGINE_SUFFIX;   // 传的是 Coo 根目录
    console.error(`\n找不到桌宠引擎：${d}\n`
      + `  这个目录下没有 web/kit/body.js。--dir= 可以传两种路径：\n`
      + `    · Coo 根目录            C:/Program Files/Coopanion\n`
      + `    · 引擎目录（更精确）    C:/Program Files/Coopanion${ENGINE_SUFFIX}\n`
      + `  不知道装在哪：任务管理器 → 详细信息 → 右键 Coopanion.exe → 「打开文件位置」\n`);
    process.exit(2);
  }
  for (const c of CANDIDATES) if (lookLikeEngine(c)) return c;
  console.error(`\n没找到 Coo 的安装位置。自动探测过这些：\n${CANDIDATES.map((c) => '  ' + c).join('\n')}\n\n`
    + `  请显式指定：node patch-pet-kit.mjs --dir="C:/你的/Coo安装目录"\n`
    + `  不知道装在哪：任务管理器 → 详细信息 → 右键 Coopanion.exe → 「打开文件位置」\n`);
  process.exit(2);
}
const DIR = resolveDir();
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
  // ===== body.js：表演系统（1.12~1.13）=====
  // ===== body.js：3.9 统一闲时调度（2026-11-20）=====
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
  // ===== body.js：4.2 rua 摸头（2026-11-20，参考他们家 PetWindow.Touch.cs）=====
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
  // ===== 听歌的耳朵（2026-11-24）=====
  // ===== 听歌耳朵的传输层（2026-11-25 恢复）=====
  // 链路：server 起 MusicEar → 它拉起 probe.ps1 读系统声音 → 50ms 一行 JSON 广播到 /music
  //       → body-host 连 /music → post({t:'music', data}) 给形象 iframe
  //       → figure-frame 转给 body.music() → figure.music(data) 写入 musicRaw。
  // 形象侧只做判定和压随机，不含摆动（摆动在 live2d.js 的 stepMusicDance 里）。
  {
    file: 'server', id: 'musicEarImport',
    desc: 'server.ts 引入 MusicEar',
    detect: (s) => s.includes("from './music-ear.ts'"),
    apply: (s) => {
      const a = "import { WebSocketServer, type WebSocket } from 'ws';";
      if (!s.includes(a)) throw new Error('musicEarImport：锚点未命中');
      return s.replace(a, a + "\nimport { MusicEar } from './music-ear.ts';");
    },
  },
  {
    file: 'server', id: 'musicEarField',
    desc: 'PetServer 持有耳朵实例',
    detect: (s) => s.includes('private music: MusicEar'),
    apply: (s) => {
      const a = '  private wss: WebSocketServer | null = null;';
      if (!s.includes(a)) throw new Error('musicEarField：锚点未命中');
      return s.replace(a, a + '\n  /** 听歌的耳朵：Windows 下随服务启动，退出时收掉。 */\n  private music: MusicEar | null = null;');
    },
  },
  {
    file: 'server', id: 'musicEarStart',
    desc: '服务起来后拉起耳朵',
    detect: (s) => s.includes('new MusicEar(this.opts.webDir)'),
    apply: (s) => {
      const a = '      this.wss = new WebSocketServer({ noServer: true });';
      if (!s.includes(a)) throw new Error('musicEarStart：锚点未命中');
      return s.replace(a, a + '\n      this.music = new MusicEar(this.opts.webDir);\n      this.music.start();');
    },
  },
  {
    file: 'server', id: 'musicEarUpgrade',
    desc: '/music 走独立 WebSocket，交给耳朵（必须排在 /socket 判断之前）',
    detect: (s) => s.includes("url.pathname === '/music'"),
    apply: (s) => {
      const a = "        const url = new URL(req.url ?? '/', this.origin);\n        if (url.pathname !== '/socket') { socket.destroy(); return; }";
      if (!s.includes(a)) throw new Error('musicEarUpgrade：锚点未命中');
      return s.replace(a,
        "        const url = new URL(req.url ?? '/', this.origin);\n"
        + "        if (url.pathname === '/music') {\n"
        + "          this.wss!.handleUpgrade(req, socket, head, (ws) => this.music?.attach(ws));\n"
        + "          return;\n"
        + "        }\n"
        + "        if (url.pathname !== '/socket') { socket.destroy(); return; }");
    },
  },
  {
    file: 'server', id: 'musicEarStop',
    desc: 'stop() 里收掉耳朵（否则 PowerShell 采集进程会留在后台）',
    detect: (s) => s.includes('this.music?.stop()'),
    apply: (s) => {
      const a = '    this.wss?.close();';
      if (!s.includes(a)) throw new Error('musicEarStop：锚点未命中');
      return s.replace(a, '    this.music?.stop();\n    this.music = null;\n' + a);
    },
  },
  {
    file: 'host', id: 'musicBridge',
    desc: '/pet 页连 /music，把快照转发给形象 iframe',
    detect: (s) => s.includes('connectMusic'),
    apply: (s) => {
      const a = "    const timer = setTimeout(() => fail(new Error(t('figure.notReady', { seconds: READY_MS / 1000 }))), READY_MS);";
      if (!s.includes(a)) throw new Error('musicBridge：锚点未命中');
      const add = [
        '    // 听歌的耳朵：引擎把 50ms 音频快照从 /music 推过来，转发给形象 iframe。',
        '    // 形象 iframe 的 CSP 只能连自己的包目录，不能自己连；这里是普通页面，连本机 WS 没问题。',
        '    let musicWs = null, musicRetry = 0;',
        '    const connectMusic = () => {',
        '      if (gone) return;',
        "      try { musicWs = new WebSocket('ws://' + location.host + '/music'); } catch { return; }",
        '      musicWs.onopen = () => { musicRetry = 0; };',
        "      musicWs.onmessage = (e) => { try { post({ t: 'music', data: JSON.parse(e.data) }); } catch { /* 半行 */ } };",
        '      musicWs.onclose = () => { musicWs = null; if (!gone) setTimeout(connectMusic, Math.min(10000, 1000 * (++musicRetry))); };',
        '    };',
        "    if (location.pathname === '/pet') connectMusic();",
        '',
      ].join('\n');
      return s.replace(a, add + a);
    },
  },
  {
    file: 'host', id: 'musicClose',
    desc: '关闭时断开 /music',
    detect: (s) => s.includes('musicWs?.close()'),
    apply: (s) => {
      const a = '      gone = true;';
      if (!s.includes(a)) throw new Error('musicClose：锚点未命中');
      return s.replace(a, a + "\n      try { musicWs?.close(); } catch { /* 已经关了 */ }");
    },
  },
  {
    file: 'frame', id: 'musicMessage',
    desc: 'figure-frame 把 music 消息转给 body',
    detect: (s) => s.includes("m.t === 'music'"),
    apply: (s) => {
      const a = "    else if (m.t === 'cue') body.cue?.(m.kind);";
      if (!s.includes(a)) throw new Error('musicMessage：锚点未命中');
      return s.replace(a, "    else if (m.t === 'music') body.music?.(m.data);\n" + a);
    },
  },
  {
    file: 'petapp', id: 'musicRefreshSample',
    desc: '测屏幕刷新率：用 rAF 间隔的中位数，给 musicFrame 挑一个能整除的帧率',
    detect: (s) => s.includes('__refreshHz'),
    apply: (s) => {
      const a = '    globalThis.__lastRF = now;\n    if (windowShown) lastFrameAt = performance.now();';
      if (!s.includes(a)) throw new Error('musicRefreshSample：锚点未命中');
      const add = [
        '    // 2026-11-25：测屏幕刷新率。听歌摆动要平滑，fps 必须是刷新率的整数分之一',
        '    // （165Hz 上 60fps = 2.75 个周期，只能落 12/18ms 交替，看起来一抖一抖）。',
        '    // DeepFish 不受这个影响，因为它用 timeBeginPeriod(1) + 固定 Sleep，和刷新率无关。',
        '    {',
        '      const g = now - (globalThis.__lastRF2 ?? now);',
        '      if (g > 1 && g < 100) {',
        '        const arr = (globalThis.__rfSamples ??= []);',
        '        arr.push(g);',
        '        if (arr.length > 31) {',
        '          arr.shift();',
        '          const sorted = arr.slice().sort((x, y) => x - y);',
        '          globalThis.__refreshHz = 1000 / sorted[sorted.length >> 1];',
        '        }',
        '      }',
        '      globalThis.__lastRF2 = now;',
        '    }',
      ].join('\n');
      return s.replace(a, a + '\n' + add);
    },
  },
  {
    file: 'petapp', id: 'musicFrame',
    desc: '听歌时提帧，并按屏幕刷新率取整数分之一（165Hz → 82.5，144 → 72，120 → 60）',
    detect: (s) => s.includes('const musicOn = !!body?.musicActive?.()'),
    apply: (s) => {
      const a = '  const full = drawn && (prefs.lockFrameRate || !!at()?.moving || (!!host && drawnScale.moving) || performance.now() < smoothUntil);';
      if (!s.includes(a)) throw new Error('musicFrame：锚点未命中');
      const repl = [
        '  const full = drawn && (prefs.lockFrameRate || !!at()?.moving || (!!host && drawnScale.moving) || performance.now() < smoothUntil);',
        '  // 听歌摆动：① 待机 30fps 太稀，慢摆看着一卡一卡 → 提帧；',
        '  // ② 帧率要能整除屏幕刷新率，否则 2.75 个周期只能 12/18ms 交替（一抖一抖）。',
        '  // 165Hz → 82.5、144 → 72、120 → 60、60 → 60（60 屏直接满帧）。',
        '  const musicOn = !!body?.musicActive?.();',
        '  if (musicOn) {',
        '    const hz = globalThis.__refreshHz || 0;',
        '    const paced = hz > 90 ? hz / 2 : (hz > 55 ? hz : prefs.frameRate);',
        '    // 165 → 82.5（每 2 个刷新一帧）、144 → 72、120 → 60。别 round：',
        '    // 取整会差零点几 fps，累积几十帧后 dueAt 漂出四分之一 gap，还是会偶尔跳一下。',
        '    return { fps: drawn ? paced : HIDDEN_FPS, refresh: true };',
        '  }',
      ].join('\n');
      return s.replace(a, repl);
    },
  },
  {
    file: 'petapp', id: 'musicCadenceNearest60',
    desc: '听歌选接近60的整数分频（165Hz→55），保留已验收测试台节奏',
    detect: (s) => s.includes('Math.round(hz / 60)'),
    apply: (s) => s.replace(
      'const paced = hz > 90 ? hz / 2 : (hz > 55 ? hz : prefs.frameRate);',
      'const paced = hz > 20 ? hz / Math.max(1, Math.round(hz / 60)) : 60;',
    ),
  },
  {
    file: 'frame', id: 'musicFrameStatus',
    desc: 'iframe上报音乐会话状态，主窗口才能按听歌提帧',
    detect: (s) => s.includes('musicActive: body.musicActive?.() === true'),
    apply: (s) => s.replace(
      "post({ t: 'frame', layout: body.layout(), events, sounds, z: body.z ?? null });",
      "post({ t: 'frame', layout: body.layout(), events, sounds, z: body.z ?? null, musicActive: body.musicActive?.() === true });",
    ),
  },
  {
    file: 'host', id: 'musicHostStatus',
    desc: '主窗口保存iframe音乐状态，提供musicActive查询',
    detect: (s) => s.includes('musicActive: () => musicSession') && s.includes('musicSession = m.musicActive === true'),
    apply: (s) => s
      .replace('    let layout = null, z = null, words = null;', '    let layout = null, z = null, words = null;\n    let musicSession = false;')
      .replace('      pack: pack.id,', '      pack: pack.id,\n      musicActive: () => musicSession,')
      .replace('        layout = readLayout(m.layout, size);', '        musicSession = m.musicActive === true;\n        layout = readLayout(m.layout, size);'),
  },
  {
    file: 'host', id: 'musicSubscription',
    desc: '按ear轴订阅音频，off/非听歌形象不拉采集；切回重新连接',
    detect: (s) => s.includes('const updateMusicSubscription ='),
    apply: (s) => {
      let out=s.replace('    let musicWs = null, musicRetry = 0;', `    let musicWs = null, musicRetry = 0, musicWanted = false;
    const updateMusicSubscription = (scheme) => {
      const ear = pack.axes?.findIndex(a => a.id === 'ear') ?? -1;
      musicWanted = ear >= 0 && String(knownScheme(pack, scheme)).split('-')[ear] !== 'off';
      if (!musicWanted) { const old = musicWs; musicWs = null; old?.close(); }
      else if (!musicWs && location.pathname === '/pet') connectMusic();
    };`)
        .replace('      if (gone) return;\n      try { musicWs = new WebSocket', '      if (gone || !musicWanted || musicWs) return;\n      try { musicWs = new WebSocket')
        .replace("    if (location.pathname === '/pet') connectMusic();", '    updateMusicSubscription(start.scheme);')
        .replace('        const s = ++seq;', '        updateMusicSubscription(id);\n        const s = ++seq;');
      return out;
    },
  },
  {
    file: 'host', id: 'musicSocketOwnership',
    desc: '忽略旧WebSocket回调，避免off再on时关闭新订阅',
    detect: (s) => s.includes('const ownMusicWs = musicWs;'),
    apply: (s) => s
      .replace('      musicWs.onopen = () => { musicRetry = 0; };', '      const ownMusicWs = musicWs;\n      musicWs.onopen = () => { if (musicWs === ownMusicWs) musicRetry = 0; };')
      .replace("musicWs.onmessage = (e) => { try { post", "musicWs.onmessage = (e) => { if (musicWs !== ownMusicWs || !musicWanted) return; try { post")
      .replace('musicWs.onclose = () => { musicWs = null;', 'musicWs.onclose = () => { if (musicWs !== ownMusicWs) return; musicWs = null;'),
  },
  {
    file: 'petapp', id: 'ruaCancelRelease',
    desc: '失焦或丢失指针捕获时收尾，避免rua保护卡住；正常跨屏拖拽仍沿原路径',
    detect: (s) => s.includes('// rua-cancel-release-v1')
      && s.includes("stage.addEventListener('lostpointercapture', cancelBodyPress)"),
    apply: (s) => {
      const anchor = "stage.addEventListener('pointercancel', up);";
      if (s.split(anchor).length !== 2) throw new Error('ruaCancelRelease：取消入口锚点缺失或不唯一');
      return s.replace(anchor, `${anchor}
// rua-cancel-release-v1: do not leave a held interaction alive after losing the window.
const cancelBodyPress = () => { if (pressing) up(); };
stage.addEventListener('lostpointercapture', cancelBodyPress);
window.addEventListener('blur', cancelBodyPress);`);
    },
  },
];

// Internal staged host profile: the figure owns kit/body.js.
PATCHES.splice(0,PATCHES.length,...PATCHES.filter(p=>p.file!=='body'));
delete FILES.body;
if (!process.argv.includes('--check') && !process.argv.includes('--compat-stage')) { console.error('Use tools/patch-pet-kit.mjs; this is an internal staged worker.'); process.exit(2); }
if (process.argv.includes('--revert')) { console.error('Use the version-bound transaction revert.'); process.exit(2); }
const mode = process.argv.includes('--check') ? 'check'
  : process.argv.includes('--revert') ? 'revert' : 'apply';
const MUSIC_ASSETS = [
  ['music/probe.ps1', 'web/music/probe.ps1'],
  ['music/NAudio.dll', 'web/music/NAudio.dll'],
  ['music/music-ear.ts', 'src/music-ear.ts'],
];
const manifestFile = path.join(DIR, '.petkit-transaction.json');
if (mode === 'revert') {
  if (fs.existsSync(manifestFile)) {
    const saved = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    // Validate every path before making changes, including on Windows.
    for (const item of saved) {
      const target = path.resolve(DIR, item.relative);
      if (!target.startsWith(path.resolve(DIR) + path.sep)) throw new Error('Unsafe backup path');
    }
    for (const item of saved) {
      const target = path.join(DIR, item.relative);
      if (item.content === null) fs.rmSync(target, { force: true });
      else { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, Buffer.from(item.content, 'base64')); }
    }
    fs.rmSync(manifestFile);
    console.log('已按本次补丁前的快照还原（包括原有音乐资源）。');
  } else {
    for (const [k,f] of Object.entries(FILES)) if (fs.existsSync(f+'.bak-petkit')) { fs.copyFileSync(f+'.bak-petkit', f); console.log('已还原 '+k); }
    console.log('无事务快照；仅使用历史 .bak-petkit，还原时不删除未知音乐资源。');
  }
  process.exit(0);
}
const plan = [], errors = [];
for (const [k,f] of Object.entries(FILES)) {
  if (!fs.existsSync(f)) { errors.push('找不到 '+f); continue; }
  const before = fs.readFileSync(f), original = before.toString('utf8');
  let src = original.replaceAll('\r\n', '\n');
  for (const p of PATCHES.filter(x => x.file === k)) {
    if (p.detect(src)) { console.log('✓ '+k+':'+p.id+' 已打'); continue; }
    if (mode === 'check') { errors.push(k+':'+p.id+' 未打'); continue; }
    try {
      const next = p.apply?.(src);
      if (!next || next === src || !p.detect(next)) throw new Error('锚点不匹配或结果未通过检测');
      src = next; console.log('✓ '+k+':'+p.id+' 已准备');
    } catch (e) { errors.push(k+':'+p.id+' '+e.message); }
  }
  const after = Buffer.from(original.includes('\r\n') ? src.replaceAll('\n','\r\n') : src);
  if (!before.equals(after)) plan.push({f,before,after});
}
for (const [from,to] of MUSIC_ASSETS) {
  const source=path.join(HERE,from), f=path.join(DIR,to);
  if (!fs.existsSync(source)) { errors.push('包内缺 '+from); continue; }
  const after=fs.readFileSync(source),before=fs.existsSync(f)?fs.readFileSync(f):null;
  if (from === 'music/probe.ps1' && after.some(byte => byte > 127)) {
    errors.push('probe.ps1必须为ASCII：Windows PowerShell 5.1会误读无BOM的UTF-8，导致内嵌C#编译失败');
    continue;
  }
  if (!before || !before.equals(after)) {
    if (mode==='check') errors.push('资源内容不符 '+to);
    else plan.push({f,before,after});
  }
}
if (errors.length) { console.error(errors.join('\n')+'\n预检失败，未写任何文件。'); process.exit(1); }
if (mode==='check') { console.log('全部补丁和资源内容检查通过。'); process.exit(0); }
if (!plan.length) { console.log('全部已打，无改动。'); process.exit(0); }
// Preserve the first pre-apply snapshot across repeated runs, including newly added files.
const saved=fs.existsSync(manifestFile)?JSON.parse(fs.readFileSync(manifestFile,'utf8')):[];
for (const item of plan) {
  const relative=path.relative(DIR,item.f);
  if (!saved.some(x=>x.relative===relative)) saved.push({relative,content:item.before?.toString('base64')??null});
}
fs.writeFileSync(manifestFile,JSON.stringify(saved,null,2));
try {
  for (const item of plan) {
    fs.mkdirSync(path.dirname(item.f),{recursive:true});
    if (item.before && !fs.existsSync(item.f+'.bak-petkit')) fs.writeFileSync(item.f+'.bak-petkit',item.before);
    fs.writeFileSync(item.f,item.after);
  }
} catch (e) {
  for (const item of plan) { if(item.before) fs.writeFileSync(item.f,item.before); else fs.rmSync(item.f,{force:true}); }
  throw e;
}
console.log('补丁已写入；完全退出 Coo 再启动才生效。');
