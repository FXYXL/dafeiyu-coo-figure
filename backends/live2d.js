/**
 * Live2D 渲染后端（Cubism SDK for Web）+ kit 身体。
 *
 * 分工：
 *   - 数据：models/<id>/profile.js —— role 表、表情配方、取景、部件基线（不含逻辑）
 *   - 本文件：数据 → Cubism 参数 → 绘制。**不认识任何具体 Param 名**
 *   - kit：运动学（位移、翻转、挤压、跌落、粒子、表情状态机）
 *
 * 帧顺序（照官方 LAppModel，顺序错了会出两个已知 bug）：
 *   loadParameters → 写 role（base→表情→程序动画）→ 动作 → 部件不透明度
 *   → saveParameters → physics → update → draw
 *   ↑ save 必须在 physics 之前：physics 是「读参数→算输出」，输出被存进基准
 *     下一帧又当输入，会自激（头发/胸口越抖越大）。
 *
 * 沙箱适配：
 *   1. moc3 / model3 / physics / motion / profile 全是 JS 模块（不能 fetch）
 *   2. 着色器内联，覆盖 CubismShader_WebGL.loadShader
 *   3. 贴图走 loadImage（响应带 ACAO: null）
 *   4. canvas 经 foreignObject 放进 kit 的 SVG 组，跟随整组变换
 */
import {
  CubismFramework,
  CubismMatrix44,
  CubismModelSettingJson,
  CubismShaderManager_WebGL,
  CubismUserModel,
  CubismEyeBlink,
} from '../sdk/framework.js';
import { SHADERS } from '../sdk/shaders.js';

// SDK 内置眨眼（效仿 DeepFish main.cpp CubismEyeBlink，不自己造曲线）
// 呼吸用 SDK 公式（CubismBreath 没导出，照 updateParameters 逻辑写：offset+peak*sin(2πt/cycle)）
let _eyeBlink = null;

const SVGNS = 'http://www.w3.org/2000/svg';
const XHTML = 'http://www.w3.org/1999/xhtml';

/** 角色在 256 logo 方格里的画布。 */
const BOX = 256;
const CANVAS_PX = 1024;
/** 简易模式：只走 role + 通用配方 + SoulLink，不播任何原生 exp3 / motion / Idle。 */
let SIMPLE = true;   // 由 profile.motion.native 决定是否播放模型自带的 motion / exp3

let booted = false;
function boot() {
  if (booted) return;
  if (!CubismFramework.isStarted()) CubismFramework.startUp();
  if (!CubismFramework.isInitialized()) CubismFramework.initialize();
  booted = true;
}

const b64ToBuffer = (b64) => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
};

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/**
 * 没写 anchors 时，按可见范围推一组锚点（单位：256 logo 方格）。
 * 头在框顶、气泡在头顶、泪在脸上部、z 在右上、心在左下——不同模型头身比例不同，
 * 所以这是兜底，不是标准答案；工作台里可以逐个改。
 */
function deriveAnchors([x0, y0, x1, y1]) {
  const w = x1 - x0;
  const h = y1 - y0;
  const cx = (x0 + x1) / 2;
  return {
    gaze: [cx, y0 + h * 0.2],
    tear: [cx + w * 0.16, y0 + h * 0.24],
    tears: [[cx - w * 0.12, y0 + h * 0.26], [cx + w * 0.16, y0 + h * 0.24]],
    z: [x1 - w * 0.1, y0 + h * 0.06],
    hearts: [cx - w * 0.28, y1 - h * 0.34, Math.min(w, h) * 0.36],
    bubble: [cx, y0 - 4],
  };
}

export async function createLive2DBody(base, opts, entry, kit) {
  const { host } = opts;
  const doc = host.root.ownerDocument;
  boot();

  // ---------- 数据 ----------
  let profile;
  try {
    profile = (await import(new URL(`models/${entry.id}/profile.js`, base))).default;
  } catch {
    throw new Error(`模型 ${entry.id} 缺 profile.js（role 表 / 表情配方 / 取景）`);
  }
  {
    // 包里有原生 motion 时才关掉简易模式；没有动作的模型保持轻量路径。
    if (profile.motion?.native === true && (entry.motions ?? []).length) SIMPLE = false;
  }

  // ---------- 画布（放 kit 的 SVG 组里） ----------
  // 分辨率由**贴图本身**决定：先探第一张，长边 ≥4096 就当 HD（画布 2048²、贴图上限 4096），
  // 否则维持 1024²/2048。之前两个包都封 2048，HD 的 4096×8192、8192² 全被缩成 2048，
  // 看起来和普通包一模一样（用户：「HD 没往原画靠近」）。用尺寸判断，换包不用改代码。
  let firstImg = null;
  try { firstImg = await opts.loadImage(new URL(`models/${entry.id}/${entry.textures[0]}`, base)); } catch { firstImg = null; }
  const HD_PACK = Math.max(firstImg?.naturalWidth || 0, firstImg?.naturalHeight || 0) >= 4096;
  const CANVAS_USE = HD_PACK ? 2048 : CANVAS_PX;
  const canvas = doc.createElementNS(XHTML, 'canvas');
  canvas.width = CANVAS_USE;
  canvas.height = CANVAS_USE;
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.pointerEvents = 'none';

  const fo = doc.createElementNS(SVGNS, 'foreignObject');
  fo.setAttribute('x', '0');
  fo.setAttribute('y', '0');
  fo.setAttribute('width', String(BOX));
  fo.setAttribute('height', String(BOX));
  fo.appendChild(canvas);

  const gl = canvas.getContext('webgl', {
    alpha: true, premultipliedAlpha: true, antialias: true,
  });
  if (!gl) throw new Error('这个环境无法启用 WebGL');

  // ---------- 模型（官方双轨回退：优先 fetch 原生 moc3，失败回退到 base64 模块） ----------
  const resolveAsset = (rel) => {
    if (typeof opts?.asset === 'function') {
      const u = opts.asset(rel);
      return u instanceof URL ? u : new URL(String(u), base);
    }
    return new URL(rel, base);
  };

  const mocName = entry.moc || 'model.moc3';
  const fallbackName = entry.mocFallback || (mocName.endsWith('.js') ? mocName : 'moc3.js');
  let mocBuf;
  if (!mocName.endsWith('.js')) {
    try {
      const res = await fetch(resolveAsset(`models/${entry.id}/${mocName}`));
      if (res.ok) {
        mocBuf = await res.arrayBuffer();
      }
    } catch {
      // 旧版宿主（0.2.13 及更早）CSP 拒绝 fetch，回退读取 base64 模块
    }
  }
  if (!mocBuf) {
    const mocMod = await import(resolveAsset(`models/${entry.id}/${fallbackName}`).href);
    mocBuf = b64ToBuffer(mocMod.default);
  }

  const m3 = (await import(new URL(`models/${entry.id}/${entry.model}`, base))).default;
  const m3Bytes = new TextEncoder().encode(JSON.stringify(m3));
  const setting = new CubismModelSettingJson(m3Bytes.buffer, m3Bytes.length);

  const model = new (class extends CubismUserModel {})();
  model.loadModel(mocBuf, true);
  if (!model._model) throw new Error('moc3 解析失败');

  // ---------- 取景：按规则装进 clip 空间 ----------
  // 必须在 applyFit 之前初始化（applyFit 由工作台实时调用）
  let fitState = {
    mode: 'contain',
    anchor: 'bottom',
    padding: [0.04, 0.02],
    offset: [0, 0],
    zoom: 1,
    autoFit: true,
    ...(profile.fit ?? {}),
  };
  applyFit();

  if (entry.physics) {
    const phys = (await import(new URL(`models/${entry.id}/${entry.physics}`, base))).default;
    const bytes = new TextEncoder().encode(JSON.stringify(phys));
    model.loadPhysics(bytes.buffer, bytes.length);
  }
  if (entry.pose) {
    const pose = (await import(new URL(`models/${entry.id}/${entry.pose}`, base))).default;
    const bytes = new TextEncoder().encode(JSON.stringify(pose));
    model.loadPose(bytes.buffer, bytes.length);
  }

  model.createRenderer(canvas.width, canvas.height);
  const renderer = model.getRenderer();
  renderer.setClippingMaskBufferSize(512);
  renderer.startUp(gl);
  renderer.setIsPremultipliedAlpha(true);
  // 遮罩层数多的模型必须走高精度遮罩：低精度路径最多 4 层共用一张缓冲，超过就裁不干净，
  // 半透明层会整块盖在脸上，看起来像"贴了一张纸"。
  try {
    const counts = model._model.getDrawableMaskCounts();
    let maxMasks = 0;
    for (let i = 0; i < counts.length; i++) if (counts[i] > maxMasks) maxMasks = counts[i];
    if (maxMasks > 4) renderer.useHighPrecisionMask(true);
  } catch { /* 老 Core 没有这个能力就按原样渲染 */ }

  // 着色器内联
  const shader = CubismShaderManager_WebGL.getInstance().getShader(gl);
  if (shader) {
    shader.loadShader = (url) => Promise.resolve(SHADERS[String(url).split('/').pop()] ?? '');
  }
  const loading = renderer.loadShaders?.(new URL('shaders/', base).href);
  if (loading && typeof loading.then === 'function') await loading;

  // 贴图：后台加载，不阻塞 ready（8192² 在慢显卡上要几秒，kit 只等 20 秒）。
  // 尺寸兜底：包里已经缩过图（convert --max-texture），但老包 / 别人给的包可能还是 4096~8192。
  // 一张 8192² RGBA 显存 256 MB，桌宠实际只占 200 px 高——超过 maxTex 先在 2D canvas 里缩再上传。
  // HD 贴图放到 4096（8192² 直接上传要 256MB/张）；普通包贴图本来就 ≤2048，不受影响。
  const maxTex = Math.min(4096, Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 2048);
  const isPOT = (n) => n > 0 && (n & (n - 1)) === 0;
  const shrinkForUpload = (img) => {
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    const longest = Math.max(w, h);
    if (longest <= maxTex) return { src: img, w, h };
    const k = maxTex / longest;
    const nw = Math.max(1, Math.round(w * k));
    const nh = Math.max(1, Math.round(h * k));
    const c = doc.createElement('canvas');
    c.width = nw;
    c.height = nh;
    const cx = c.getContext('2d');
    cx.imageSmoothingEnabled = true;
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(img, 0, 0, nw, nh);
    console.warn(`[l2d] 贴图超上限，运行时缩到 ${nw}×${nh}（原 ${w}×${h}）：包里跑一次构建即可持久化`);
    return { src: c, w: nw, h: nh };
  };

  let texturesReady = false;
  (async () => {
    for (let i = 0; i < entry.textures.length; i++) {
      const img = i === 0 && firstImg ? firstImg : await opts.loadImage(new URL(`models/${entry.id}/${entry.textures[i]}`, base));
      const { src, w, h } = shrinkForUpload(img);
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
      // 缩小采样用 mipmap：8192→200 px 只用 LINEAR 会闪；缩到 2048 之后 mipmap 只要几毫秒。
      // 非 2 的幂（WebGL1）不能建 mipmap，退回 LINEAR。
      const pot = isPOT(w) && isPOT(h);
      if (pot) gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, pot ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const aniso = gl.getExtension('EXT_texture_filter_anisotropic') || gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic');
      if (aniso && pot) {
        const max = gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) || 1;
        gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(4, max));
      }
      renderer.bindTexture(i, tex);
    }
    model.setInitialized(true);
    texturesReady = true;
  })().catch((e) => console.error('贴图加载失败', e));

  // ---------- 动作 ----------
  // 每条动作都必须 setEffectIds：CubismMotion 每帧读 _eyeBlinkParameterIds /
  // _lipSyncParameterIds，不设是 null → updateMotion 每帧抛 TypeError → 动作静默失效。
  const eyeBlinkIds = [];
  const lipSyncIds = [];
  for (let i = 0; i < setting.getEyeBlinkParameterCount(); i++) eyeBlinkIds.push(setting.getEyeBlinkParameterId(i));
  for (let i = 0; i < setting.getLipSyncParameterCount(); i++) lipSyncIds.push(setting.getLipSyncParameterId(i));

  // SDK 内置眨眼（效仿 DeepFish main.cpp：CubismEyeBlink + SetBlinkingInterval 3.2秒）
  // model3.json 没定义 EyeBlink 参数 → getEyeBlinkParameterCount=0 → eyeBlinkIds 空 → 手动设
  _eyeBlink = new CubismEyeBlink();
  const blinkIds = eyeBlinkIds.length > 0 ? eyeBlinkIds : ['ParamEyeLOpen', 'ParamEyeROpen'];
  _eyeBlink.setParameterIds(blinkIds);
  _eyeBlink.setBlinkingInterval(3.2);
  console.log('[eyeBlink] ids=' + blinkIds.join(',') + ' interval=3.2 created=' + !!_eyeBlink);

  const clips = new Map();
  for (const m of entry.motions ?? []) {
    try {
      const mod = await import(new URL(`models/${entry.id}/${m.file}`, base));
      const buf = b64ToBuffer(mod.default);
      const clip = model.loadMotion(buf, buf.byteLength, m.id);
      if (clip) {
        clip.setEffectIds(eyeBlinkIds, lipSyncIds);
        // 素材里可能是循环动作（VTS 当热键开关）；手势在 startClip 里强制一次性
        clip.setLoop(!!m.loop);
        if (m.fadeIn) clip.setFadeInTime(m.fadeIn);
        clips.set(m.id, clip);
      }
    } catch (e) {
      console.warn('motion 载入失败', m.id, e);
    }
  }

  // ---------- 原生表情（exp3）----------
  // 模型自带的表情文件比通用配方更贴脸；由 profile.expressions 把词映射到文件。
  const expressions = new Map();
  const exp3Params = new Map();   // exp3 名 → 它写的参数 id 列表（切换时清残留用）
  const exprJson = new Map();     // 保留原始 JSON，供组合表情合并
  for (const e of entry.expressions ?? []) {
    try {
      const mod = await import(new URL(`models/${entry.id}/${e.file}`, base));
      exprJson.set(e.id, mod.default);
      const bytes = new TextEncoder().encode(JSON.stringify(mod.default));
      const clip = model.loadExpression(bytes.buffer, bytes.length, e.id);
          exp3Params.set(e.id, (exprJson.get(e.id)?.Parameters ?? []).map((q) => q.Id));
      if (clip) expressions.set(e.id, clip);
    } catch (err) {
      console.warn('表情载入失败', e.id, err);
    }
  }

  // ---------- 组合表情 ----------
  // exp3 本质是"一张参数设置表"，所以组合＝把几张表的参数并集（同 Id 后者覆盖）。
  // 在载入阶段合成一个 clip，运行时就只是一次 startMotion，不用处理叠加顺序。
  for (const [comboId, parts] of Object.entries(profile.expressionCombos ?? {})) {
    const src = (parts ?? []).map((p) => exprJson.get(p)).filter(Boolean);
    if (!src.length) { console.warn('[l2d] 组合表情缺少来源', comboId, parts); continue; }
    const params = new Map();
    const parts2 = new Map();
    for (const j of src) {
      for (const p of j.Parameters ?? []) params.set(p.Id, p);
      for (const p of j.PartOpacities ?? []) parts2.set(p.Id, p);
    }
    const merged = {
      ...src[0],
      Parameters: [...params.values()],
      PartOpacities: [...parts2.values()],
    };
    try {
      const bytes = new TextEncoder().encode(JSON.stringify(merged));
      const clip = model.loadExpression(bytes.buffer, bytes.length, comboId);
      if (clip) expressions.set(comboId, clip);
      else console.warn('[l2d] 组合表情合成失败', comboId);
    } catch (err) {
      console.warn('[l2d] 组合表情载入失败', comboId, err);
    }
  }
  // 常规情绪 + 模型的"重口味"表情（圈圈眼、黑脸…）。
  // 后者不挂默认情绪，只作为独立词存在，AI 主动打 <circleEyes> 才会用到。
  // ---------- 头部/脸部包围盒（S0，2026-11-23）----------
  // 不再用「整幅 canvas 包围盒 × 比例」推头：这张 canvas 被尾巴和头发撑宽，头心会偏右，
  // 之前只能退回手写的 128/58 救命。改成用模型自己的部件树：
  //   cdi3.json 里有显示名（Part99 = 头、Part15 = 脸、Part9 = 五官），moc3 的 part id 就是 cdi3 的 Id。
  //   取「头」的整棵子树（含脸/五官/头发），每帧把它的 drawable 顶点聚合成包围盒。
  // 这样前倾、歪头、呼吸都跟着走；换体型/换皮肤也不用重调比例。
  // 拿不到（换皮、部件改名）就返回 null，调用处退回旧的比例盒。
  const headBoxDbg = { build: 'pending', root: '', parts: 0, drawables: 0, names: [] };
  let headParts = null;   // { drawables: number[], names: string[] }
  let faceParts = null;
  let hairParts = null;   // 后发/下侧发：只取头部高度以内那圈

  async function buildPartBoxes() {
    try {
      const cdi = (await import(new URL(`models/${entry.id}/cdi3.js`, base))).default;
      const nameById = new Map((cdi.Parts ?? []).map((p) => [String(p.Id), String(p.Name ?? '')]));
      const M = model._model;
      const n = M?.getPartCount?.() ?? 0;
      if (!n) { headBoxDbg.build = 'no-parts-api'; return; }
      const parents = M.getPartParentPartIndices?.() ?? [];
      const ids = [];
      for (let i = 0; i < n; i++) { const pid = M.getPartId(i); ids.push(String(pid?.getString ? pid.getString() : (pid ?? ''))); }
      const pick = (names) => {
        const roots = [];
        for (let i = 0; i < n; i++) {
          const name = nameById.get(ids[i]) ?? '';
          if (names.some((k) => name.includes(k))) roots.push(i);
        }
        if (!roots.length) return null;
        const set = new Set(roots);
        for (let grew = true; grew;) {
          grew = false;
          for (let i = 0; i < n; i++) {
            if (!set.has(i) && set.has(parents[i])) { set.add(i); grew = true; }
          }
        }
        const drawables = [];
        const dc = M.getDrawableCount();
        for (let d = 0; d < dc; d++) {
          if (set.has(M.getDrawableParentPartIndex(d))) drawables.push(d);
        }
        if (!drawables.length) return null;
        const names2 = [...set].map((i) => nameById.get(ids[i]) ?? ids[i]);
        return { drawables, partCount: set.size, names: names2, set };
      };
      // 「头」优先；有的模型没有头部件，就退而用 脸+五官+头发（HD 包/换皮时走这条）
      const head = pick(['头', 'Head', '頭'])
        ?? pick(['脸', '臉', '五官', '前发', '后发', '头发']);
      const face = pick(['五官', '脸', '臉']);
      // 后发/下侧发挂在身体下面，整块包围盒会垂到腰，但**贴近头的那圈头发**属于「摸头」的范围。
      // 单独取出来，由 partBox 按头的下巴高度裁一刀，只留头部高度以内那段。
      const hair = pick(['后发', '下侧发', '側髮', '後髮']);
      if (hair && head?.set) {
        hair.drawables = hair.drawables.filter((d) => !head.set.has(M.getDrawableParentPartIndex(d)));
      }
      headParts = head;
      faceParts = face ?? head;
      hairParts = hair && hair.drawables.length ? hair : null;
      headBoxDbg.build = head ? 'ok' : 'no-part';
      headBoxDbg.root = head ? head.names.join('/').slice(0, 60) : '';
      headBoxDbg.parts = head?.partCount ?? 0;
      headBoxDbg.drawables = head?.drawables.length ?? 0;
      headBoxDbg.names = head?.names ?? [];
      console.log('[headBox] ' + headBoxDbg.build + ' 部件=' + headBoxDbg.parts + ' drawable=' + headBoxDbg.drawables
        + ' ' + (head ? head.names.slice(0, 8).join(',') : ''));
    } catch (e) {
      headBoxDbg.build = 'err:' + (e?.message ?? e);
      console.warn('[headBox] 初始化失败，退回比例盒', e);
    }
  }
  // drawable 顶点是**模型归一化坐标**（画布 ±1），extent/touchZones 用的是 logo 单位（BOX=256，原点左下）。
  // 换算走渲染用的同一条矩阵链：projection.scale(h/w,1) * modelMatrix，再 NDC → logo。
  function modelToLogoMatrix() {
    const p = new CubismMatrix44();
    p.scale(canvas.height / canvas.width, 1);
    p.multiplyByMatrix(model._modelMatrix);
    return p.getArray();
  }
  // 模型坐标的包围盒 → logo 单位（用同一矩阵映射四个角，取 min/max）
  // clipY：只统计模型 y ≥ clipY 的顶点（后发要按头的下巴裁一刀，否则会垂到腰）
  function partBox(parts, clipY = -Infinity) {
    if (!parts) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const d of parts.drawables) {
      let v;
      try { v = model._model.getDrawableVertices(d); } catch { continue; }
      if (!v || !v.length) continue;
      for (let i = 0; i < v.length; i += 2) {
        const x = v[i], y = v[i + 1];
        if (y < clipY) continue;
        if (x < x0) x0 = x; else if (x > x1) x1 = x;
        if (y < y0) y0 = y; else if (y > y1) y1 = y;
      }
    }
    if (!(x1 > x0 && y1 > y0)) return null;
    const a = modelToLogoMatrix();
    let lx0 = Infinity, ly0 = Infinity, lx1 = -Infinity, ly1 = -Infinity;
    for (const [mx, my] of [[x0, y0], [x0, y1], [x1, y0], [x1, y1]]) {
      const nx = a[0] * mx + a[4] * my + a[12];
      const ny = a[1] * mx + a[5] * my + a[13];
      const lx = (nx + 1) / 2 * BOX;
      // logo 的 y 是**从顶部往下**（kit 的 ay=256 是脚底，extent 也是这个方向），NDC 是往上，所以这里要翻
      const ly = (1 - ny) / 2 * BOX;
      if (lx < lx0) lx0 = lx; if (lx > lx1) lx1 = lx;
      if (ly < ly0) ly0 = ly; if (ly > ly1) ly1 = ly;
    }
    return {
      x: (lx0 + lx1) / 2, y: (ly0 + ly1) / 2, rx: (lx1 - lx0) / 2, ry: (ly1 - ly0) / 2,
      x0: lx0, y0: ly0, x1: lx1, y1: ly1,
      model: { x0, y0, x1, y1 },
    };
  }
  // 头盒 = 头部件子树 ∪（后发/下侧发里、头部高度以内的那段）
  function headBoxModel() {
    const bone = partBox(headParts);
    if (!bone) return null;
    if (!hairParts) return bone;
    const mh = bone.model.y1 - bone.model.y0;
    const hair = partBox(hairParts, bone.model.y0 - mh * 0.12);
    if (!hair) return bone;
    const x0 = Math.min(bone.x0, hair.x0), x1 = Math.max(bone.x1, hair.x1);
    const y0 = Math.min(bone.y0, hair.y0), y1 = Math.max(bone.y1, hair.y1);
    return {
      x: (x0 + x1) / 2, y: (y0 + y1) / 2, rx: (x1 - x0) / 2, ry: (y1 - y0) / 2,
      x0, y0, x1, y1, model: bone.model,
    };
  }
  const faceBoxModel = () => partBox(faceParts);
  void buildPartBoxes();

  // 每帧最多算一次：zoneAt 是每个 pointermove 调一次，逐顶点重算太重
  let boxCacheT = Number.NaN, boxCache = null;
  function headFaceBoxes() {
    if (boxCacheT === clockT && boxCache) return boxCache;
    boxCacheT = clockT;
    boxCache = { head: headBoxModel(), face: faceBoxModel() };
    return boxCache;
  }

  const exprTable = { ...(profile.expressions ?? {}), ...(profile.extraExpressions ?? {}) };
  let currentExpr = null;
  let expressionOverride = null;

  // ---------- 表情基调（face）→ 通道词（2026-11-18 双轨合并：exp3 机制退役）----------
  // 【害羞】这类表情的 keyN 效果已全部翻译成通道词（profile.faceWords）。
  // face 变化 = 触发对应词（全套机制：互斥/放松/beat）；face 不变 = 续命（保持语义）。
  let prevFaceForWords = null;
  function stepExpression(face, dt) {
    if (SIMPLE) return;
    const fw = profile.faceWords?.[face];
    if (face !== prevFaceForWords) {
      prevFaceForWords = face;
      // 基调切换【不再连坐清 keep】（2026-11-20 根因修复）：kit 表情词（shy 等）setExpr
      // 会改变 face，触发这里把全部 keep 条目删掉——【eye-close, shy】的闭眼被连坐清掉
      // （脸红影子经 faceWords 重写所以幸存，闭眼死了）。情绪换情绪的让位由互斥组管
      // （决策记录定过的语义），faceLinked 影子由 actWord 开头清——这里清是多余且有害的。
      // 旧 exp3 联动的参数清零（退役兼容：历史切换可能留下的 keyN 残留归零）
      const oldExpParams = currentExpr ? exp3Params.get(currentExpr) : null;
      if (oldExpParams) for (const qid of oldExpParams) {
        dropParam(qid);
        try { model._model.setParameterValueById(qid, 0); } catch { /* 参数不存在则跳过 */ }
      }
      if (fw) actWord(fw, true);
    }
    // （face 不变时不再续命——faceWords 词标 faceLinked，寿命=到下一个词/face 变化）
  }

  let currentId = null;
  let heldGesture = null;   // 正在"保持末帧"的动作（换手类）
  let idlePlaying = false;
  let idleTurn = 0;
  let lastGesture = null;
  let motionWarned = false;
  const idleIds = (entry.idle ?? []).map((m) => m.id).filter((id) => clips.has(id));

  const startClip = (id, priority, loop = false) => {
    const clip = clips.get(id);
    if (!clip) return false;
    try {
      clip.setLoop(loop);
      model._motionManager.startMotionPriority(clip, false, priority);
      currentId = id;
      return true;
    } catch (e) {
      console.warn('motion 播放失败', id, e);
      return false;
    }
  };

  function startIdle() {
    if (!idleIds.length) return false;
    const id = idleIds[idleTurn++ % idleIds.length];
    model._motionManager.stopAllMotions();
    const ok = startClip(id, 1, true);
    idlePlaying = ok;
    return ok;
  }

  // ---------- role 表：语义 → 真实参数 ----------
  const ids = CubismFramework.getIdManager();
  const paramIndex = new Map();
  for (let i = 0; i < model._model.getParameterCount(); i++) {
    paramIndex.set(model._model.getParameterId(i).getString(), i);
  }

  /**
   * 2026-11-21 照 DeepFish 的 vtube 映射（大肥鱼.vtube.json ParameterSettings）：
   * FaceAngleX → AngleX + PositionX、FaceAngleY → AngleY + PositionY、FaceAngleZ → AngleZ + PositionZ（1:1）。
   * 他们每帧写 FaceAngle*，映射器同时喂「头角度」和「重心」，所以**动作会带动身体**（用户：这四个动作都带动身体）。
   * 我们之前只写 AngleX/Y/Z（物理输入），没写 Position，头动了身体不动。
   * 这里在动作写参数时同步派生 Position —— 只作用于词/动作，不影响程序内的鼠标跟随（bodyX 另有系数）。
   */
  // 2026-11-22 实测结论：模型里 `AngleX/Y/Z` 和 `ParamAngleX/Y/Z` **两套都有**，
  // 但 `ParamAngle*` 每帧被 idle motion 重写（写成 0），写它等于被吃掉；
  // `Angle*` 是这套模型独占的头部输入，motion 不碰 → 头角度必须写 Angle。
  const ANGLE_TO_POS = { AngleX: 'PositionX', AngleY: 'PositionY', AngleZ: 'PositionZ' };
  function setParamByName(id, v) {
    const i = paramIndex.get(id);
    if (i === undefined) return;
    model._model.setParameterValueByIndex(i, v);
    const posId = ANGLE_TO_POS[id];
    if (posId) {
      const pi = paramIndex.get(posId);
      if (pi !== undefined) model._model.setParameterValueByIndex(pi, v);
    }
  }

  /** 把增量加到参数当前值上（轨道相加用），并夹在参数范围内。
   *  他们 main.cpp:585 `input->second += value` 的同款语义。夹范围是必要的——
   *  Cubism 写超范围不会自己 clamp，超了模型会明显变形（几个动作叠在一起就是这样）。 */
  function addParam(id, delta) {
    const i = paramIndex.get(id);
    if (i === undefined) {
      const cur = virtualParams.get(id)?.v ?? 0;
      virtualParams.set(id, { v: cur + delta, t: clockT });
      return;
    }
    const cur = model._model.getParameterValueByIndex(i);
    const v = clamp(cur + delta,
      model._model.getParameterMinimumValue(i),
      model._model.getParameterMaximumValue(i));
    model._model.setParameterValueByIndex(i, v);
    const posId = ANGLE_TO_POS[id];
    if (posId) {
      const pi = paramIndex.get(posId);
      if (pi !== undefined) model._model.setParameterValueByIndex(pi, v);
    }
  }

  /** 每个 role 只保留模型里真实存在的目标参数。 */
  const roles = new Map();
  for (const [name, r] of Object.entries(profile.roles ?? {})) {
    const items = [];
    for (const target of r.targets ?? []) {
      const index = paramIndex.get(target);
      if (index === undefined) continue;
      items.push({
        handle: ids.getId(target),
        index,
        min: model._model.getParameterMinimumValue(index),
        max: model._model.getParameterMaximumValue(index),
        def: model._model.getParameterDefaultValue(index),
      });
    }
    if (!items.length) continue;
    roles.set(name, { space: r.space ?? [-1, 1], def: r.default ?? 0, items });
  }

  const driven = new Set();
  for (const role of roles.values()) for (const it of role.items) driven.add(it.handle.getString());

  // 工作台/外部驱动：直接写 role（优先级最高，调试与校准时用）
  const roleOverrides = {};

  // ---------- 表演层（SoulLink）----------
  // 情绪词 → VAD → FACS → role，负责过渡、待机微动、呼吸和视线漂移。
  // 加载失败就退回下面的离散表情配方，包不会因此不可用。
  let performance = null;
  try {
    const { createPerformance } = await import('./soullink.js');
    performance = createPerformance(profile, console.warn);
    if (performance) {
      console.info('[l2d] SoulLink 表演层已启用');
      // 有原生 Idle 组就让模型自己待机，引擎只负责情绪和表情
      if (!SIMPLE && idleIds.length && profile.performance?.tuning?.nativeIdle !== false) {
        performance.setIdleEnabled(false);
        console.info('[l2d] 使用模型原生 Idle 动作');
      }
    }
  } catch (e) {
    console.warn('[l2d] SoulLink 表演层没加载，使用离散表情', e);
  }

  /**
   * 语义值 → 模型值：以 default 为锚的两段线性。
   * 这样模型范围不对称、默认值不在中点也不会错。
   */
  function writeRole(name, semantic) {
    const role = roles.get(name);
    if (!role) return;
    const [lo, hi] = role.space;
    const d = role.def;
    const v = clamp(semantic, lo, hi);
    for (const it of role.items) {
      const mv = v >= d
        ? it.def + (hi === d ? 0 : ((v - d) / (hi - d)) * (it.max - it.def))
        : it.def - (d === lo ? 0 : ((d - v) / (d - lo)) * (it.def - it.min));
      model._model.setParameterValueById(it.handle, clamp(mv, it.min, it.max));
    }
  }

  // ---------- 部件不透明度 ----------
  // Cubism SDK 把 PartOpacity 曲线按「参数」查索引（getParameterIndex），
  // 而 PartArmA/B 是部件 → 恒 -1，曲线整条失效 → 两套手臂同时显示（四只手）。
  // 所以按动作自带的目标值每帧直接写部件不透明度。
  const partIndex = new Map();
  for (let i = 0; i < model._model.getPartCount(); i++) {
    partIndex.set(model._model.getPartId(i).getString(), i);
  }
  const partTargets = new Map((entry.motions ?? []).map((m) => [m.id, m.partOpacity ?? null]));
  const baseParts = profile.parts?.base ?? { PartArmA: 1, PartArmB: 0 };

  // ---------- 清理：水印 / 文字类部件与参数 ----------
  // profile.clean 是打包时（设置里打开「清理」）写进来的：部件一律透明，
  // 参数固定成作者“关掉水印”表情里的值。这里每帧最后写一次，压过表情 / 物理。
  const cleanParts = profile.clean?.parts ?? {};
  const cleanParams = profile.clean?.params ?? {};
  const cleanParamIdx = new Map();
  for (const name of Object.keys(cleanParams)) {
    for (let i = 0; i < model._model.getParameterCount(); i++) {
      if (model._model.getParameterId(i).getString() === name) { cleanParamIdx.set(name, i); break; }
    }
  }
  function applyCleanParams() {
    for (const [name, i] of cleanParamIdx) {
      model._model.setParameterValueByIndex(i, cleanParams[name]);
    }
  }

  // ---------- 方案（多轴）----------
  // figure.json 的 axes 会拼成 "model-<体型>-<服装>-<配件>" 这样的 scheme。
  // 每一轴的选项在 profile.schemes 里声明要写死的参数（也可用 parts 改部件不透明度）。
  // 这些开关是"状态量"，不是表情，所以每帧最后写一次，压过表情和物理。
  let schemeParams = {};
  const schemeIdx = new Map();
  function resolveScheme() {
    // scheme 形如 "deepseek-<第1轴>-<第2轴>-<第3轴>"，顺序与 figure.json 的 axes 一致。
    // 必须按位置取，不能用 token 名去匹配 —— 每个轴都有 default，按名字会全部命中第一个。
    const tokens = String(opts.scheme || '').split('-');
    // 兼容两种写法：老 scheme 带形象 id 前缀（deepseek-type1-short），
    // 新 scheme 只由各轴选项拼成（type1-short）。第一段等于模型 id 就跳过。
    const start = tokens[0] === (entry.id ?? '') ? 1 : 0;
    const out = {};
    let slot = start;
    for (const [axis, options] of Object.entries(profile.schemes ?? {})) {
      const token = tokens[slot++];
      const pick = token && Object.prototype.hasOwnProperty.call(options, token) ? token : 'default';
      Object.assign(out, (options[pick] ?? options.default ?? {}).params ?? {});
    }
    schemeParams = out;
    // 取景同样按位置叠加：每个选项可以带自己的 fit（不同身形占的画布区域不同）。
    // 这里也必须按位置取 token —— 用名字找的话，每轴都有 default，会全部命中第一个。
    const optionFit = {};
    let fitSlot = start;
    for (const [axis, options] of Object.entries(profile.schemes ?? {})) {
      const token = tokens[fitSlot++];
      const pick = token && Object.prototype.hasOwnProperty.call(options, token) ? token : 'default';
      const f = (options[pick] ?? options.default ?? {}).fit;
      if (f) Object.assign(optionFit, f);
    }
    // 无条件重置 fitState：切回不带 fit 的选项时必须落回基础取景，
    // 否则上一套的 zoom / offset 会残留在身上（Q 版切回默认 → 巨大半身像）。
    fitState = { mode: 'contain', anchor: 'bottom', padding: [0.04, 0.02], offset: [0, 0], zoom: 1, ...(profile.fit ?? {}), ...optionFit };
    try { applyFit(); } catch { /* 下一帧生效 */ }
    schemeIdx.clear();
    for (const name of Object.keys(out)) {
      for (let i = 0; i < model._model.getParameterCount(); i++) {
        if (model._model.getParameterId(i).getString() === name) { schemeIdx.set(name, i); break; }
      }
    }
  }
  function applySchemeParams() {
    for (const [name, i] of schemeIdx) model._model.setParameterValueByIndex(i, schemeParams[name]);
  }
  resolveScheme();

  function applyPartOpacity(id) {
    const want = { ...((id && partTargets.get(id)) || baseParts), ...cleanParts };
    for (const name of Object.keys(want)) {
      const i = partIndex.get(name);
      if (i !== undefined) model._model.setPartOpacityByIndex(i, want[name]);
    }
  }

  /** 动作播完后，把动作碰过、role 不负责的参数慢慢拉回默认（避免姿势定格）。 */
  function easeRestToDefault(dt) {
    const rate = clamp(dt * 4, 0, 1);
    for (let i = 0; i < model._model.getParameterCount(); i++) {
      if (driven.has(model._model.getParameterId(i).getString())) continue;
      const cur = model._model.getParameterValueByIndex(i);
      const def = model._model.getParameterDefaultValue(i);
      if (cur !== def) model._model.setParameterValueByIndex(i, cur + (def - cur) * rate);
    }
  }

  // ---------- 参数动作 ----------
  // kit 的动作是整体变换（旋转/缩放整张图）；模型自己的参数能做出透视变形，
  // 比如 LeanInput 让头和胸往镜头靠。两者叠加才像"探身"，单靠旋转只是"歪一下"。
  // frame.gesture = { kind, k: 0..1 }，k 是动作进度。
  // role 覆盖的参数：每帧由 applyFrame 重写，动作结束时不需要（也不应该）归零。
  const ROLE_OWNED = new Set();
  for (const r of Object.values(profile.roles ?? {})) for (const t of r.targets ?? []) ROLE_OWNED.add(t);
  const paramActs = profile.paramActs ?? {};
  // 2026-11-21：照鬼点子（sly-idea，已验证正常）的写法——退出动画统一并进主 keys 单一时间轴。
  // 原来 finger-point/chest-hand/grass-hand 把收手放在独立的 exit 字段，那套机制从没被正确调用（闪现的真凶）。
  // 合并：exit.keys 平移到 dur*0.72 开始接在主 keys 后面，dur 延长到收手结束。
  for (const a of Object.values(paramActs)) {
    if (!a?.exit?.keys?.length || !a.keys?.length) continue;
    const offset = (a.dur ?? 4) * 0.72;
    const edur = a.exit.dur ?? 1.25;
    // 2026-11-23：合并前留一份原样。clip 自带的手型要「抬起来一直举着，等 clip 说放」，
    // 不能用合并后的时间轴（那套 4 秒就自己放下了）；relaxChannels 也要能拿到收手段。
    a.raiseKeys = a.keys.slice();
    a.exitKeys = a.exit.keys.map((f) => ({ ...f }));
    a.exitDur = edur;
    a.keys = a.keys.concat(a.exit.keys.map((f) => ({ ...f, t: (f.t ?? 0) + offset })));
    a.dur = offset + edur;
    delete a.exit;
  }
  let activeAct = null;
  let activePost = null;   // 当前动作里"必须在物理之后写"的波形（腰/胯这类物理输出参数）
  let bodyLook = [0, 0];   // 本帧的指针跟随量，applyBodyFollow 在物理之后用它推身体
  // rua 4.x（2026-11-21 figure 侧重写，旧的随 git checkout 丢了）：手驱动头的弹簧状态
  const ruaS = { ax: 0, ay: 0, axv: 0, ayv: 0 };
  // rua 单闭眼的缓动状态（0=不闭 1=全闭）。照他们 Hold 的 1-exp(-dt/0.15)：
  // 手移到脸侧时眼睛是「半眯→闭」的柔和过渡，不是硬切（后面搬 rua 头就靠这条）。
  const ruaEyeS = { L: 0, R: 0 };
  // rua 档位状态（2026-11-22 重做）：峰值时长、猛摸计时/瞪眼冷却、松手检测
  let ruaPeak = 0, ruaFastT = 0, ruaStartleAt = -9, ruaStartle = -9, ruaPrevOn = false;
  // 2026-11-22：猛摸瞪眼的包络、松手后的"摸后"情绪（他们 PlayAfterStroke 的 mood）、上次结束时刻
  let ruaStartleK = 0, ruaLastEnd = -9;
  /** 脸红强度 0→1 的缓动（他们「脸红」是表情层，有淡入；我们直接写 key7=1 是硬切，红得很突然） */
  let blushK = 0, lastBlushAt = -9;
  /** rua 表情的淡出权重：摸时 1，松手后 0.35 秒时间常数淡到 0。
   *  他们的 Face(NoSets,…) 是给 Live2D 宿主发 clear 命令、宿主带过渡淡回默认；
   *  我们直写参数，不写就下一帧回基准 → 瞬间归零（用户：「非常生硬」）。 */
  let ruaW = 0;
  /** rua 期间最后一次的档位秒数：松手后 frame.rua 没了，档位不能跟着跌回 0。 */
  let ruaSecHold = 0;
  /** 松手后淡出用的「最后一次手位 / 融化度」：frame.rua 一消失 ux/uy/melt 就归零，
   *  直接读它们等于瞬间把前倾、歪头、眼珠弹回默认。 */
  let ruaUxHold = 0, ruaUyHold = 0, ruaMeltHold = 0;
  /** 前倾的退出权重：mood 演完才开始褪（他们 clear 是宿主带过渡，我们只能自己补）。
   *  用户：前倾保持了，但「动作都没做完直接硬拉回去，甚至没有曲线回拉」。 */
  let ruaLeanK = 1;
  let ruaWasOn = false;
  /** 摸后的四个 mood（Behavior.cs:59-67 全搬）。
   *  他们的 Mood 记录是 `record Mood(string[] Expressions, (string Id,double Value)[] Parameters,
   *  double Seconds, (string Id,string Keys)[]? Motion, (string On,string Off)? Gesture, bool Pushed)`：
   *    Expressions → 表情层（exp），四个摸后档位**全部带 ["脸红"]**
   *    Parameters  → 固定表情（sets），整段按 set 按住
   *    Motion      → 关键帧（keys），叠加在 sets 上
   *    Gesture     → 手型切换（默认手切举手 = 抬手到胸口）
   *  我们的模型没有 exp 层，「脸红」就是贴图参数 key7 → exps 里写逻辑名，运行时映射成 key7。 */
  const RUA_MOODS = {
    // 数据全部逐字对 Behavior.cs:25 的 Moods 表（2026-11-23 重新核过一遍）。
    // 他们的时间轴规则：所有 keys 的最后一帧正好落在 Seconds，Seconds 到点 EndMood：
    //   exp 关（0.5s 权重淡出）+ clear 每个 set（0.15s 时间常数）+ motion 收手（同一个 tick）。
    // 所以「一起收」是他们数据格式逼出来的，不是调出来的。
    lost: {   // 摸后失落（按了 3 秒以内）
      dur: 3.4, delay: 1.5,
      exps: ['脸红'],
      sets: { BrowInnerUp: .7, ParamMouthPressLipOpen: .3, ParamMouthForm: -.1, ParamEyeBallY: -.4, FaceAngleY: -5, FaceAngleZ: 4 },
      keys: {
        FaceAngleZ: [[0, 0], [.5, 3], [1.3, -2], [2.1, 3], [3.4, 0]],
        ViewSquash: [[0, 0], [.3, .01], [2.8, .01], [3.4, 0]],
      },
    },
    reluctant: {   // 摸后不舍（3~8 秒）—— 他们没有手型，之前我们多抬了一次手
      dur: 4, delay: 1.5,
      exps: ['脸红'],
      sets: { EyeSmile: .45, BrowInnerUp: .9, ParamMouthPressLipOpen: .5, ParamMouthForm: .2, ParamEyeBallY: -.45, FaceAngleY: -8, FaceAngleZ: 7 },
      keys: {
        LeanInput: [[0, 0], [.5, -9], [3.3, -8], [4, 0]],
        FaceAngleZ: [[0, 0], [.7, 3], [1.5, -3], [2.3, 3], [3.1, -2], [4, 0]],
        ViewSquash: [[0, 0], [.4, .02], [3.4, .02], [4, 0]],
      },
    },
    clingy: {   // 摸后腻歪（8~20 秒）
      dur: 4.8, delay: 1.5,
      exps: ['脸红'],
      sets: { EyeSmile: .6, ParamMouthForm: 1, ParamMouthPressLipOpen: .4, BrowInnerUp: .6, FaceAngleY: -6, FaceAngleZ: 9 },
      keys: {
        LeanInput: [[0, 0], [.5, -15], [3.9, -14], [4.8, 0]],
        FaceAngleZ: [[0, 0], [.8, 3], [1.6, -3], [2.4, 3], [3.2, -3], [4, 2], [4.8, 0]],
        FaceAngleX: [[0, 0], [.8, -4], [1.8, 4], [2.8, -4], [3.8, 3], [4.8, 0]],
        ViewSquash: [[0, 0], [.5, .03], [4.1, .03], [4.8, 0]],
      },
      hand: true,   // 他们的 Gesture = ("默认手切举手", "举手切默认手")
    },
    melt: {   // 摸后融化（20 秒彩蛋）—— 他们只等 0.8 秒就演（PetWindow.Touch.cs:212）
      dur: 6, delay: .8,
      exps: ['脸红'],
      sets: { EyeSmile: .55, ParamMouthForm: .9, ParamMouthPressLipOpen: .35, BrowInnerUp: .5, FaceAngleY: -4, FaceAngleZ: 4, LeanInput: -17 },
      keys: {
        // 他们原串 "0:0 .8:1 4.8:1 6:0" 是**增量**（叠加在 sets 的 -17 上），整段前倾，6 秒时 clear 淡出。
        LeanInput: [[0, 0], [.8, 1], [4.8, 1], [6, 0]],
        FaceAngleZ: [[0, 0], [.8, 5], [2, -2], [3.6, 3], [6, 0]],
        FaceAngleX: [[0, 0], [.7, -3], [2.2, 2], [3.8, -2], [6, 0]],
        EyeOpen: [[0, 0], [.2, -1], [.28, -.2], [.45, 0], [.95, -1], [1.03, -.2], [1.2, 0], [6, 0]],
        ViewSquash: [[0, 0], [.6, .02], [5.2, .02], [6, 0]],
      },
      hand: true,
    },
  };
  /** 关键帧插值：[[秒,值],…] → 当前值（线性）。 */
  const moodAt = (fps, t) => {
    if (t <= fps[0][0]) return fps[0][1];
    for (let i = 1; i < fps.length; i++) {
      if (t <= fps[i][0]) {
        const [t0, v0] = fps[i - 1], [t1, v1] = fps[i];
        return t1 === t0 ? v1 : v0 + (v1 - v0) * (t - t0) / (t1 - t0);
      }
    }
    return fps[fps.length - 1][1];
  };
  /** 他们的参数名 → 我们模型的角色参数。ViewSquash 这类没有的返回 null 跳过。 */
  /** 他们的参数名 → 我们模型里的名字。
   *  2026-11-22：mood 的 sets 之前直接 sp(k, v)，而 k 是他们的名字 —— 我们模型里
   *  FaceAngleX/Y/Z 根本不存在（叫 AngleX/Y/Z），ParamMouthPressLipOpen 也不存在（叫 MouthPressLipOpen）。
   *  结果「摸后失落」的低头 FaceAngleY=-5、歪头 FaceAngleZ=4、抿嘴 .3 **全部静默丢失**，
   *  用户看到的就只剩一个脸红（「松手第一档只有脸红，为什么没有低头看我」）。
   *  统一走这一张表，sets / keys 都过它。 */
  const PARAM_ALIAS = {
    FaceAngleX: 'AngleX', FaceAngleY: 'AngleY', FaceAngleZ: 'AngleZ',
    ParamMouthPressLipOpen: 'MouthPressLipOpen',
    MouthPressLipOpen: 'MouthPressLipOpen',
    EyeSmile: 'EyeSmile', ParamMouthForm: 'ParamMouthForm',
  };
  const resolveId = (k) => PARAM_ALIAS[k] ?? k;
  /** 他们 Mood 里的 set/anim 值是 VTube Studio 的**输入**（大肥鱼.vtube.json），
   *  renderer/main.cpp:596 再按 ParameterSettings 映射成模型参数。我们直接写模型参数，
   *  所以这几条必须手动过一遍同样的映射，否则幅度/正负都不对：
   *    FaceAngleY         −20..20 → −30..30  （×1.5：他们的「低头 −5」实际是 −7.5）
   *    BrowInnerUp        0..0.5  → 0..1      （×2：.7 已经是满的，写成 1.4 由模型钳到 1）
   *    MouthPressLipOpen  1..−1   → −1..1     （**取反**：他们的 .3 是模型 −0.3）
   *    MouthX             −0.8..0.8 → −1..1   （×1.25） */
  // 键用**模型参数名**（resolveId 之后）：FaceAngleY→AngleY、ParamMouthPressLipOpen→MouthPressLipOpen
  const VTS_IN = {
    AngleY: (v) => v * 1.5,
    BrowInnerUp: (v) => v * 2,
    MouthPressLipOpen: (v) => -v,
    MouthX: (v) => v / 0.8,
  };
  const vtsOut = (k, v) => (VTS_IN[k] ? VTS_IN[k](v) : v);
  const MOOD_ARGS = { FaceAngleX: 'AngleX', FaceAngleY: 'AngleY', FaceAngleZ: 'AngleZ', LeanInput: 'LeanInput' };
  /** 模型没有、但 figure 会转给 kit 的整图参数（ViewSquash 压扁 / ViewRoll 滚转 / ViewX、Y 位移） */
  const VIRTUAL_KEYS = new Set(['ViewSquash', 'ViewRoll', 'ViewX', 'ViewY']);
  /** 他们的 springK/springC：摸 150/14、松手 200/28（临界阻尼快速回正）、融化 90/9、平时 130/13 */
  function ruaKc() {
    if (clipActive('melt')) return [90, 9];
    if (ruaOnNow) return [150, 14];
    // 他们 StepStroke 里 amp 归 0 但 springK/springC 还是「摸」的 150/14
    // → 手离开头盒子那一下是**带惯性**地弹回去的。ruaW 淡出期沿用这一档。
    if (ruaW > 0.02) return [150, 14];
    if (clockT - ruaLastEnd < 1.6) return [200, 28];
    return [130, 13];
  }
  let ruaOnNow = false;
  // vtube 映射的平滑状态（main.cpp:606 `lag = smoothing*0.005`）：
  // 大肥鱼.vtube.json 里 FaceAngleX→15、Y→4、Z→30，对应 lag 0.075 / 0.02 / 0.15 秒。
  const mapS = { X: 0, Y: 0, Z: 0, started: false };
  // 拖拽惯性（PetWindow.cs:872 每帧窗口位移×30 → main.cpp:615 缓动 8 / 衰减 6 → 加到 Position）
  const swayS = { x: 0, y: 0, tx: 0, ty: 0 };
  // 嘴的缓动（main.cpp:623 张快 30 / 闭慢 16）
  let mouthS = 0;
  // 2026-11-21 照搬他们 Spring（springK=130/springC=13）：所有头角度都过弹簧，有惯性/过冲才自然。
  // 原来是 kit 的 look lerp（一阶、无过冲）→ 直接写值 → 机械感。
  const angleS = { x: 0, xv: 0, y: 0, yv: 0, z: 0, zv: 0 };
  // 2026-11-21 眼跳 saccade（照搬 DeepFish）：眼睛先走神——每 1.2~4 秒随机看别处（±0.24，速度 25 很快），头慢慢跟
  const sac = { x: 0, y: 0, tx: 0, ty: 0, wait: 0 };
  const ruaSpring = (v, vel, tgt, k, c, d) => { const nv = vel + ((tgt - v) * k - vel * c) * d; return [v + nv * d, nv]; };
  // 注意力衰减：光标停住一阵、或者盯着看了一段时间，就慢慢收回中位（不是硬切回）。
  let gazeK = 1;          // 头/身体共用的视线系数（他们 PositionX = FaceAngleX，1:1）
  let gazeKEye = 1;       // 眼睛的视线系数（他们眼睛有独立目标：回正时眼睛先走）
  let gazeKHead = 1;      // 同 gazeK（保留变量名给旧代码）
  let gazeHeadAt = 0;     // 头开始回正的时刻（他们 HeadReturnDelay = 0.5 秒）
  const gazeCfg = profile.gazeFollow ?? null;
  let gazePrev = [0, 0], gazeMoveAt = 0, gazeAwayAt = 0, gazeInited = false;
  let gazeSway = 0;   // 走神程度 0~1，用来给头部叠一点自然游移（不然头会钉在正前方）
  let gazeWantSince = 0;   // 走神条件满足的时刻，用来做"延迟发作"
  let gazeSleepAt = 0;     // 这次走神的结束时刻（走神有保质期，到点自己回神）
  let gazePtr = null;      // 上一帧的真实指针坐标（不在窗口内是 null）
  function updateGazeInterest(look, ptr, now, dt, idleLike = true) {
    if (!gazeCfg) return 1;
    // 判断「人有没有动鼠标」必须用**真实指针坐标**，不能用 look。
    // 鼠标不在窗口内时 kit 的 look 是每 1.2~3 秒刷新的随机 glance（随机瞟一眼），
    // 拿 look 的变化判移动，等于每次瞥视都被当成「有人动我」——
    // 表现就是一走神就被打回来（阈值小），或者干脆走不了神（阈值大）。
    let moving = false;
    if (ptr) {
      const pd = gazePtr ? Math.hypot(ptr[0] - gazePtr[0], ptr[1] - gazePtr[1]) : 0;
      moving = pd > (gazeCfg.movePx ?? 3);   // movePx 现在是像素
    }
    gazePtr = ptr;
    // 动作期间（走路 / 跑步 / 坐着 / 被拖着走）：头用满跟随交给原本逻辑，
    // 但**不改走神状态** —— 不然她随机走两步、换个姿势，刚攒起来的走神就白攒了。
    if (!idleLike) {
      // 动作期间人动了鼠标：三个系数一起重置，否则走完路回来 head/eye 还是旧的
      if (moving) { gazeMoveAt = now; gazeWantSince = 0; gazeK = gazeKEye = gazeKHead = 1; }
      return 1;
    }
    const away = !!ptr;   // 指针在窗口内才算"她在看着你"
    if (!gazeInited) { gazeInited = true; gazeMoveAt = gazeAwayAt = now; }
    gazePrev = [look[0], look[1]];
    if (moving) {
      // 光标一挪动就抢回来：几十毫秒（resume=40 → 约 33ms）回到满值，不等指数慢慢爬
      gazeMoveAt = now;
      gazeWantSince = 0;
      const rz = dt * (gazeCfg.resume ?? 40);
      gazeK = Math.min(1, gazeK + rz);
      gazeKEye = gazeK;
      gazeKHead = gazeK;
      globalThis.__gaze = { k: +gazeK.toFixed(3), eye: +gazeKEye.toFixed(3), head: +gazeKHead.toFixed(3), idle: +(now - gazeMoveAt).toFixed(1), held: +(now - gazeAwayAt).toFixed(1), moving, over: false, want: 1, look };
      return gazeK;
    }
    if (!away) gazeAwayAt = now;   // 光标回到中间，重新计时
    const idleFor = now - gazeMoveAt;   // 光标没动多久
    const heldFor = now - gazeAwayAt;   // 已经盯着看了多久
    const over = idleFor > (gazeCfg.idleSec ?? 3.6) || heldFor > (gazeCfg.holdSec ?? 8);
    // 走神要"延迟发作"：条件满足后再等 onset 秒才真的开始收，
    // 不然光标刚停下两秒人就飘走，看着像没注意你。
    if (!over) gazeWantSince = 0;
    else if (!gazeWantSince) gazeWantSince = now;
    const want = over && now - gazeWantSince >= (gazeCfg.onset ?? 1.5) ? 0 : 1;
    // 走神默认**不过期**：只靠鼠标唤回。想加保质期就给 span 一个正数（秒），
    // 到点后把"光标停住"的计时重置，否则下一秒又满足条件、立刻又飘走，变成一直发呆。
    if (want === 1) gazeSleepAt = 0;
    else if (!gazeSleepAt && (gazeCfg.span ?? 0) > 0) gazeSleepAt = now + (gazeCfg.span ?? 0) + Math.random() * (gazeCfg.spanJitter ?? 0);
    if (gazeSleepAt && now > gazeSleepAt) {
      gazeSleepAt = 0;
      gazeWantSince = 0;
      gazeMoveAt = now;   // 自然回神后重新攒，别立刻又走神
      const wz = Math.min(1, dt * (gazeCfg.wake ?? 1.2));
      gazeK += (1 - gazeK) * wz;
      gazeKEye += (1 - gazeKEye) * wz;
      gazeKHead += (1 - gazeKHead) * wz;
      return gazeK;
    }
    // 诊断用：把走神的内部状态摊开，harness 的 ?diag 能直接读
    globalThis.__gaze = { k: +gazeK.toFixed(3), idle: +idleFor.toFixed(1), held: +heldFor.toFixed(1), moving, over, want, look: [+(look[0]).toFixed(2), +(look[1]).toFixed(2)] };
    // 收的时候用指数趋近：开头快、越接近中间越慢，落地不硬
    // 走神时分层：眼睛先飘走，头跟上，身体最后（回神时三个都一样快，不能拖）
    // 2026-11-21 照 PetWindow.cs:912-930 的两阶段回正（不再手调系数）：
    //   阶段1 眼睛先回正（EyeReturnRate 5），头目标不变；
    //   0.5 秒后头才开始回正（HeadReturnRate 1.6，很慢）。
    //   回到跟随（want=1）时两者一起快回（他们 lookrate 10 10）。
    const eyeReturn = gazeCfg.eyeReturn ?? 5;      // EyeReturnRate
    const headReturn = gazeCfg.headReturn ?? 1.6;  // HeadReturnRate
    const headDelay = gazeCfg.headDelay ?? 0.5;    // HeadReturnDelay
    if (want === 0) {
      gazeKEye += (0 - gazeKEye) * Math.min(1, dt * eyeReturn);
      if (!gazeHeadAt) gazeHeadAt = now + headDelay;
      if (now >= gazeHeadAt) gazeK += (0 - gazeK) * Math.min(1, dt * headReturn);
    } else {
      gazeKEye += (1 - gazeKEye) * Math.min(1, dt * 40);
      gazeK += (1 - gazeK) * Math.min(1, dt * 40);
      gazeHeadAt = 0;
    }
    gazeKHead = gazeK;
    return gazeK;
  }

  /** 动作涉及的所有参数 id（静态 params + 波形 waves），用于结束时归零。 */
  function actParamIds(act) {
    const ids = [];
    for (const p of act.params ?? []) ids.push(p.id);
    for (const w of act.waves ?? []) ids.push(w.id);
    return ids;
  }

  // ---------- 待机物理微驱 ----------
  // 头发/裙摆/胸/尾巴全靠 physics3 算，而物理的输入（HipAngleX、ParamBodyAngleX、
  // ParamBreath、PositionY）在桌宠里恒为常量 —— 没有面捕就没有输入，物理等于静止。
  // 给这几个输入叠一层很慢的正弦，物理会把它放大成持续的微摆。
  const idlePhys = profile.idlePhysics ?? {};
  let clockT = 0;   // 累计时间（秒）：draw 里的 t 不是累计值，不能拿来走正弦
  const idlePhysIdx = new Map();
  for (const name of Object.keys(idlePhys)) {
    for (let i = 0; i < model._model.getParameterCount(); i++) {
      if (model._model.getParameterId(i).getString() === name) { idlePhysIdx.set(name, i); break; }
    }
  }

  // ---------- 物理摆幅补强 ----------
  // 裙摆/胸这几条物理链很"硬"：输入拉满也只输出 3~4%（参数范围 ±1），
  // 桌宠尺寸下完全看不出来。物理算完再叠一层同频正弦，把幅度提到可见区间。
  // 写在 physics 之后、update 之前，是当帧最终值；基准在 physics 之前已存，
  // 所以不会被下一帧 loadParameters 累积。
  const physWaves = profile.physicsWaves ?? [];
  const physWaveIdx = [];
  for (const w of physWaves) {
    let k = 0;
    for (let i = 0; i < model._model.getParameterCount(); i++) {
      const id = model._model.getParameterId(i).getString();
      if (!id.startsWith(w.prefix)) continue;
      physWaveIdx.push({
        idx: i, amp: w.amp, hz: w.hz,
        // 同组内按顺序加相位差，摆动从根部往梢部传递，不会整块一起晃
        phase: (w.phase ?? 0) + k++ * (w.spread ?? 0.06),
      });
    }
  }

  /**
   * 动作里声明为 postWaves 的参数必须写在 physics.evaluate() **之后**。
   * ParamBodyAngleZ / HipAngleZ 这类是物理的输出：写在物理前面会被当场算回旧值，
   * 表现就是「动作没反应」。写在物理后面则是当帧最终值，物理也没机会再改。
   */
  function applyActPostWaves(t) {
    if (!activePost) return;
    const act = paramActs[activeAct];
    const k = act?._k ?? 0;
    const dur = act?.dur ?? 2.4;
    const env = k < 0.12 ? k / 0.12 : k > 0.88 ? (1 - k) / 0.12 : 1;
    const tt = k * dur;
    for (const w of activePost) {
      const i = paramIndex.get(w.id);
      if (i === undefined) continue;
      const v = (w.base ?? 0) + Math.sin((tt * (w.freq ?? 1) + (w.phase ?? 0)) * Math.PI * 2) * w.amp * env;
      model._model.setParameterValueByIndex(i, v);
    }
  }

  function applyPhysicsWaves(t) {
    return;
    for (const p of physWaveIdx) {
      const cur = model._model.getParameterValueByIndex(p.idx);
      model._model.setParameterValueByIndex(p.idx, cur + Math.sin((t * p.hz + p.phase) * Math.PI * 2) * p.amp);
    }
  }

  // ---------- 身体跟随（指针左右/上下 → 躯干跟着倾）----------
  // ParamBodyAngleX / ParamBodyAngleZ 是 physics3 的输出参数
  // （PhysicsSetting4 ← PositionX，PhysicsSetting9 ← PositionZ），
  // 写在 physics.evaluate 之前一定会被算回去 —— 之前实测"写进去读回 0"就是这个原因。
  // 所以这一步必须压在物理之后。开关和幅度在 profile.bodyFollow。
  //
  // 关键：不能硬贴。头是 kit 用弹簧+阻尼平滑过的（tk=160 / tc=12），
  // 身体要是直接 = 目标值，就会"上半身整块跟着头平移"，看着很僵。
  // 这里给身体和胯各挂一套弹簧，并且比头慢：头先转 → 肩跟上 → 胯最后摆。
  const bodyFollow = profile.bodyFollow ?? null;
  const bfState = { left: 0, leftV: 0, up: 0, upV: 0 };
  /** 把指针跟随量写进**物理的输入**（PositionX / PositionZ），不碰物理输出。
   *  之前直接写 ParamBodyAngleZ / HipAngleZ，那两条是 PhysicsSetting4/9 的输出，
   *  物理每帧算出来的走路摆胯全被盖掉 —— 表现就是"走路腿不动、跟随也腿不动"。
   *  写 PositionX/Z 则是往链头上叠，物理会照常推出身体倾斜 + 胯摆，
   *  静止和走路走同一条链，不会互相打架。 */
  function applyBodyFollow(dt, mode, facing) {
    return;   // 2026-11-21 用户定：古早债务，不再用。鼠标跟随全部由 figure 的 angleX/Y/Z + PositionX/Y/Z 负责
    if (!bodyFollow) return;
    const lx = bodyLook[0] ?? 0;
    const ly = bodyLook[1] ?? 0;
    // 用和头部同一套归一化（头是 look*0.73 进 -1..1），这样"头转到极限"时身体也到极限。
    const nx = clamp(lx / 5 * 0.73, -1, 1);   // 2026-11-21 单位修正：look 是度数 ±5，不是 -1~1
    const ny = clamp(ly / 4 * 0.6, -1, 1);
    dt = Math.min(dt, 1 / 30);   // 掉帧时别让弹簧炸
    // 弹簧-阻尼：起步慢、中途加速、到位有一点回弹，比线性跟手更像"反应"
    const ease = (v, vel, target, k, c) => {
      const nv = vel + ((target - v) * k - vel * c) * dt;
      return [v + nv * dt, nv];
    };
    // 走路/跑步：把跟随目标平滑收回 0，身体交给物理（walk 的姿态由 kit 的位移驱动）。
    const walking = mode === 'walk' || mode === 'run';
    const gain = 1;   // 2026-11-21：走路也跟鼠标（之前 gain=0 胯不动）
    const tx = nx * (bodyFollow.x ?? 16) * gain;
    const tz = ny * (bodyFollow.z ?? 11) * gain;
    [bfState.left, bfState.leftV] = ease(bfState.left, bfState.leftV, tx, bodyFollow.k ?? 42, bodyFollow.c ?? 9.5);
    [bfState.up, bfState.upV] = ease(bfState.up, bfState.upV, tz, bodyFollow.k ?? 42, bodyFollow.c ?? 9.5);
    const addP = (name, dv) => {
      const i = paramIndex.get(name);
      if (i === undefined) return;
      model._model.setParameterValueByIndex(i, model._model.getParameterValueByIndex(i) + dv);
    };
    addP('PositionX', bfState.left);   // 左右重心 → 物理推 ParamBodyAngleX + HipAngleX
    addP('PositionZ', bfState.up);     // 前后 → ParamBodyAngleZ
  }

  // ---------- 待机小动作（3.9 统一闲时调度）----------
  // 触发归 kit 的 decide()（idle-word 选项 → doWord 正常入口，音效/爱心/挤压白拿），
  // 后端只管两件事：① 闲时词的通道收尾（走跑跳开始按 src 撤）；② idlePool() 把池子交给 kit。
  // 旧的 idlePoses/idleMoods 两套后端计时器已退役（3.8/3.7 时代），applyActAt 那套
  // 直写包络保留——旧路径手势（frame.gesture 非 channel 词）还在用它。
  let idlePoseWord = null;   // 仅剩 clearIdlePose/actWord 手部分支引用，恒为 null（旧机制残留）
  // 闲时词收尾登记：actWord 的 o.idle 进来时记下是谁、放到什么时候
  let idleChannelWord = null;
  let idleChannelUntil = 0;
  const idleModeOk = (mode) => mode === 'idle' || mode === 'look' || mode === 'sit';

  function setMovement(n) {
    for (const k of [1, 2, 3]) {
      const i = paramIndex.get('Movement' + k);
      if (i !== undefined) model._model.setParameterValueByIndex(i, k === n ? 1 : 0);
    }
  }

  /** 结束待机手势：部件开关和手臂参数必须一起归零。
   *  之前只 setMovement(0)，Param41/59/60 这些还停在原值，
   *  手就会一直举着，直到下一次手势把它覆盖掉。 */
  function clearIdlePose() {
    const word = idlePoseWord;
    idlePoseWord = null;
    setMovement(0);
    const act = word ? paramActs[word] : null;
    // 用 actParamIds（含 waves）而不是只看 params：甩草这类波形动作收尾时
    // 手臂角度参数也要一起归零，否则手会停在半空
    for (const id of actParamIds(act)) {
      const i = paramIndex.get(id);
      if (i !== undefined) model._model.setParameterValueByIndex(i, 0);
    }
  }

  /** 动作的「进 → 停 → 退」包络（0~1）。
   *  过渡按时长的 20%（最短 0.32 秒、最长 1.1 秒）—— 4 秒的动作 = 0.8 秒抬起、
   *  2.4 秒保持、0.8 秒放下。之前写死 0.22 秒，动作像"一下子做完然后干等着"。
   *  主动触发（applyParamActs）和待机随机换手（applyIdlePose）共用这一份，
   *  否则两边各写一套，改一处忘另一处，手感就会莫名其妙对不上。 */
  const actWeight = (t, dur) => {
    const pad = Math.min(1.1, Math.max(0.32, dur * 0.2));
    const ease = (x) => x * x * (3 - 2 * x);
    return t < pad ? ease(t / pad) : t > dur - pad ? ease(Math.max(0, (dur - t) / pad)) : 1;
  };

  /** 按权重把一套动作的静态参数写到模型上（waves / postWaves 由调用方另外叠）。 */
  const writeActParams = (act, w) => {
    for (const p of act?.params ?? []) {
      const i = paramIndex.get(p.id);
      if (i !== undefined) setParamByName(p.id, p.to * w);   // 派生 Position（他们 vtube 1:1）：动作带动身体
    }
  };

  /** 把一套动作在「动作开始后 t 秒」的状态写到模型上。
   *  静态参数按包络淡入淡出；有 waves 的再叠正弦（静态部分写满值 ——
   *  换手开关跟着淡入淡出会在半开状态停留，手型会变成两套叠着）。
   *  主动触发和待机随机换手共用这一份，所以甩草在待机里也会真的甩。 */
  function applyActAt(act, t) {
    const dur = act.dur ?? 4;
    // 2026-11-21：退出动画（配置在 profile.js 的 act.exit，1.25 秒关键帧）。
    // 之前代码读 act.exitClip（不存在）→ 退出永不播 → 秒切回。现在按 sampleKeys 插值写参数。
    if (act.exit && act._exitT !== undefined) {
      const et = t - act._exitT;
      const edur = act.exit.dur ?? 1.25;
      if (et <= edur) {
        const byId = new Map();
        for (const f of act.exit.keys ?? []) {
          if (!byId.has(f.id)) byId.set(f.id, []);
          byId.get(f.id).push([f.t ?? 0, f.v ?? 0]);
        }
        for (const [id, frames] of byId) {
          frames.sort((a, b) => a[0] - b[0]);
          const i = paramIndex.get(id);
          if (i !== undefined) setParamByName(id, sampleKeys(frames, et));
        }
        return;
      }
    }
    const env = actWeight(t, dur);
    if (act.waves?.length) {
      writeActParams(act, 1);
      for (const w of act.waves) {
        const v = Math.sin((t * w.freq + (w.phase ?? 0)) * Math.PI * 2) * w.amp * env;
        const i = paramIndex.get(w.id);
        if (i !== undefined) setParamByName(w.id, (w.base ?? 0) + v);
      }
    } else {
      writeActParams(act, env);
    }
  }

  /** 闲时词收尾（每帧）：走跑跳开始（或兜底超时）把闲时词写的通道条目按 src 撤掉。
   *  触发在 kit 的 decide()，标记由 actWord 的第三参 o.idle 登记。 */
  function stepIdleWords(t, mode) {
    if (idleChannelWord && (!idleModeOk(mode) || t > idleChannelUntil)) {
      const w = idleChannelWord;
      idleChannelWord = null;
      dropSrc(w);
    }
  }

  function applyIdlePhysics(t) {
    return;
    for (const [name, i] of idlePhysIdx) {
      const c = idlePhys[name];
      const v = (c.base ?? 0) + Math.sin((t * c.hz + (c.phase ?? 0)) * Math.PI * 2) * c.amp;
      model._model.setParameterValueByIndex(i, v);
    }
  }

  // ---------- 通道叠加（P1 试点）----------
  // kit 的动作是"单槽 pulse"，一次只能一个；这里让形象自己接管动作词，
  // 每个词把自己的参数写进通道（不同 id 共存、同 id 覆盖），就能同时生效。
  //
  // 试点阶段只放白名单（profile.channelWords）里的词走这条新路，其余词继续交给 kit 的 pulse。
  // 出问题把 profile.useChannels 改成 false，整条新路关掉，回到旧行为。
  const useChannels = profile.useChannels === true;
  // 通道词表【自动派生】（2026-11-20）：paramActs 的键就是通道词的精确定义——
  // 手工白名单已经三次静默咬人（新词忘同步 → actWord 第一道守卫拒之门外 →
  // 有回执没动作）。并与旧名单取并集：kit 原生词（wave/bow 等历史残留）无害，
  // actWord 后续的 paramActs 检查会把它们正常交还 kit。
  const channelWords = new Set([...Object.keys(paramActs), ...(profile.channelWords ?? [])]);
  // 手部动作互斥：三只手共用 Movement1/2/3 这几个开关和一部分手臂参数。
  // 同时抬两只手不是"多一只手"，是网格打架 —— 所以新的手部词进来时，
  // 先把上一只手在通道里写的参数全部撤掉。
  const handParamIds = new Set(['Movement1', 'Movement2', 'Movement3']);
  for (const [k, v] of Object.entries(paramActs)) {
    if (!v?.hand) continue;
    // 2026-11-22：原来只收 params/waves，**没收 keys** —— 手型动画的关键帧参数（Param59~62 等）
    // 换手时清不掉，旧手型残留值会和新手型打架（用户：「带手部动作的动画都不完整」）。
    for (const p of [...(v.params ?? []), ...(v.waves ?? []), ...(v.postWaves ?? []), ...(v.keys ?? []), ...(v.exit?.keys ?? [])]) handParamIds.add(p.id);
  }

  // ---------- 修饰词（微/大/快/慢/×几）与中文别名 ----------
  // kit 的词表只认 id，AI 却习惯写中文 + 修饰。baseWord 先把词还原成基础 id 交给 kit
  // （音效、配表情、busy 生命周期都照走 act()），同时把"轻重、快慢、几下"记在 pendingMod，
  // 等 actWord 用它缩放关键帧 / 波形。
  let pendingMod = null;
  let pendingLife = null;   // 闲时心情/闲时动作给的保持秒数（actWord 读一次就清，null=按默认 IDLE_LIFE）
  let lastEngine = null;          // 上一帧的表情数值，用来让动作幅度跟着情绪走
  const wordAlias = profile.wordAlias ?? {};
  const MOD_SCALE = { '微': 0.5, '大': 1.5 };
  const MOD_PACE = { '快': 0.65, '慢': 1.6 };

  /**
   * 没写「微 / 大」时，幅度跟着当前情绪走：笑 / 张嘴 / 嘴角上扬 → 放开，
   * 八字眉 / 脸红 / 瘪嘴 → 收着。人做动作本来也不会先算百分比，是被情绪带出来的。
   */
  function moodScale() {
    const e = lastEngine;
    if (!e) return 1;
    const up = Math.max(0, e.eyeSmile ?? 0) * 0.5
      + Math.max(0, e.mouthOpen ?? 0) * 0.3
      + Math.max(0, e.mouthForm ?? 0) * 0.3;
    const down = Math.max(0, -(e.mouthForm ?? 0)) * 0.5
      + Math.max(0, e.cheek ?? 0) * 0.3
      + Math.max(0, e.browAngle ?? 0) * 0.3;
    return clamp(1 + up * 0.5 - down * 0.4, 0.6, 1.4);
  }

  /** 撤掉所有通道（动作 + 表情层），回到干净的脸和姿势。
   *  2026-11-22：从 baseWord 的「恢复」分支抽出来 —— 剧本 step 里也能写「恢复」了。 */
  /** @param onlyHand 只收手（他们 Body.cs:420 的 PutHandDown）：不动表情和姿势。 */
  function relaxChannels(onlyHand) {
    // 2026-11-21：有 exit 的手势（竖手指/狗尾草/抚胸）不秒切——把通道条目换成播 exit.keys（1.25 秒收手），
    // 播完自己走。没 exit 的照旧写 0 清掉。
    const isHand = (c) => !!(c.src && paramActs[c.src]?.hand);
    const toDelete = [];
    for (const [id, c] of [...channel]) {
      if (onlyHand && !isHand(c)) continue;
      const def = c.src ? paramActs[c.src] : null;
      const frames = (def?.exit?.keys ?? def?.exitKeys)?.filter((k) => k.id === id).map((k) => [k.t ?? 0, k.v ?? 0]);
      if (frames?.length) {
        // 转成一条轨道播收手动画（轨道是相加语义，留在 channel 里会被当成 hold 写，必须挪过去）
        channel.delete(id);
        tracks.push({ id, kind: 'keys', frames, t0: clockT, dur: def.exit?.dur ?? def.exitDur ?? 1.25, post: false, src: c.src, bornS: sentenceCount, bornT: clockT });
        continue;
      }
      if (c.kind !== 'static' && c.to === undefined) { toDelete.push(id); continue; }
      if (c.to !== 0) { const i = paramIndex.get(id); if (i !== undefined) model._model.setParameterValueByIndex(i, 0); }
      toDelete.push(id);
    }
    for (const id of toDelete) dropParam(id);
    // 动作轨道：有 exit 的就地换成收手关键帧，没 exit 的直接撤
    for (let n = tracks.length - 1; n >= 0; n--) {
      const c = tracks[n];
      if (onlyHand && !isHand(c)) continue;
      const def = c.src ? paramActs[c.src] : null;
      const frames = (def?.exit?.keys ?? def?.exitKeys)?.filter((k) => k.id === c.id).map((k) => [k.t ?? 0, k.v ?? 0]);
      if (frames?.length) {
        c.kind = 'keys'; c.frames = frames; c.t0 = clockT; c.dur = def.exit?.dur ?? def.exitDur ?? 1.25; c.eyeLid = isLidParam(c.id);
      } else {
        tracks.splice(n, 1);
      }
    }
  }

  /**
   * kit 在 doWord 最前面调这个：返回基础 id 就继续走 act()，返回 null 表示没我什么事。
   * 认三种写法：`nod`、`点头`、`微点头×2`、`快摇头`。
   */
  function baseWord(w) {
    if (typeof w !== 'string') return null;
    let s = w.trim();
    if (!s) return null;
    // 3.6 :方向修饰——剥后缀记方向（右=-1 镜像），actWord 对方向参数取反
    dirSide = 1;
    const sideM = s.match(/[:：](左|右)$/);
    if (sideM) { s = s.slice(0, -sideM[0].length); if (sideM[1] === '右') dirSide = -1; }
    // 「恢复」/ neutral：撤掉所有通道（动作 + 表情层），回到干净的脸和姿势。
    // 关键：Live2D 参数保持最后写入值——只删条目不够（CheeckPuff/Movement 等残留 1），
    // 必须把被清条目的静态参数显式写回 0（角色参数如 eyeOpen 有 roles 每帧重写，不用管）。
    if (s === '恢复' || s === 'restore' || s === 'neutral') { relaxChannels(); return null; }
    let scale = 1, pace = 1, repeat = 1, touched = false;
    // 前缀修饰，最多两层（「微快点头」这种也认）
    for (let n = 0; n < 2; n++) {
      const c = s[0];
      if (MOD_SCALE[c] !== undefined) { scale *= MOD_SCALE[c]; s = s.slice(1); touched = true; }
      else if (MOD_PACE[c] !== undefined) { pace *= MOD_PACE[c]; s = s.slice(1); touched = true; }
      else break;
    }
    // 后缀次数：×3 / x3 / *3
    const m = /[×x*](\d+)$/.exec(s);
    if (m) {
      repeat = Math.max(1, Math.min(6, Number(m[1]) || 1));
      s = s.slice(0, m.index);
      touched = true;
    }
    const id = wordAlias[s] ?? (paramActs[s] ? s : null);
    if (!id) return null;                 // 拼错了就当没这个词，kit 自己会丢
    if (!touched) {
      pendingMod = null;                  // 没有修饰：清掉上一次的残留
      return id === w ? null : id;        // 本来就是 id，不用麻烦 kit
    }
    pendingMod = { scale, pace, repeat, explicit: true };
    return id;
  }

  /** 眼睑参数（左右眼开度）：通道里当乘数、轨道里当增量。
   *  2026-11-22：原来只定义在 actWord 内部，baseWord 的「恢复」分支引用它会 ReferenceError
   *  （有 exit 的轨道碰上「恢复」就炸），提到闭包顶层。 */
  const isLidParam = (id) => id === 'ParamEyeLOpen' || id === 'ParamEyeROpen';
  /** paramId -> { from, to, t0, dur, in, out }：每个通道自己管生命周期，到期自动退出 */
  const channel = new Map();
  /** 轨道（2026-11-21 照搬 main.cpp:563-593 的 tracks）：动作型条目（keys / 波形），
   *  数组存、**多条并存、同参数相加** —— 点头叠在低头/歪头上会转得更远，而不是互相吃掉。
   *  和 channel 的分工：channel 是"换表情"语义（同一参数后写覆盖），tracks 是"动作叠加"语义。
   *  每条带 id（参数名）。 */
  const tracks = [];
  // 眼睛开度的"乘数"（2026-11-21 照搬 main.cpp 的 Lids）：通道里眼睑参数不直写，
  // 而是像他们 hold 那样存成"相对 1 的乘数"，由 Lids 段乘在 eyeBlink 之后。
  // 每帧前批重建（writeChannel 开头清零），物理之前被用掉。
  const lidMul = { L: 1, R: 1 };
  // 眼睛关键帧的**增量**（他们 track 走 `lid(id, 1 + value)`，所以值为 -1 就是闭上）。
  // 多条轨道同参数相加（sigh 的微闭 + 单眨眼），最后 1+Σ 变成乘数。
  const lidAdd = { L: 0, R: 0 };
  // applyFrame 算出的「不含表情配方 eyeOpen」的开度系数（shape/困意/睡姿），给 Lids 段乘
  let lastOpenNoBase = 1;
  // 通道缓动的时间常数（他们 main.cpp:550 的 1-exp(-dt/0.15f)，全通道同一个值）
  const LID_TAU = 0.15;
  let frameDt = 1 / 60;

  // ---------- 叠加层（2.8 通道相加）：外力源（rua/触摸）写这里，在主通道结果之上相加 ----------
  // 主通道词与词之间保持「后写覆盖」（苦笑+微笑的语义不变）；叠加层是相对主通道的
  // **增量**（to 即增量值，如 +14 = 在当前头角度上再加 14）——rua 头反向 + 歪头词 = 歪得更远。
  // key: `${src}:${pid}`——同 src 同参数重写覆盖，不同 src 相加。外力源负责 overlayClear。
  const overlay = new Map();
  // 通道审计（2026-11-20 常驻）：每次 delete/clear 记一行（时间 + 参数 + 调用点），
  // 凑 6 条经 /api/figure-log（image beacon，CSP img-src self 放行）进 core.log——
  // 表情「莫名消失」类 bug 的一秒定位器。
  const auditQ = [];
  const auditFlush = () => {
    if (!auditQ.length) return;
    try { new Image().src = '/api/figure-log?m=' + encodeURIComponent(auditQ.join(' | ')); } catch { /* 诊断不致命 */ }
    auditQ.length = 0;
  };
  const audit = (line) => {
    auditQ.push(clockT.toFixed(1) + ' ' + line);
    if (auditQ.length >= 6) auditFlush();
  };
  const _chDelete = channel.delete.bind(channel);
  channel.delete = (id) => { if (channel.has(id)) audit('del ' + id + ' <' + ((new Error().stack ?? '').split('\n')[2] ?? '').trim().slice(0, 60) + '>'); return _chDelete(id); };   // 只记实际生效的删除——空删（枚举未命中的参数）不刷屏
  const _chClear = channel.clear.bind(channel);
  channel.clear = () => { audit('clear ALL'); return _chClear(); };
  /** 删掉某个参数的所有来源：hold 槽 + 所有轨道。
   *  轨道数组化之后，「删参数」必须两边一起清，否则 hold 删了、动作轨道还在写（表情清不干净的经典款）。 */
  function dropParam(id) {
    channel.delete(id);
    let hit = 0;
    for (let n = tracks.length - 1; n >= 0; n--) if (tracks[n].id === id) { tracks.splice(n, 1); hit++; }
    if (hit) audit('drop track ' + id + ' ×' + hit);
  }
  function clearAllParams() { channel.clear(); tracks.length = 0; }
  /** 按来源词撤掉它写的全部东西：hold 槽 + 动作轨道。
   *  轨道数组化之后必须连轨道一起撤，否则词退了动作还在演（闲时词/手部词收尾的坑）。 */
  function dropSrc(src) {
    for (const [id, c] of [...channel]) if (c.src === src) dropParam(id);
    for (let n = tracks.length - 1; n >= 0; n--) if (tracks[n].src === src) tracks.splice(n, 1);
  }
  // 2.7 虚拟参数表：通道里 id 不在模型参数表的条目（如 ViewSquash 整图压扁）不写模型，
  // 存这里给 kit 消费（custom.squash() 读）——弹簧/锚点/阴影全白拿 kit 的 sq 系统。
  let dirSide = 1;   // 3.6 :方向修饰（1=默认/左，-1=右镜像）——baseWord 设定、actWord 镜像
  const virtualParams = new Map();
  const overlaySet = (src, pid, def) => overlay.set(src + ':' + pid, { pid, t0: clockT, dur: 30, in: 0.2, ...def });
  const overlayClear = (src) => {
    if (!src) { overlay.clear(); return; }
    for (const k of [...overlay.keys()]) if (k.startsWith(src + ':')) overlay.delete(k);
  };
  let lastWordAt = -99;   // 上次有新词的时刻：自动放松的计时基准（2.6）
  const RELAX_FADE = 1.5, SENT_LIFE = 2, SPEECH_END_DELAY = 2, IDLE_LIFE = 3;
  let sentenceCount = 0, bornSentence = -1, lastSpeechEnd = -99;
  let currentTone = '';   // 2.3 tone：当前 beat 的语气（! = 感叹 / … = 省略）——pet-app 每 beat 下发   // 跟句寿命（2.6 改造）
  let bornAt = -99;   // 词出生时刻：闲置语境（随机动作）的限时基准
  let performingUntil = -99;   // 3.9c 表演期：词活跃期间视线看向屏幕（用户：做表情/动作时看着我，别追鼠标）
  let performingBlend = 0;   // 表演期视线曲线的混合系数（0=正常跟随鼠标 → 1=看向屏幕，双向缓动）

  /** 组合词表（他们 Body.cs:220 的 Combos）：组合词 id → 基础词列表。
   *  元素可以是 id 字符串，也可以是 { w, scale, pace, repeat, side } —— 把「微/大/快/慢/×n/:左」钉在某一个基础词上，
   *  和他们的解析顺序一致（先展开，再对每个 token 认修饰）。 */
  const combos = profile.combos ?? {};

  // ---------- 彩蛋小剧场（纯动作 + 假口型）----------
  // 他们的 skits.txt 是「台词 + 动作」脚本。文字气泡我们拿不到通道（kit 的 onEvent 只有
  // arrived/interrupted/touch/mode/done，pet-app 也只接这五种），所以这里只演动作和表情；
  // 剧本写 say:true 时用假口型（张嘴节奏走帧，不出声），她真说话时两路取 max 合并。
  // 触发：闲时池里的一条 { word: 'skit' }；打断：任何新词 / 开口说话 / 走路拖拽，硬切。
  const skits = profile.skits ?? [];
  let skit = null;   // { def, t, done:Set }
  let lastSkitId = null;   // 别连着抽到同一个
  /** 当前这句台词说到 skit.t 的哪个时刻（超过就闭嘴）。他们每句台词自带停留秒数。 */
  let skitSayUntil = 0;
  /** 条件剧本（时间类）：when 的 hours / weekday / date 全中才演。 */
  function skitOk(def) {
    const w = def.when;
    if (!w) return true;
    const d = new Date();
    if (w.hours && !w.hours.includes(d.getHours())) return false;
    if (w.weekday && !w.weekday.includes(d.getDay())) return false;
    if (w.date && !w.date.some(([m, day]) => d.getMonth() + 1 === m && d.getDate() === day)) return false;
    return true;
  }
  function startSkit() {
    if (!skits.length) return false;
    const ready = skits.filter(skitOk);
    const special = ready.filter((s) => s.when);
    // 条件剧本更"应景"（0~3 点催睡、周五傍晚放松）：满足时六成演它，
    // 让"今晚几点"真的有区别；其余仍走 13 个日常剧本。
    let pool = special.length && Math.random() < 0.6 ? special : ready.filter((s) => !s.when);
    if (!pool.length) pool = ready.length ? ready : skits;
    if (pool.length > 1) pool = pool.filter((s) => s.id !== lastSkitId);
    const def = pool[Math.floor(Math.random() * pool.length)];
    lastSkitId = def.id;
    skit = { def, t: 0, done: new Set() };
    skitSayUntil = 0;
    // 剧本期间把 kit 的闲时调度按住：不然她一边保持前倾一边自己溜达/跳/坐
    // （hold 是「多少秒内不自由漫游」，和 say 用的 holdRoam 同一路）
    // hold 要盖住**整段保持期 + 淡出**：条目在 life 到期后才开始 RELAX_FADE(1.5s) 淡出，
    // 只按 life 按住的话，淡出那 1.5 秒她已经能自己走了 —— 看起来就是「前倾着走路」。
    body?.set?.({ hold: (def.life ?? (def.dur ?? 6) + 4) + RELAX_FADE + 0.5 });
    audit('skit-start ' + def.id);
    return true;
  }
  function stopSkit(why) {
    if (!skit) return;
    audit('skit-stop ' + skit.def.id + ' ' + why);
    const life = skit.def.life ?? 15;
    skit = null;
    // 被打断（说话/拖动/换姿势）时，已经做出来的动作还要挂完 life 再淡出 1.5 秒 ——
    // 这期间别让她自己走起来，否则就是「保持前倾 → 边走边歪」
    body?.set?.({ hold: life + RELAX_FADE + 0.5 });
  }
  /** 每帧推进剧本：到点的 step 走 applyOneWord（和散词同一条写入路径，通道/轨道/手部全都走）。 */
  function stepSkit(dt) {
    if (!skit) return;
    skit.t += dt;
    for (let n = 0; n < skit.def.steps.length; n++) {
      const s = skit.def.steps[n];
      if (skit.t < (s.at ?? 0) || skit.done.has(n)) continue;
      skit.done.add(n);
      // 台词：他们一行是「台词|动作 动作 动作|秒数」，先发字再演动作（说着说着做）。
      // 走 custom.emitEvent → 页面临时气泡，不进 World 的 say 队列、不进聊天记录 ——
      // AI 不知道这句、也不会读回上下文。口型只在这句的时间里动（sec 的 78%，说完停一下）。
      if (s.say) {
        // 气泡停留按字数算（彩蛋气泡是一次性全显示的，不是打字机）：
        // 4 个字给 2 秒、28 个字给 5 秒，短句不闪、长句读得完。
        figure.emitBubble(s.say, clamp(1.4 + s.say.length * 0.13, 2, 5));
        skitSayUntil = skit.t + (s.sec ?? 3.4) * 0.78;
      } else {
        skitSayUntil = skit.t;   // 这句没台词（「……」「（嚼嚼嚼）」之外的纯动作行）→ 闭嘴
      }
      // 动作组：一行可以好几个词（皱眉 看左边 抿嘴），各走各的通道
      const list = Array.isArray(s.w) ? s.w : (s.w ? [s.w] : []);
      for (const item of list) {
        const part = typeof item === 'string' ? { w: item } : item;
        if (part.w === 'restore') {
          relaxChannels();   // 他们的「恢复」= 把姿势/表情清干净再演
          // 但道具（@道具 单片眼镜…）是他们单独管的：恢复不清、演完才摘 → 重戴
          for (const pr of skit.def.props ?? []) {
            pendingMod = { scale: 1, pace: 1, repeat: 1, explicit: true };
            dirSide = 1;
            applyOneWord(pr, null, {}, { group: 'skit-' + skit.def.id, life: skit.def.life, skit: true });
          }
          continue;
        }
        pendingMod = { scale: part.scale ?? 1, pace: part.pace ?? 1, repeat: part.repeat ?? 1, explicit: true };
        dirSide = part.side ?? 1;
        applyOneWord(part.w, null, {}, { group: 'skit-' + skit.def.id, life: skit.def.life, skit: true });
      }
      // 每句都刷一次「别自由漫游」：条目寿命是从**它自己出生**算的 ——
      // 最后一句（9.5s 出生 + life 18s）要到 27.5s 才淡出完，比剧本结束晚十几秒。
      // 只在开演时按一次 hold 的话，20 秒后她就会带着前倾走起来（用户实测名侦探）。
      body?.set?.({ hold: (skit.def.life ?? 15) + RELAX_FADE + 0.5 });
    }
    if (skit.t > (skit.def.dur ?? 6)) stopSkit('done');
  }
  /** rua 松手：按峰值时长给一个「摸后」反应（他们 PlayAfterStroke 的档位，台词交给她自己说）。 */
  function stepRuaState(frame) {
    // 判据用「rua 对象还在」而不是 rua.on —— on 是弹簧开关，手暂时离开头区就会 false。
    // 另加 1.2 秒保护：实测一次 12 秒的 rua 触发了 6 次（kit 的 rua 中间被清了几次），
    // 每次只剩 peak 3~5 秒，档位自然全错。
    const on = !!frame.rua;
    if (on) {
      ruaPeak = Math.max(ruaPeak, frame.rua?.seconds ?? 0);
      if (!ruaPrevOn) stopMoodClips();   // 新的一轮摸头：上一轮没演完的摸后反应直接撤
      ruaPrevOn = true;
      return;
    }
    if (!ruaPrevOn) return;
    ruaPrevOn = false;
    // 2026-11-22：原来这里有个「1.2 秒内不重复结算」的保护，结果 rua 一结束就 return，
    // 摸后 mood 永远不播、脸红也立刻断（用户：一停手脸立马变白）。删掉。
    ruaLastEnd = clockT;
    const peak = ruaPeak;
    ruaPeak = 0;
    // 他们的门槛只有「真的移动过」（strokeTravel>8 && strokeMoving>=.4），
    // 低于 3 秒就是**摸后失落**那一档 —— 之前这里 return 掉了，所以前三秒松手什么都没演。
    if (peak < 0.4) { audit('rua-after peak=' + peak.toFixed(1) + ' (按下去没动，不反应)'); return; }
    const mood = peak >= 20 ? 'melt' : peak >= 8 ? 'clingy' : peak >= 3 ? 'reluctant' : 'lost';
    // 他们松手后**不是马上**动情：EndStroke 里 afterStrokeAt = UtcNow + 1.5s，
    // 这 1.5 秒只有「头回正 + 脸红还在」，之后 PlayAfterStroke 才播 mood。
    // 之前我们 t 从 0 开始，松手瞬间就演，观感和他们对不上（用户：一松手就清零/立刻变）。
    startLayerClip(MOOD_CLIPS[mood]);
    audit('rua-after peak=' + peak.toFixed(1) + ' → ' + mood);
  }

  /** 假口型：只在这句台词的时间里动嘴（两句之间的停顿闭嘴）。两条正弦交叉，像在念但没声音。 */
  function skitTalk() {
    if (!skit || skit.t > skitSayUntil) return 0;
    const t = skit.t;
    return clamp(0.45 + 0.5 * Math.sin(t * 13.1) * Math.sin(t * 3.7 + 1.1), 0, 1);
  }

  /** kit 的 doWord 入口。组合词在这里展开成一串基础词，同一帧各走各的通道；
   *  寿命（bornS/bornT）与气泡顶替按**组合词本身**（group）记，不按展开出来的基础词 ——
   *  否则「感动」的四个零件会被当成四个独立词，各活各的、各被顶替各的。 */
  /** 摸后 mood 正在演（含松手后的空档）时，这些参数归 clip 独占 —— 见下面 actWord 的守卫 */
  const CLIP_OWNED = new Set(['AngleX', 'AngleY', 'AngleZ', 'LeanInput', 'EyeSmile', 'ParamMouthForm',
    'BrowInnerUp', 'MouthPressLipOpen', 'ParamEyeBallX', 'ParamEyeBallY', 'PositionX', 'PositionY', 'PositionZ']);
  const wordTouchesClip = (w) => {
    const def = paramActs[w];
    if (!def) return false;
    const ids = [...(def.params ?? []).map((q) => resolveId(q.id)), ...(def.keys ?? []).map((q) => resolveId(q.id))];
    return ids.some((id) => CLIP_OWNED.has(id));
  };
  function actWord(w, fromFace, o) {
    if (w === 'skit') return startSkit();
    // 摸后 mood 在演的时候，歪头/笑眼/前倾这类词一律让路：
    // 她收到「摸头」事件后会自己说一句话，那句话带的〔歪头〕会把头抢过去，
    // 看起来就是「摸后动作完全没生效，只歪了一下头」（用户 2026-11-23 实测）。
    // 他们的等价物是 Tick() 里的 `if (... || Touching || mood != null) return;`。
    if (clipAlive() && !o?.force && wordTouchesClip(w)) {
      audit('word-drop ' + w + '（摸后 mood 在演，参数归它）');
      return false;
    }
    stopSkit('word');   // 任何新词都打断彩蛋
    lastWordAt = clockT;
    // face 联动词（blush/tears/sweat/heart-eyes）的退场：下一个任何词触发就让位。
    // 「【害羞】→ 下一句【嘟嘴】，脸红影子不该跨句挂着」——情绪影子跟着最近的表达走。
    for (const [id, entry] of [...channel]) {
      if (entry.faceLinked) dropParam(id);
    }
    bornSentence = sentenceCount;   // 词出生时的句号（跟句寿命用）
    bornAt = clockT;                // 词出生的时刻（闲置语境的限时用）
    // 闲时触发（心情/随机动作）带来的保持秒数：一次取出、所有展开词共用（读一次就清）
    const life = o?.life ?? pendingLife;
    pendingLife = null;
    const parts = combos[w];
    if (parts?.length) {
      for (const part of parts) {
        if (typeof part === 'string') {
          pendingMod = null;
          dirSide = 1;
          applyOneWord(part, fromFace, o, { group: w, life });
        } else {
          pendingMod = { scale: part.scale ?? 1, pace: part.pace ?? 1, repeat: part.repeat ?? 1, explicit: true };
          dirSide = part.side ?? 1;
          applyOneWord(part.w, fromFace, o, { group: w, life });
        }
      }
      pendingMod = null;
      dirSide = 1;
      return false;   // 交还 kit：组合词本身的音效 / 粒子 / 情绪脸照发（和以前一样）
    }
    return applyOneWord(w, fromFace, o, { group: null, life });
  }

  /** 单个基础词：写通道 / 轨道 / 手部 / 叠加层。ctx.group = 属于哪个组合词（散词就是 null）。 */
  function applyOneWord(w, fromFace, o, ctx) {
    if (!useChannels || !channelWords.has(w)) { audit('reject ' + w + ' (通道守卫)'); return false; }
    const def = paramActs[w];
    if (!def) return false;
    // 「放下手」：他们 Body.cs:420 是 `PutHandDown() { if (hand is {} up) send($"motion {up.Off}") }`
    // —— 播**当前那只手**自带的收手动画。我们之前抄成固定一套 chest-hand 的 Off：
    // 竖手指时那只手没有 Movement2，于是凭空放了一次不存在的右手（用户：「做两次放手，
    // 第二次从右边突然出现」）。改成按当前手型播它自己的 exit。
    if (w === 'put-hand-down') { relaxChannels(true); audit('write ' + w + ' (当前手型 exit)'); return true; }
    const now = clockT;
    // 3.6 :右 镜像——方向参数（头部横摆/眼珠横移）值取反
    const MIRROR = new Set(['AngleX', 'AngleZ', 'ParamEyeBallX']);
    const mir = (id, v) => (dirSide === -1 && MIRROR.has(id) ? -v : v);
    // 修饰：AI 写的「微/大/快/慢/×几」；没写就按当前情绪给个默认幅度
    const mod = pendingMod ?? { scale: 1, pace: 1, repeat: 1, explicit: false };
    pendingMod = null;
    // 闲时触发（心情/随机动作）带来的保持秒数：由入口一次取出、展开词共用
    const life = ctx.life;
    // 2.3 tone（他们 Body.cs:335/360/365）：beat 末尾 ！/… 影响一次性动作的幅度与速度——
    //   ！→ 放大 1.2 倍、加速（时长 ×0.85）；… → 收着 0.85、放慢（×1.25）。
    //   只作用一次性动作（state 保持型不吃，Hold 型表情不是"演"的）；reflex 反射词豁免；
    //   AI 显式写了修饰（微/大/快/慢）时 AI 优先（他们 size == null 同款语义）。
    const toneEff = currentTone && !def.state && !def.reflex && !mod.explicit
      ? (currentTone === '!' ? { scale: 1.2, pace: 0.85 } : { scale: 0.85, pace: 1.25 })
      : null;
    // 手型词（hand）豁免 moodScale：手位是坐标不是幅度，情绪放大=把手送进身体里
    const effScale = mod.scale * (mod.explicit || def.hand ? 1 : moodScale()) * (toneEff?.scale ?? 1);
    const keySpan = def.keys?.length ? Math.max(...def.keys.map((f) => f.t ?? 0)) : 0;
    const dur = (keySpan || (def.dur ?? 2.4)) * mod.pace * mod.repeat * (toneEff?.pace ?? 1);
    // 3.9 闲时词登记：走跑跳开始（或兜底超时）由 stepIdleWords 按 src 撤掉通道条目
    if (o?.idle) {
      idleChannelWord = w;
      idleChannelUntil = Math.max(idleChannelUntil, now + dur + 0.2);
      audit('idle-word ' + w);
    }
    // 3.9c 表演期：词活跃期间视线看向屏幕。只算「演」的部分（dur），state 词的保持期
    // 不算——挂着红脸跟鼠标不冲突，全算的话表演期拖到 life 尾，脸退完了视线还压着（2026-11-20 用户反馈残留太久）
    performingUntil = Math.max(performingUntil, now + dur + 0.5);
    const inT = Math.min(0.45, dur * 0.2);
    // 2026-11-21 眼睛：照搬他们的 lid 乘数（main.cpp:559 `lid(id, 1 + (value-1)*weight)`）。
    // 关键：基准恒是 1（睁眼），不是参数默认值 —— 这个模型的 ParamEyeLOpen 默认值是 0（绑定姿势闭眼），
    // 用 defVal 当 from 会让每个眼睛词开帧就先闭死一刀（用户：「先闭眼再半睁」「先闭眼再眯眼笑」）。
    // 笑眼/下眼睑：不是乘数参数，但要和眼皮同一条指数曲线（他们 heldParameters 同款 0.15s），
    // 否则「眼皮闭下去 0.45s 指数、下眼睑线性爬上来」两条曲线不同步，肉的。
    const isSmileParam = (id) => id === 'EyeSmile';
    // 2026-11-21：有 exit（竖手指/狗尾草/抚胸）的动作用 1.25 秒收手淡出，之前 0.6 秒太快=秒切感
    const outT = def.exit?.dur ?? Math.min(0.6, dur * 0.28);
    // from 用参数的**默认值**，不是当前值 ——
    // 当前值可能已经被 applyFrame 的视线/表情改过（比如 AngleY 被写成 -27），
    // 拿它当起点会让通道从 -27 插到 -16，动作反而变成'抬头'。
    const defVal = (id) => {
      const i = paramIndex.get(id);
      if (i === undefined) return 0;
      try { const d = model._model.getParameterDefaultValueByIndex?.(i); return Number.isFinite(d) ? d : 0; } catch { return 0; }
    };
    // 互斥组：新词属于某组时，同组其他词的参数先撤掉（换脸级表达自动让位）。
    // 「黑脸→屑屑眼」这类连续换表情，旧的不再叠加挂着。
    // 互斥组：新词属于某组时，同组其他词的条目让位（换脸级表达自动让位）。
    // 2026-11-20 修正：按条目的 src（来源词）判断——共享参数上「别人的」条目
    // （如闭眼写的 ParamEyeLOpen）不连坐。此前按参数 id 裸删，face-big 成员
    // （speechless 等 12 个）的 def 写了眼睛参数，blush 一触发闭眼就没了。
    const me = ctx.group ?? w;
    for (const members of Object.values(profile.exclusiveGroups ?? {})) {
      if (!members.includes(me)) continue;
      const memberSet = new Set(members);
      for (const other of members) {
        if (other === w) continue;
        const od = paramActs[other];
        if (!od) continue;
        for (const qid of [...(od.params ?? []).map((q) => q.id), ...(od.keys ?? []).map((k) => k.id)]) {
          const cur = channel.get(qid);
          const curOwner = cur?.group ?? cur?.src;
          if (curOwner === me) continue;                         // 同一次展开的零件，别自己清自己（感动=眉毛+眼泪+手+嘴）
          if (curOwner && !memberSet.has(curOwner)) continue;   // 别人的条目不连坐（组合词按 group 认）
          dropParam(qid);
        }
      }
    }
    // 手部词：先把上一只手的参数撤掉，再写这一只（三只手不能同时抬）
    if (def.hand) {
      if (idlePoseWord) clearIdlePose();
      for (const id of handParamIds) dropParam(id);
    }
    // 静态姿势（歪头、侧身、前倾…）：插到一个固定值然后保持
    // emo：情绪弧度标记（applyFrame 扫描通道喂给弧度引擎，条目退场弧度自动消失）
    const owner = ctx.group ?? w;   // 组合词展开出来的零件，身上带的是组合词的名字
    const emo = (profile.emotionArc ?? {})[owner] ?? null;
    for (const p of def.params ?? []) {
      const f0 = defVal(p.id);
      const lid = isLidParam(p.id);
      const smile = isSmileParam(p.id);
      // lid 条目 to 是"乘数"（1 = 睁眼），幅度修饰按 1 为锚缩放（他们 EyeOpen 也是乘 1+.35*s）。
      const to = (lid || smile)
        ? 1 + (((p.to ?? 1) - 1) * effScale)
        : f0 + ((p.to ?? 0) - f0) * effScale;
      // p.in：单个参数可以自己定淡入时长（「放下手」那种要慢慢收的手势用）——
      // 统一 min(0.45, dur*0.2) 对它是瞬间清零，手就「啪」一下掉了
      channel.set(p.id, { kind: 'hold', lid, smile, from: lid || smile ? 0 : f0, to: mir(p.id, to), t0: now, dur: clipHandHold ? 1e9 : dur, in: p.in ?? inT, out: clipHandHold ? 0 : outT, keep: !!(def.state || def.keep), faceLinked: !!fromFace, clipHold: clipHandHold, emo, bornS: sentenceCount, bornT: clockT, src: w, group: ctx.group, skit: ctx.skit, life: life ?? undefined });
    }
    // 波形动作（点头、摇头、甩草…）：正弦摆动叠在通道上。
    // 不支持这一种的话，点头永远只能走旧路，也就永远不能和别的东西叠加。
    const setWave = (wv, post) => tracks.push({
      id: wv.id,
      kind: 'wave',
      amp: (wv.amp ?? 0) * effScale,
      freq: (wv.freq ?? 1) / mod.pace,     // 时间拉长 → 频率按比例降，摆幅次数才和原来一致
      base: wv.base ?? 0,
      phase: wv.phase ?? 0,
      post: !!post,
      // state 词的波形和静态参数同寿命（持续抖到退场）——不补的话波形抖 dur 秒就静默消失
      keep: !!(def.state || def.keep),
      emo,
      t0: now,
      dur,
      in: inT,
      out: outT,
      bornS: sentenceCount, bornT: clockT, src: w, group: ctx.group, skit: ctx.skit,   // 条目独立生日（共享寿命钟的替代——后词不再重置别人的钟）
    });
    for (const wv of def.waves ?? []) setWave(wv, false);
    // postWaves 写的是物理的输出参数（腰/胯），只能在 physics.evaluate() 之后写，
    // 写早了会被当场算回 0 —— 所以单独标 post，由 applyChannelPost 收尾。
    for (const wv of def.postWaves ?? []) setWave(wv, true);
    // 关键帧（点头、摇头、叹气…）：按手写的时间点插值。
    // 比正弦强在能做到"过冲一点再落回来""点一下、停、再点一下"——
    // 正弦两端必然对称，所以永远是钟摆感，做不出真人的节奏。
    // 关键帧（点头、摇头、叹气…）：按手写的时间点插值。
    // 比正弦强在能做到"过冲一点再落回来""点一下、停、再点一下"——
    // 正弦两端必然对称，所以永远是钟摆感，做不出真人的节奏。
    // keysPost：物理输出参数（胸腔 Z 等）的关键帧——写早了会被物理算回，由 applyChannelPost 收尾。
    // clip 自带的手型：只播抬起段，末尾挂一个很远的保持帧，什么时候放由 clip 说（gesture.off）
    const clipKeys = clipHandHold && def.raiseKeys
      ? def.raiseKeys.concat(def.raiseKeys.map((f) => ({ ...f, t: 1e9 })))
      : null;
    for (const [keyArr, post] of [[clipKeys ?? def.keys, false], [def.keysPost, true]]) {
      if (!keyArr?.length) continue;
      const byId = new Map();
      for (const f of keyArr) {
        if (!byId.has(f.id)) byId.set(f.id, []);
        byId.get(f.id).push([f.t ?? 0, f.v ?? 0]);
      }
      for (const [id, frames] of byId) {
        frames.sort((a, b) => a[0] - b[0]);
        // 幅度 × scale，时间 × pace；×几 就把整条时间轴复制几份接在后面
        const span = frames[frames.length - 1][0];
        const out = [];
        for (let r = 0; r < mod.repeat; r++) {
          for (const [t, v] of frames) out.push([(r * span + t) * mod.pace, mir(id, v) * effScale]);
        }
        tracks.push({ id, kind: 'keys', frames: out, t0: now, dur: clipHandHold ? 1e9 : dur, emo, post, eyeLid: isLidParam(id), bornS: sentenceCount, bornT: clockT, src: w, group: ctx.group, skit: ctx.skit });
      }
    }
    audit('write ' + w);
    console.info('[l2d] 通道记录', w, '静态', (def.params ?? []).length, '波形', (def.waves ?? []).length);
    // 返回 false：姿态由通道画，但**生命周期交还给 kit**。
    // 早先这里返回 true 把 doWord 整个截胡，结果 kit 的 act() 从没执行，
    // 连带丢了 busy 互斥、清表情、setMode('idle')、holdFace 配表情、play 音效。
    // 而 pulse 姿态本来就是跳过我们的词的（figure 声明了 gestures），交还不会有重复绘制。
    //
    // 例外 2：takeover 词（dance 等通道复刻版，替换 kit 原生 pulse 的词）同样完整接管——
    //   kit act 对它们只会播 pulse 组变换（2D 小人的贴图摆动，对骨骼模型很怪）和
    //   holdFace 强脸——通道 keys 版才有真动作。motion 词照旧 return false。
    if (emo || def.takeover) return true;
    // 例外：情绪词（emotionArc 覆盖的）返回 true **完整接管**——
    //   交还的话 kit words 表把它们标成 motion（paramActs 词构建时统一标 motion），
    //   doWord 会走 act 分支（把表情当动作播，setExpr/音效/粒子全跳过，2026-11-19 实测）；
    //   走 setExpr 分支又会触发 face 清场把刚写的条目删掉。
    //   接管后 extras（音效/爱心/挤压）由 kit wordExtras 提供，face 清场不再触发。

    return false;
  }

  /** 每帧把通道值写进模型。必须在 applyFrame / applySchemeParams 之后 —— 那些会重置 role 默认值。 */
  /**
   * 关键帧采样：frames 是 [[t, v], ...]（已按 t 排序）。
   * 段内用 smoothstep，避免关键帧之间出现硬折角 —— 但两端的关键帧值是原样保留的，
   * 所以"过冲一点点再落回来"这种手感不会被削平。
   */
  function sampleKeys(frames, t) {
    if (!frames.length) return 0;
    if (t <= frames[0][0]) return frames[0][1];
    const last = frames[frames.length - 1];
    if (t >= last[0]) return last[1];
    for (let n = 1; n < frames.length; n++) {
      const [t1, v1] = frames[n];
      if (t > t1) continue;
      const [t0, v0] = frames[n - 1];
      const span = t1 - t0;
      if (!(span > 1e-6)) return v1;
      const k = (t - t0) / span;
      return v0 + (v1 - v0) * (k * k * (3 - 2 * k));
    }
    return last[1];
  }

  /** 保持型条目的寿命闸门：1 = 还活着，0 = 该退场了（返回 0 时调用处删条目）。
   *  自动放松：说话语境跟 2 句或说完话 2 秒，闲置语境限时（默认 3 秒）。 */
  function lifeGate(c) {
    // clip 自带的手型（chest-hand 这类）：活到 clip 结束，由 gesture.off 统一撤——不能按句子/闲置寿命先死
    if (c.clipHold && clipList.some((x) => x.def.gesture && !x.handOff)) return 1;
    // 自动放松（2.6 改造）：寿命按语境分——
    //   说话语境（最近 30 秒说过话）：跟句 2 句 或 说完话 2 秒，先到先退
    //   闲置语境（30 秒没说话，随机动作触发的）：限时 3 秒（对齐他们 mood.Seconds）
    // 2026-11-20 修正：bornS/bornT 是条目自己的生日（此前共享变量——后一个词
    // 会把全通道的寿命钟重置）；sinceEnd 只数「本条目出生之后的说完话」——
    // 修复：消息 N 里出生的条目被拿消息 N-1 的说完时刻判定，回话慢于 2 秒
    // 就出生即过期（闭眼+害羞案「时好时坏像顺序问题」的真身）。
    const bornS = c.bornS ?? bornSentence;
    const bornT = c.bornT ?? bornAt;
    const lived = sentenceCount - bornS;                     // 活了几句
    const bornAge = clockT - bornT;                          // 出生多久
    const speakingCtx = lastSpeechEnd >= 0 && (clockT - lastSpeechEnd) < 30; // 最近说过话
    const sinceEnd = lastSpeechEnd >= bornT ? clockT - lastSpeechEnd : 0;   // 说完多久（出生后的才算）
    // faceLinked 条目（face 联动的影子）：下一个词触发时让位（actWord 开头清），
    // 说完话 2 秒后自己渐退（他们文档的「说完过一会儿自己松掉」）；
    // 闲置语境（随机动作触发的影子）照旧限时 3 秒
    // 3.8：条目可以带自己的寿命（idleMoods 的心情挂更久），没有就用默认 3 秒
    const idleLife = c.life ?? IDLE_LIFE;
    // 彩蛋剧本（skit:true）：只按自己的 life 判死。否则长剧本（跳舞 27 秒）
    // 会在台词/句子边界被「跟 2 句」「说完 2 秒」提前收掉，动作演一半就散了。
    const expired = c.skit
      ? bornAge > idleLife
      : c.faceLinked
      ? speakingCtx
        ? sinceEnd > SPEECH_END_DELAY
        : bornAge > idleLife
      : speakingCtx
        ? (bornS >= 0 && lived >= SENT_LIFE) || sinceEnd > SPEECH_END_DELAY
        : bornAge > idleLife;
    if (expired) {
      if (!c.relaxStart) c.relaxStart = clockT;
      const fade = clamp((clockT - c.relaxStart) / RELAX_FADE, 0, 1);
      return 1 - fade;
    }
    if (c.relaxStart) c.relaxStart = 0;
    return 1;
  }

  function applyChannel(t) {
    writeChannel(t, false);
    globalThis.__l2dChannel = [
      ...[...channel.entries()].map(([k, v]) => k + ':' + v.kind + (v.keep ? '*' : '') + '→' + (typeof v.to === 'number' ? v.to.toFixed(1) : '?')),
      ...tracks.map((v) => v.id + ':' + v.kind + '#' + (v.src ?? '?')),
    ];
  }
  /** 物理之后写的那一批（腰/胯这类物理输出参数）。写早了会被物理算回去。 */
  function applyChannelPost(t) { writeChannel(t, true); }
  function writeChannel(t, wantPost) {
    if (!wantPost) { virtualParams.clear(); lidMul.L = 1; lidMul.R = 1; lidAdd.L = 0; lidAdd.R = 0; }   // 虚拟表/lid 乘数每帧前批重建
    if (!useChannels || (channel.size === 0 && tracks.length === 0 && overlay.size === 0)) return;
    for (const [id, c] of channel) {
      const age = t - c.t0;
      // keep=true：表情通道。一直保持到被同参数的新词覆盖、或者「恢复」清空。
      // 普通动作有 dur，播完自己退出。
      if (!c.keep && age > c.dur) { channel.delete(id); continue; }
      if (!!c.post !== wantPost) continue;                  // 前/后两批各写各的
      const i = paramIndex.get(id);
      const virtual = i === undefined;   // 虚拟参数：不写模型，写虚拟表（kit 的 custom.squash() 读）
      if (virtual && wantPost) continue;   // 虚拟参数只在前批处理一次
      // ---------- 眼睛开度：lid 乘数（照搬 main.cpp 的 hold + Lids）----------
      // 不直写参数：存成"相对 1 的乘数"交给 Lids 段乘在 eyeBlink 之后。
      // value 一阶指数逼近目标、weight 一阶指数 0→1（LID_TAU）——他们的 hold 同款两条滤波。
      if (c.lid || c.smile) {
        const alive = c.keep ? lifeGate(c) : (age > c.dur ? 0 : 1);
        if (c.v === undefined) c.v = c.to;   // 首次写入 = 目标（他们 set: if (!shown) hold.value = target）
        const ease = 1 - Math.exp(-frameDt / LID_TAU);
        c.w = (c.w ?? 0) + (alive - (c.w ?? 0)) * ease;
        c.v += (c.to - c.v) * ease;
        if (alive <= 0 && c.w < 0.01) { channel.delete(id); continue; }
        if (c.smile) {
          // 笑眼/下眼睑：值直达，权重指数（他们 heldParameters → SetParameterValue(id, value, weight)）
          if (virtual) virtualParams.set(id, { v: c.v * c.w, t: clockT });
          else setParamByName(id, c.v * c.w);
          continue;
        }
        // 眼睑：他们的 lid(id, 1 + (value-1)*weight)，再 max(0, ...) 防负数（main.cpp:335 同款）
        const mul = Math.max(0, 1 + (c.v - 1) * c.w);
        if (id === 'ParamEyeLOpen') lidMul.L *= mul; else lidMul.R *= mul;
        continue;
      }
      let k;
      if (c.keep) {
        // 表情层：只有淡入；淡出靠被同参数覆盖、「恢复」、或 2.6 自动放松
        const gate = lifeGate(c);
        if (gate <= 0) { channel.delete(id); continue; }
        k = clamp(age / Math.max(1e-3, c.in), 0, 1) * gate;
      } else if (age < c.in) k = age / c.in;
      else if (age > c.dur - c.out) k = (c.dur - age) / c.out;
      else k = 1;
      k = clamp(k, 0, 1);
      k = k * k * (3 - 2 * k);                             // 平滑进/出，避免硬切
      if (c.kind === 'wave') {
        // 波形：相位从动作开始算，和环境包络相乘 → 起手轻、收尾轻，中间是完整摆幅
        const rel = Math.max(0, age);
        if (virtual) virtualParams.set(id, { v: (c.base + c.amp * Math.sin((rel * c.freq + c.phase) * Math.PI * 2)) * k, t: clockT });
        else setParamByName(id, (c.base + c.amp * Math.sin((rel * c.freq + c.phase) * Math.PI * 2)) * k);
      } else {
        if (virtual) virtualParams.set(id, { v: c.from + (c.to - c.from) * k, t: clockT });
        else setParamByName(id, c.from + (c.to - c.from) * k);
      }
    }
    // ---------- 轨道：同参数相加（他们 main.cpp:563-593 的 tracks）----------
    // 多条动作可以同时演：点头叠在低头/歪头上会转得更远，而不是谁后写谁赢、另一个消失。
    // 眼睛开度的 keys（wink-left / wink-hold）是**绝对值**，不参与相加（0.45 + 0 会变 1.45），
    // 多条时后写覆盖 —— 和以前完全一致。
    if (tracks.length) {
      const sums = new Map();
      const handDirect = new Map();   // 手型参数：覆盖（不相加）
      // 倒序遍历 → 先遇到的是数组里**最新**那条，所以用 has 判断「第一次写入即最新」，旧的不覆盖
      for (let n = tracks.length - 1; n >= 0; n--) {
        const c = tracks[n];
        const age = t - c.t0;
        if (!c.keep && age > c.dur) { tracks.splice(n, 1); continue; }
        if (!!c.post !== wantPost) continue;
        let v;
        if (c.kind === 'keys') {
          v = sampleKeys(c.frames, age);   // 关键帧自带起止，不乘包络
        } else {
          const rel = Math.max(0, age);
          let k;
          if (c.keep) k = clamp(age / Math.max(1e-3, c.in ?? 0.2), 0, 1) * lifeGate(c);
          else if (age < (c.in ?? 0.2)) k = age / (c.in ?? 0.2);
          else if (age > c.dur - (c.out ?? 0.2)) k = (c.dur - age) / (c.out ?? 0.2);
          else k = 1;
          k = clamp(k, 0, 1);
          k = k * k * (3 - 2 * k);
          if (k <= 0) continue;
          v = (c.base + c.amp * Math.sin((rel * c.freq + c.phase) * Math.PI * 2)) * k;
        }
        // 眼睛关键帧是**增量**（他们 lid(1+value)）：同参数多条相加，最后统一变成乘数
        if (c.eyeLid || c.id === 'ParamEyeLOpen' || c.id === 'ParamEyeROpen') {
          if (c.id === 'ParamEyeLOpen') lidAdd.L += v; else lidAdd.R += v;
          continue;
        }
        // 手部骨架（竖手指/抚胸/狗尾草/放下手）是**切手型**，不是叠加：
        // 他们 Hand 枚举同一时刻只有一只手（Body.cs:100-101），两条轨道的参数相加会把胳膊算歪
        // （用户：「抚胸手突然很快放下」「带手部的动画都不完整」）。按轨道顺序取最新一条覆盖。
        if (c.src && paramActs[c.src]?.hand) { if (!handDirect.has(c.id)) handDirect.set(c.id, v); continue; }   // 倒序遍历：先遇到的是最新那条
        sums.set(c.id, (sums.get(c.id) ?? 0) + v);
      }
      for (const [id, v] of handDirect) setParamByName(id, v);   // 手型：绝对值覆盖
      for (const [id, sum] of sums) addParam(id, sum);
    }
    // 叠加层（2.8）：主通道写完后，把外力增量**加**到当前值上（rua 头反向叠在歪头词上 = 更歪）
    if (overlay.size) {
      for (const [k, o] of [...overlay]) {
        if (!!o.post !== wantPost) continue;
        const age = t - o.t0;
        if (age > (o.dur ?? 30)) { overlay.delete(k); continue; }   // 兜底过期：正常由外力源 overlayClear
        const i = paramIndex.get(o.pid);
        if (i === undefined) { overlay.delete(k); continue; }
        const kk = clamp(age / Math.max(1e-3, o.in ?? 0.2), 0, 1);  // 只淡入；淡出靠 overlayClear（松手即撤）
        model._model.setParameterValueByIndex(i, model._model.getParameterValueByIndex(i) + (o.to ?? 0) * kk);
      }
    }
  }

  // ---------- Layer：一段表演（clip）----------
  // 一条 clip = 常量 sets + 每参数关键帧 keys + 手型 on/off + 时长 dur，全部按同一条 age 采样。
  // 所以「手放下 / 前倾回正 / 表情归零」在同一个小数点发生，不再靠三处代码各自收尾。
  // delay：他们松手后有 1.5 秒空档（手走了、头回正、脸红还在），这段只等，不写任何参数。
  const clipList = [];
  const debugOverrides = new Map();   // 测试用：每帧最后强写（harness ?sp=）
  let clipHandHold = false;   // stepClips 正在调 gesture.on/off：这段里生出来的通道条目要活到 clip 结束
  const MOOD_CLIPS = {};
  for (const [id, d] of Object.entries(RUA_MOODS)) {
    MOOD_CLIPS[id] = {
      // delay：他们松手后先等弹簧回稳再演（普通 1.5s，融化 0.8s，PetWindow.Touch.cs:212/233）
      mood: id, delay: d.delay ?? 1.5, dur: d.dur,
      exprs: d.exps ?? [], sets: d.sets, keys: d.keys,
      gesture: d.hand ? { on: 'chest-hand', off: 'put-hand-down' } : null,
    };
  }
  function startLayerClip(def) {
    if (!def) return null;
    const c = { def, t0: clockT, hand: false, handOff: false, w: 0, lastT: clockT };
    clipList.push(c);
    return c;
  }
  // 「正在演」= 延迟已经过去、还没到 dur（弹簧/前倾锁存看这个）
  const clipActive = (mood) => clipList.some((c) => {
    const a = clockT - c.t0 - (c.def.delay ?? 0);
    return (!mood || c.def.mood === mood) && a >= 0 && a < c.def.dur;
  });
  // 「这条 clip 还在」（含松手后 1.5s 的空档）—— 脸红要跨过这段，不能一松手就白回去
  const clipAlive = (mood) => clipList.some((c) => !mood || c.def.mood === mood);
  function stopMoodClips() {
    for (let i = clipList.length - 1; i >= 0; i--) if (clipList[i].def.mood) clipList.splice(i, 1);
  }
  function stepClips(t) {
    if (!clipList.length) { for (const [id, v] of debugOverrides) setParamByName(id, v); return; }
    for (let n = clipList.length - 1; n >= 0; n--) {
      const c = clipList[n], d = c.def;
      const age = t - c.t0 - (d.delay ?? 0);
      if (age < 0) continue;   // 他们松手后先等弹簧回稳（1.5s / 融化 0.8s），这段什么都不写

      // sets（他们叫 Parameters）的权重：和 main.cpp:549 的 Hold 一模一样 ——
      //   weight += (on ? 1 : 0 - weight) * (1 - exp(-dt / 0.15))
      // clear 之后他们还会留 0.7 秒把这个权重衰到 0 才 erase，所以我们也不能 dur 一到就整条删。
      const dt = Math.min(.1, Math.max(0, t - c.lastT));
      c.lastT = t;
      const playing = age < d.dur;
      c.w = (c.w ?? 0) + ((playing ? 1 : 0) - (c.w ?? 0)) * (1 - Math.exp(-dt / 0.15));

      // 手型：clip 开始抬起来；结束前 exitDur 秒开始放，落地时刻和身体回正同一帧。
      // （他们 EndMood 是 motion Off 和 clear 同一个 tick；我们的收手是一段 1.05s 的显式动画，
      //   不往前挪就会「人已经站直了手还举着」）
      if (d.gesture && !c.hand) {
        c.hand = true;
        pendingMod = { scale: 1, pace: 1, repeat: 1, explicit: true };
        dirSide = 1;
        clipHandHold = true;
        try { applyOneWord(d.gesture.on, null, {}, {}); } finally { clipHandHold = false; }
      }
      const onAct = d.gesture ? paramActs[d.gesture.on] : null;
      const exitDur = onAct?.exit?.dur ?? onAct?.exitDur ?? 1.05;
      if (d.gesture && !c.handOff && age >= d.dur - exitDur) {
        c.handOff = true;
        pendingMod = { scale: 1, pace: 1, repeat: 1, explicit: true };
        dirSide = 1;
        clipHandHold = true;
        try { applyOneWord(d.gesture.off, null, {}, {}); } finally { clipHandHold = false; }
        // 收手这一刻，clip 自己抬起来的手必须立刻让位（否则它每帧还在写 Movement2=1，收手动画被盖回去）
        for (const [id, ch] of [...channel]) if (ch.clipHold) channel.delete(id);
      }

      // 参数合成：他们的语义是「set 按住 + anim 叠加」，同一个参数两边都有时是**相加**，
      // 不是后写的盖掉前写的（FaceAngleZ 就是这种：set 4 + 关键帧 ±3）。
      if (playing || c.w > .004) {
        const acc = {};
        if (c.w > .004) for (const [k, v] of Object.entries(d.sets ?? {})) acc[k] = v * c.w;
        if (playing) {
          for (const [k, frames] of Object.entries(d.keys ?? {})) {
            acc[k] = (acc[k] ?? 0) + sampleKeys(frames, age);
          }
        }
        for (const [k, v] of Object.entries(acc)) {
          if (k === 'EyeOpen') {   // EyeOpen 是乘数：负数 = 额外闭合（melt 的快眨两下）
            for (const id of ['ParamEyeLOpen', 'ParamEyeROpen']) setParamByName(id, clamp(1 + v, 0, 1));
            continue;
          }
          if (VIRTUAL_KEYS.has(k)) { virtualParams.set(k, { v, t }); continue; }
          const id = resolveId(k);          // ParamMouthPressLipOpen → MouthPressLipOpen：映射表按**模型 id** 认
          const mapped = vtsOut(id, v);
          setParamByName(id, mapped);
          // 他们的 PositionX/Y/Z 吃的是**输入值**（FaceAngleY 输入 ±20、角度输出 ±30），
          // setParamByName 默认按角度 1:1 派生位置，这里按他们的规则再写一次。
          const posId = ANGLE_TO_POS[id];
          if (posId && mapped !== v) setParamByName(posId, v);
        }
      }

      // 打点：每 0.5 秒说一次「这条 clip 演到哪、写了什么」——实机出问题看这一行就够
      if (Date.now() - (globalThis.__clipDbg ?? 0) > 500) {
        globalThis.__clipDbg = Date.now();
        const gv2 = (id) => { const i2 = paramIndex.get(id); return i2 !== undefined ? +model._model.getParameterValueByIndex(i2).toFixed(2) : null; };
        audit('clip ' + (d.mood ?? '?') + ' age=' + age.toFixed(2) + '/' + d.dur + ' w=' + c.w.toFixed(2)
          + ' lean=' + gv2('LeanInput') + ' az=' + gv2('AngleZ') + ' ay=' + gv2('AngleY')
          + ' smile=' + gv2('EyeSmile') + ' brow=' + gv2('BrowInnerUp') + ' hand=' + gv2('Movement2'));
      }

      if (!playing && c.w <= .004) {
        if (d.mood) { ruaSecHold = 0; ruaMeltHold = 0; }
        clipList.splice(n, 1);
      }
    }
    for (const [id, v] of debugOverrides) setParamByName(id, v);
  }

  function applyParamActs(frame) {
    const g = frame?.gesture;
    const act = g && paramActs[g.kind];
    // 通道接管的词：参数由 applyChannel 画，这里必须让位 —— 两处写同一个参数的话，
    // 结果取决于谁后写，动作会一半是插值一半是覆盖，看起来像抖动。
    // 顺手把旧路留下的 activeAct 清掉，免得上一个动作的参数残留。
    if (act && useChannels && channelWords.has(g.kind)) {
      if (activeAct) {
        for (const id of actParamIds(paramActs[activeAct])) {
          const i = paramIndex.get(id);
          if (i !== undefined) model._model.setParameterValueByIndex(i, 0);
        }
        activeAct = null;
        activePost = null;
      }
      return;
    }
    if (!act) {
      if (activeAct) {
        // 2026-11-21 照 main.cpp:574 的 erase 语义：动作播完**把参数交还给其它来源**，不要一律写 0。
        // role 覆盖的参数（AngleX/Y/Z、Position、eyeOpen、眉/嘴形…）applyFrame 每帧都会重写，
        // 这里再写 0 只是多一次覆盖；而写 0 会把「通道同参数」的保持值压掉（通道在后面写，虽然能盖回来，
        // 但同一帧内 max/叠加类逻辑会读到 0）。只对「没有每帧来源」的开关类参数（Movement/key/特效位）归零。
        for (const id of actParamIds(paramActs[activeAct])) {
          if (ROLE_OWNED.has(id)) continue;
          const i = paramIndex.get(id);
          if (i !== undefined) model._model.setParameterValueByIndex(i, 0);
        }
        activeAct = null;
        activePost = null;
      }
      return;
    }
    const k = clamp(g.k ?? 0, 0, 1);
    act._k = k;
    // 自己计时，不跟 kit 的 k 走。
    // 实测 k 会卡在中途（甩草永远停在 0.314），按 k 换算秒数的话动作只做了开头一小段，
    // 看起来就是"手抬了一下就没下文"。用累计时钟驱动，时长由 act.dur 说了算。
    if (act._lastKind !== g.kind || k < 0.02) { act._lastKind = g.kind; act._t0 = clockT; act._exited = false; act._exitT = undefined; }
    const dur = act.dur ?? 2.4;
    const t = clockT - act._t0;
    if (t > dur) {
      // 2026-11-21：有 exit 的动作 dur 结束时收手动画可能还没播完（0.72*dur + 1.25 > dur）——
      // 之前这里直接写 0 是秒切的真凶。exit 没播完就继续播，播完才交还默认。
      const exitEnd = dur * 0.72 + (act.exit?.dur ?? 0);
      if (act.exit && act._exited && t <= exitEnd) {
        applyActAt(act, t);
        return;
      }
      // 播完：参数交还给默认姿势
      if (activeAct === g.kind) {
        for (const id of actParamIds(act)) {
          const i = paramIndex.get(id);
          if (i !== undefined) model._model.setParameterValueByIndex(i, 0);
        }
        activeAct = null;
        activePost = null;
      }
      return;
    }
    applyActAt(act, t);
    // 退出段播一次"关闭"动画：VTS 里开/关是两个独立热键，
    // 只播"打开"的话收手那一下是硬切，看起来动作只做了一半。
    if (act.exit && t > dur * 0.72 && !act._exited) {
      act._exited = true;
      act._exitT = t;       // 2026-11-21：进入退出阶段，applyActAt 按 exit.keys 插值播收手动画
      heldGesture = null;   // 解除保持，让收手动画接管
    }
    activeAct = g.kind;
    activePost = act.postWaves ?? null;
  }

  function stepMotion(frame, dt) {
    if (SIMPLE) return;
    const g = frame.gesture;
    const want = g?.kind && clips.has(g.kind) ? g.kind : null;

    // 同一个手势不重复重播：kit 把 gesture 保持几帧，播完就去待机
    if (want && want !== lastGesture) {
      model._motionManager.stopAllMotions();
      idlePlaying = false;
      startClip(want, 3, false);
      lastGesture = want;
    } else if (!want) {
      lastGesture = null;
    }

    if (currentId && model._motionManager.isFinished()) {
      currentId = null;
      idlePlaying = false;
      // 标了 hold 的动作（换手类）：原生 motion 只负责"把手抬到位"。
      // 播完要一直停在最后一帧 —— 只在结束当帧 return 是不够的，
      // 下一帧会落到下面的 easeRestToDefault，手被一点点拉回去（抬到一半就掉）。
      if (g?.kind && paramActs[g.kind]?.hold) { heldGesture = g.kind; return; }
      model._motionManager.stopAllMotions();
      heldGesture = null;
    }

    if (!currentId) {
      // hold 期间一直保持 motion 末帧，直到这个手势结束
      if (heldGesture && g?.kind === heldGesture) return;
      heldGesture = null;
      // 有原生 Idle 组就让模型自己待机（比程序微动更自然），没有再回默认姿势
      if (idleIds.length && startIdle()) return;
      easeRestToDefault(dt);
      return;
    }

    try {
      model._motionManager.updateMotion(model._model, dt);
    } catch (e) {
      if (!motionWarned) {
        motionWarned = true;
        console.warn('动作更新失败（后续不再提示）', e);
      }
    }
  }

  // ---------- 每帧：base → 表演层 / 表情 → 程序动画 ----------
  function applyFrame(face, frame, dt, neutralPose = false) {
    const t = frame.t ?? 0;

    // ---------- rua 的淡出权重（整帧唯一来源）----------
    // 他们松手发 clear 给 Live2D 宿主，宿主带过渡把参数淡回默认；我们直写参数，
    // 不写就下一帧回基准 —— 前倾/歪头/眼珠/笑眼全都会「啪」一下跳回去。
    // ruaW：摸的时候 1，松手后 0.35 秒时间常数淡到 0；所有 rua 写入都乘它。
    if (frame.rua?.on) {
      ruaW = 1;
      ruaUxHold = frame.rua.ux ?? 0;
      ruaUyHold = frame.rua.uy ?? 0;
      ruaMeltHold = frame.rua.melt ?? 0;
      ruaSecHold = frame.rua.seconds ?? 0;
    } else if (ruaW > 0.002) {
      ruaW += (0 - ruaW) * (1 - Math.exp(-dt / 0.35));
    } else ruaW = 0;
    // 前倾单独一条：摸的时候和 mood 期间都保持，mood 演完才 0.6 秒褪掉
    if (frame.rua?.on || clipAlive()) ruaLeanK = 1;   // 含松手后的 1.5s 空档：他们 KeepLean 就是不让前倾在这段掉
    // 前倾的退出时长**跟收手动作为准**，不拍数字：他们 mood 结束时 clear LeanInput 和
    // PutHandDown 是同时发生的，所以我们用 put-hand-down 自己的 dur（1.6 秒）当时间常数。
    else if (ruaLeanK > 0.002) {
      const _leanOut = paramActs['put-hand-down']?.dur ?? 1.6;
      ruaLeanK += (0 - ruaLeanK) * (1 - Math.exp(-dt / _leanOut));
    }
    else { ruaLeanK = 0; ruaMeltHold = 0; }

    // 1) 全部 role 回到默认（写默认 == 模型默认姿势，所以是幂等的）
    for (const [name, role] of roles) writeRole(name, role.def);

    // 2) 表演层：连续情绪（VAD → FACS → role）。没有表演层才走离散配方。
    //    量取景的那几帧强制中性姿势：待机动作会把包围盒撑大，脚就量不准。
    // 情绪弧度：通道条目的 emo 标记（情绪词通道化后 frame.face 恒为 neutral，
    // 弧度改由通道驱动——条目退场/被顶掉/恢复时标记消失，弧度自动回中性）
    const emoFace = [...channel.values(), ...tracks].find((c) => c.emo)?.emo ?? null;
    const engine = performance && !neutralPose ? performance.update(t, dt, emoFace ?? frame.face) : null;
    lastEngine = engine;   // 留给 moodScale：下一次动作的默认幅度跟着当前情绪走
    const recipe = neutralPose
      ? {}
      : (engine
        ? null
        : (profile.expression?.[emoFace ?? frame.face ?? 'neutral'] ?? profile.expression?.neutral ?? {}));
    if (recipe) for (const [k, v] of Object.entries(recipe)) if (k !== 'fade') writeRole(k, v);

    // 3) 眼睛：形状 + 眨眼 + 困意（乘在表情之上，闭眼笑也能眨）
    let shape = 1;
    const eye = neutralPose ? null : face.eyes?.[0];
    if (eye) {
      if (eye.shape === 'down' || eye.shape === 'up') shape = 0;
      else if (eye.shape === 'lid') shape = clamp((eye.ry ?? 12) / 16, 0, 1);
    }
    // 眨眼词演出期间抑制 kit 自动眨眼（idle 随机眨会叠在 wink/眨眼词上抢戏）——
    // 通道里有 Eye 参数条目 = 我们的眨眼词正在演
    const wordBlinking = channel.has('ParamEyeLOpen') || channel.has('ParamEyeROpen');
    const bkAge = frame.blinkAge ?? 0;
    const bkDur = frame.blinkDur ?? 0.3;
    let bkClose;
    if (bkDur > 0 && bkAge < bkDur) { const p = bkAge / bkDur; if (p < 0.33) bkClose = p / 0.33; else if (p < 0.5) bkClose = 1; else bkClose = 1 - (p - 0.5) / 0.5; } else bkClose = 0;
    const close = 1;   // 2026-11-21 照搬他们：open 不含眨眼（眨眼由 eyeBlink 的 r 负责）。之前 bkClose + eyeBlink 双重眨眼
    const squint = neutralPose ? 1 : 1 - clamp(frame.eyeClose ?? 0, 0, 1);
    const drowse = neutralPose ? 1 : 1 - 0.75 * clamp(frame.drowse ?? 0, 0, 1);
    const baseOpen = engine
      ? clamp(engine.eyeOpen ?? 1, 0, 1)
      : (recipe?.eyeOpen ?? roles.get('eyeOpen')?.def ?? 1);
    // 2026-11-21：睡觉必须全闭眼（之前 drowse=1 只到 0.25 半闭 → 睡着睁眼）
    // openNoBase：不含 baseOpen（表情配方给的 eyeOpen）的部分——shape/眨眼抑制/困意/睡姿。
    // Lids 段用它乘通道乘数：词自己给的 eyeOpen 不要再叠一次表情配方的 eyeOpen。
    const openNoBase = frame.mode === 'sleep' ? 0 : shape * close * squint * drowse;
    lastOpenNoBase = openNoBase;
    const open = frame.mode === 'sleep' ? 0 : baseOpen * openNoBase;
    writeRole('eyeOpen', open);
    // 测试台在存图前读这个，确认「这一帧」到底算出了什么（不是换表情那一帧）
    globalThis.__l2dLast = {
      face: neutralPose ? 'neutral*' : frame.face, open: +open.toFixed(2), shape: eye?.shape ?? null, ry: eye?.ry ?? null,
      blink: +(frame.blink ?? 0).toFixed(2), ec: +(frame.eyeClose ?? 0).toFixed(2),
      perf: !!engine, mood: globalThis.__l2dPerf?.dominant ?? null,
    };

    // 4) 口型（main.cpp:622-630 原样）：张嘴快（rate 30）/ 闭嘴慢（rate 16），
    //    并且写完做 max(当前值, mouth) —— 只增不减，呼吸和表情不会把嘴关上。
    const gap = face.gap?.[0] ?? 50;
    const talk = neutralPose ? 0 : clamp(Math.max(frame.talk ?? 0, skitTalk()), 0, 1);
    const talkOpen = clamp((gap - 44) / 22 + talk * 0.35, 0, 1);
    const mouthTarget = neutralPose ? 0 : clamp(Math.max(talkOpen, (engine?.mouthOpen ?? 0) * 0.85), 0, 1);
    mouthS += (mouthTarget - mouthS) * (1 - Math.exp(-dt * (mouthTarget > mouthS ? 30 : 16)));
    writeRole('mouthOpen', mouthS);
    if (mouthS > 0.01) {
      const _mi = paramIndex.get('ParamMouthOpenY'), _ji = paramIndex.get('JawOpen');
      if (_mi !== undefined) model._model.setParameterValueByIndex(_mi, Math.max(model._model.getParameterValueByIndex(_mi), mouthS));
      if (_ji !== undefined) model._model.setParameterValueByIndex(_ji, Math.max(model._model.getParameterValueByIndex(_ji), mouthS * 0.6));
    }

    // 5) 视线 + 头身跟随（表演层的待机动作叠在宿主跟随之上）
    const rawLook0 = globalThis.__lookOverride !== undefined ? [globalThis.__lookOverride, 0] : frame.look;
    let rawLook = neutralPose ? [0, 0] : (Array.isArray(rawLook0) ? rawLook0 : [0, 0]);
    // noMirror 的形象不做水平翻转，但 kit 算 look 时乘了 pet.facing。
    // 必须用**瞬时的 facingNow** 抵消，不能用平滑的 faceVis ——
    // kit 那边是瞬时反号的，这边要是慢半拍，翻转那 0.2 秒 look 会短暂反号，
    // 表现就是头猛地往回抽一下再转回来。
    if (figure.noMirror && Number.isFinite(frame.facingNow)) rawLook = [rawLook[0] * frame.facingNow, rawLook[1]];
    // 3.9c 表演期视线：做表情/动作时看向屏幕而不是追鼠标（曲线版实现在下面 gazeCfg 分支里）。
    let look, lookEye, lookHead;
    if (!neutralPose && gazeCfg) {
      const mode = frame.mode ?? 'idle';
      const idleLike = mode === 'idle' || mode === 'look' || mode === 'sit';
      // 3.9c 表演期视线（2026-11-20 用户二次反馈，曲线版）：
      // 做表情/动作时视线**逐渐回拉**到屏幕（比走神快：7/s，~0.4s 到位），全程保留一点点鼠标
      // 影响（15%，不至于完全断开）；做完**逐渐交还**给鼠标（3/s，~1s 放回去）。
      // 两个方向都是曲线——硬切换就是「突然正视」「突然跟上」的僵直感。
      const perfTarget = clockT < performingUntil ? 1 : 0;
      performingBlend += (perfTarget - performingBlend) * Math.min(1, (frame.dt ?? 0.016) * (perfTarget > performingBlend ? 7 : 3));
      const walking = mode === 'walk' || mode === 'run';
      // 走路时头必须看前进方向，不吃表演期缩放
      const effLook = walking ? rawLook : [rawLook[0] * (1 - 0.85 * performingBlend), rawLook[1] * (1 - 0.85 * performingBlend)];
      // 注意：表演期**不动**走神系统的内部状态——表演期的视线压低全靠 blend（0.15 残留 × 走神衰减 ≈ 0，
      // 反正看着屏幕），词一结束 blend 放开，走神从原地继续，不会「先看一眼鼠标再走神失效」（2026-11-20 用户反馈）。
      const k = updateGazeInterest(effLook, Array.isArray(frame.pointer) ? frame.pointer : null, clockT, frame.dt ?? 0.016, idleLike);
      // 走路/跑步时头必须看向前进方向：kit 给的是 look=[3,0]，要是乘上走神残留的系数
      // （0.05）就等于没转，人会僵在原地看屏幕。这里直接用满值，但**不动内部状态** ——
      // 走完路回到待机，之前攒的走神会接着生效。
      // 2026-11-21 照他们：眼睛用自己的系数（回正更快），头/身体用 k（PositionX = FaceAngleX 1:1）。
      const kEye = walking ? 1 : gazeKEye;
      look = [effLook[0] * k, effLook[1] * k];
      lookHead = look;
      lookEye = [effLook[0] * kEye, effLook[1] * kEye];
      gazeSway = walking ? 0 : 1 - k;   // 走路时头不自己游移
    } else {
      gazeSway = 0;
      look = lookEye = lookHead = rawLook;
    }
    bodyLook = look;   // 留给 applyBodyFollow 用（身体跟随要在物理之后写）
    // ---------- rua 4.x：手驱动头（弹簧延迟）----------
    // kit 发 frame.rua = { on, ux, uy, side, face, seconds, melt, moving, fx }
    // 方向：左右同向（手在右→脸朝右）、上下反向（手在上→头低下去）
    const ruaOn = !!frame.rua?.on;
    // 摸上来的第一帧：打断正在播的动作/表情（他们 StrokeDown 里 behavior.Interrupt()）。
    // 之前 rua 开始时如果她正好在演闲时动作（竖手指/狗尾草），会一直演到寿命结束 ——
    // 用户：「rua 头还会有随机动作出现，竖手指哪来的」。
    if (ruaOn && !ruaWasOn) {
      relaxChannels();
      // 上一次的「摸后」还在演的话清掉：不然一摸上来就带着上次的脸红和表情
      if (clipList.length) { clipList.length = 0; for (const k of VIRTUAL_KEYS) virtualParams.delete(k); }
      audit('rua-interrupt 打断当前动作');
    }
    ruaWasOn = ruaOn;
    ruaOnNow = ruaOn;
    const _rux = frame.rua?.ux ?? 0, _ruy = frame.rua?.uy ?? 0;
    // 2026-11-22：**去掉 ruaS 那层弹簧**。他们只有一个弹簧（Aim 设目标 → 全局 spring 150/14），
    // 我们之前是 ruaS(150/14) 再串 angleS(130/13)，等于弹两次：跟手慢半拍、松手回正拖沓。
    // 现在直接给目标角度，弹簧（k/c 按档位切）只在这一层。
    // 方向（2026-11-22 用户实测校正：手在右，头要朝右迎合；手在上，头要低下反着来）：
    //   左右**同向** → AngleX 正 = 朝右，手在右 ux>0 → +ux
    //   上下**反向** → AngleY 正 = 低头，手在上 uy>0 → +uy（头往下）
    // （上一版两个都取了负号，所以左右反了、上下也反了）
    // 2026-11-22 用户：他们手离开头盒子，头会「黏着」回弹；我们完全没有弹性。
    // 关键不是让目标慢慢降（那样弹簧只是追踪，永远不过冲），而是**目标当帧归 0**
    // 交给欠阻尼弹簧（150/14，见 ruaKc）自己弹回去 —— 惯性 + 过冲就是那个「黏着」。
    const ruaRX = ruaOn ? _rux * 22 : 0;
    const ruaRY = ruaOn ? _ruy * 14 : 0;
    const ruaSide = frame.rua?.side ?? 0;
    const ruaSecs = frame.rua?.seconds ?? 0;
    const ruaMelt = frame.rua?.melt ?? 0;
    // 猛摸瞪眼（用户 2026-11-22 要的）：手速 >850px/s 连摸 0.35 秒 → 一次瞪眼，冷却 4 秒。
    // kit 的 fx 只是水平方向 /600，所以另加了一个未 clamp 的 speed。
    const ruaSpeed = frame.rua?.speed ?? 0;
    if (ruaOn && ruaSpeed > 850) ruaFastT += dt; else ruaFastT = Math.max(0, ruaFastT - dt);
    if (ruaFastT > 0.35 && clockT > ruaStartleAt) { ruaStartleAt = clockT + 4; ruaStartle = clockT; }
    ruaStartleK = ruaStartle > 0 ? clamp(1 - (clockT - ruaStartle) / 0.45, 0, 1) : 0;
    // ---------- rua 档位表情（照 StrokeFace）----------
    // 写在这里而不是 engine 分支里：这只模型没接表演层（engine 恒 null），
    // 放 engine 分支的话整块不会执行（第一版就是这么没生效的）。
    // engine 存在时下面还会再写一次，压过 engine 的心情值。
    // 松手后**继续写 ruaW 秒**（0.35 秒淡出）：这样前倾是「慢慢直回来」而不是「啪」地弹回。
    // 之前条件写的是 ruaOn，一松手整块跳过 -> 前倾当帧归零（用户：一松手直接跳回去）。
    if (ruaW > 0.002) {
      const sec = ruaOn ? ruaSecs : ruaSecHold;
      writeRole('eyeSmile', ruaW);
      writeRole('mouthForm', ruaW);
      // 眼睛不在这里写：eyeBlink（stepMotion）在这之后每帧把 ParamEyeL/ROpen 写成 1，
      // 写在这里会被它吃掉（用户：rua 时两个眼睛瞪得老大）。改在 Lids 段（blink 之后）绝对值写。
      // 他们 EndStroke 里有 KeepLean()：融化档按住 -17 **不清掉**，交给 mood 的 LeanInput
      // 关键帧从 -17 接到 -16，mood 演完才随 clear 淡出（Behavior.cs:66 注释原话）。
      // 所以这条**不乘 ruaW** —— 乘了就是「一松手 0.35 秒就直回去」（用户实测）。
      // mood 播放器是后写的，会盖住这里的值，不需要额外判断。
      // clip 演的时候前倾归 clip（sets/keys 里有那条 -17）；只有空档期和没 clip 时才由锁存写
      if (sec >= 8) { writeRole('browY', 0.5 * ruaW); writeRole('browAngle', 0.3 * ruaW); }
      else if (sec >= 3) { writeRole('browY', 0.2 * ruaW); }
    }
    // 前倾锁存**不能**放在 ruaW 里：ruaW 松手 0.35 秒就归零，之后这行再也不执行，
    // 基准姿势把 lean 写回 0 —— 这就是「融化一停手就直回去」。
    // 他们的 KeepLean 是让 hold 一直挂着，直到摸后 mood 的 set 接上（Behavior.cs:66）。
    if (!clipActive() && ruaMeltHold > 0.001 && ruaLeanK > 0.002) writeRole('lean', -17 * ruaMeltHold * ruaLeanK);
    // ---------- 摸后情绪（他们 PlayAfterStroke 的四个 mood，参数原样）----------
    // 我们之前走 applyOneWord('eye-squeeze') —— 那些词在形象包里根本不存在，等于什么都没发生
    // （用户：松手还是不会触发对应档位的动作，全没有）。
    const tilt = neutralPose ? 0 : (frame.tilt ?? 0);
    const lean = neutralPose ? 0 : (frame.lean ?? 0);
    const ax = engine?.angleX ?? 0;
    const ay = engine?.angleY ?? 0;
    const az = engine?.angleZ ?? 0;
    const bx = engine?.bodyX ?? 0;
    const ex = engine?.eyeBallX ?? 0;
    const ey = engine?.eyeBallY ?? 0;
    // 2026-11-21 全部照 main.cpp 原样（不再手调）：
    //   Drift(t,a,b,c) = (sin(t*a) + 0.6*sin(t*b+1.3) + 0.3*sin(t*c+2.1)) / 1.9
    //   FaceAngleX = lookX*22 + alive*3.0*Drift(t, .37, .91, 1.73)   （Y 是 2.0、Z 是 3.5）
    // 单位是度。sway（我们自己加的头游移）已删除——他们没这东西。
    const Drift = (t, a, b, c) => (Math.sin(t * a) + 0.6 * Math.sin(t * b + 1.3) + 0.3 * Math.sin(t * c + 2.1)) / 1.9;
    const alive = 1;   // 他们默认 1（睡着时由命令设 0）
    const driftX = alive * 3.0 * Drift(clockT, 0.37, 0.91, 1.73);
    const driftY = alive * 2.0 * Drift(clockT, 0.29, 0.77, 1.41);
    const driftZ = alive * 3.5 * Drift(clockT, 0.23, 0.63, 1.19);
    // 眼跳（main.cpp 原样）：每 1.2~4 秒随机 ±0.24 / ±0.16，速度 25。没有 boost。
    sac.wait -= dt;
    if (sac.wait <= 0) {
      sac.wait = 1.2 + 2.8 * Math.random();
      sac.tx = (Math.random() - 0.5) * 0.24;
      sac.ty = (Math.random() - 0.5) * 0.16;
    }
    const _dart = 1 - Math.exp(-dt * 25);
    sac.x += (sac.tx - sac.x) * _dart;
    sac.y += (sac.ty - sac.y) * _dart;
    if (engine) {
      // 2026-11-21 眼睛归一化（之前 lookEye 是度数 ±5，×0.55=±2.75 被 clamp 卡在 ±1 一直饱和 →
      // 走神衰减前 60% 眼睛毫无变化、只有头在转，看着就是「头先走」）。对齐他们 -0.9*(eyeLook+saccade)。
      // 他们 StepStroke:330-331：眼睛看向手 —— ParamEyeBallX = -ux*.9（负 = 朝屏幕右）、Y = -uy*.9
      writeRole('eyeBallX', ruaOn ? clamp(-_rux * .9, -1, 1) : clamp(ex * 0.6 + (lookEye[0] ?? 0) / 5 * 0.6 + sac.x * 0.6, -1, 1));
      writeRole('eyeBallY', ruaOn ? clamp(-_ruy * .9, -1, 1) : clamp(ey * 0.6 + (lookEye[1] ?? 0) / 4 * 0.7 + sac.y * 0.7, -1, 1));   // 2026-11-21 去掉负号：他们 EyeRightY = +0.7*(eyeLookY+saccadeY)
    // 2026-11-21 单位修正：kit 的 look/tilt/lean 都是度数（look ±5、tilt ±7、lean -6~11），
      // 之前当 -1~1 用 → 放大 5 倍鼠标敏感 + lean 接错位置。全部÷范围归一化。
      // 2026-11-21 度数域（role space 已改 [-30,30]）：直接对齐 DeepFish 度数（FaceAngleX=lookX*22 等）
      // 2026-11-21 main.cpp 原样：FaceAngleX = lookX*22 + drift；Y = lookY*16 + drift；Z = drift（没有 tilt）
      // rua 时头部**完全由手决定**（他们 amp=1 的 Aim 覆盖 look；不然她一边看鼠标一边被摸会打架）
      const _lookW = ruaOn ? 0 : 1;
      // 他们 StepStroke:327-329 三条原样：
      //   FaceAngleX = ux*22 · FaceAngleY = uy*14（我们取负，见上）
      //   FaceAngleZ = ux*7 - fx*5 + tilt，tilt = 6sin(π·melt) + 3·melt（合眼时轻轻歪）
      const _ruaTilt = ruaW > 0.002
        ? clamp((ruaUxHold * 7 - (frame.rua?.fx ?? 0) * 5
          + 6 * Math.sin(Math.PI * ruaMeltHold) + 3 * ruaMeltHold) * ruaW, -30, 30)
        : 0;
      const angleXVal = clamp((lookHead[0] ?? 0) / 5 * 22 * _lookW + driftX + ruaRX, -30, 30);
      const angleYVal = clamp(ay * 30 + (lookHead[1] ?? 0) / 4 * 16 * _lookW + driftY + ruaRY, -30, 30);
      const angleZVal = clamp(az * 30 + driftZ + _ruaTilt, -30, 30);
      // 2026-11-21 照搬他们 Spring（springK=130/springC=13）：头角度过弹簧，有惯性/过冲才自然
      const [sK, sC] = ruaKc();   // 摸 150/14 · 松手 200/28 · 融化 90/9 · 平时 130/13
      [angleS.x, angleS.xv] = ruaSpring(angleS.x, angleS.xv, angleXVal, sK, sC, dt);
      [angleS.y, angleS.yv] = ruaSpring(angleS.y, angleS.yv, angleYVal, sK, sC, dt);
      [angleS.z, angleS.zv] = ruaSpring(angleS.z, angleS.zv, angleZVal, sK, sC, dt);
      writeRole('angleX', angleS.x);
      writeRole('angleY', angleS.y);
      writeRole('angleZ', angleS.z);
      // lean 是整图旋转角（左右倾斜，度数）→ 走 PositionX（摆锤3 推 ParamBodyAngleX 左右），不是 LeanInput（那是前后）
      // 2026-11-21 vtube 原样：PositionX = FaceAngleX（1:1）。不再混 lean/swing。
      // 2026-11-21 vtube 映射原样（main.cpp:596-609）：PositionX/Y/Z = FaceAngle 经**每条映射自己的平滑**，
      // lag = smoothing*0.005。大肥鱼.vtube.json：FaceAngleX 15→0.075s、Y 4→0.02s、Z 30→0.15s。
      if (!mapS.started) { mapS.X = angleXVal; mapS.Y = angleYVal; mapS.Z = angleZVal; mapS.started = true; }
      else {
        mapS.X += (angleXVal - mapS.X) * (1 - Math.exp(-dt / 0.075));
        mapS.Y += (angleYVal - mapS.Y) * (1 - Math.exp(-dt / 0.02));
        mapS.Z += (angleZVal - mapS.Z) * (1 - Math.exp(-dt / 0.15));
      }
      writeRole('bodyX', clamp(mapS.X, -30, 30));
      // 2026-11-21：对齐 vtube.json FaceAngleY→PositionY / FaceAngleZ→PositionZ（1:1，-30~30）→ 摆锤7 推身体上下
      { const _pyi = paramIndex.get('PositionY'), _pzi = paramIndex.get('PositionZ'), _ryi = paramIndex.get('ParamBodyAngleRY');
        if (_pyi !== undefined) model._model.setParameterValueByIndex(_pyi, mapS.Y);
        if (_pzi !== undefined) model._model.setParameterValueByIndex(_pzi, mapS.Z);
        // 2026-11-21：frame.low = sitK*29（睡觉下沉）+ bob|sin|（走路颠簸）→ 身体 Y 位移。之前完全没接 → 睡觉站着、走路不颠。
        if (_ryi !== undefined) model._model.setParameterValueByIndex(_ryi, -(frame.low ?? 0)); }
      // 表情通道：引擎/配方已经算好，之前漏写，导致只有眼/嘴/头在动
      for (const k of ['eyeSmile', 'mouthForm', 'browY', 'browAngle', 'cheek']) {
        if (Number.isFinite(engine[k])) writeRole(k, engine[k]);
      }
      // ---------- rua 档位表情（照 PetWindow.Touch.cs 的 StrokeFace）----------
      // 笑眼(+嘴形) → 按 melt 慢慢合上；3 秒后眉心动；8 秒后眉眼都软；融化时前倾。
      // 猛摸瞪眼优先：眼睛直接回到 1（睁大）。
      if (ruaOn) {
        const m = ruaMelt, sec = ruaSecs;
        writeRole('eyeSmile', 1);
        writeRole('mouthForm', 1);
        writeRole('eyeOpen', ruaStartleK > 0.25 ? 1 : 0.45 * (1 - m));
        if (m > 0.001) {
          writeRole('lean', -17 * m);
          writeRole('angleZ', clamp(angleS.z + 6 * Math.sin(Math.PI * m) + 3 * m, -30, 30));
        }
        if (sec >= 8) { writeRole('browY', 0.5); writeRole('browAngle', 0.3); }
        else if (sec >= 3) writeRole('browY', 0.2);
      }
      { const _bi = paramIndex.get('ParamBreath'); if (_bi !== undefined) model._model.setParameterValueByIndex(_bi, 0.5 + 0.5 * Math.sin(clockT * 2 * Math.PI / 3.2345)); }
    } else {
      // 2026-11-21 同上：眼珠归一化（度数 ÷5/÷4），否则 ±5 直接饱和看不出走神
      // 2026-11-22 rua：眼睛看着手（他们 ParamEyeBallX = -ux*.9 / Y = -uy*.9）
      writeRole('eyeBallX', ruaW > 0.002 ? clamp(-ruaUxHold * .9 * ruaW, -1, 1) : clamp((lookEye[0] ?? 0) / 5 * 0.6 + sac.x * 0.6, -1, 1));
      writeRole('eyeBallY', ruaW > 0.002 ? clamp(-ruaUyHold * .9 * ruaW, -1, 1) : clamp((lookEye[1] ?? 0) / 4 * 0.7 + sac.y * 0.7, -1, 1));   // 2026-11-21 去掉负号（原来上下和鼠标反）
      // 2026-11-21 度数域（role space 已改 [-30,30]）
      // 2026-11-22 rua 补齐（engine 分支里有、这条 else 里一直没有 —— 这只模型走的就是这里）：
      //   look 归零（头完全由手决定）、Z 加 ux*7-fx*5+tilt、弹簧 k/c 按档位切
      const _lookW = ruaOn ? 0 : 1;
      const _ruaTilt = ruaOn
        ? clamp(_rux * 7 - (frame.rua?.fx ?? 0) * 5 + 6 * Math.sin(Math.PI * ruaMelt) + 3 * ruaMelt, -30, 30)
        : 0;
      const angleXVal = clamp((lookHead[0] ?? 0) / 5 * 22 * _lookW + driftX + ruaRX, -30, 30);
      const angleYVal = clamp((lookHead[1] ?? 0) / 4 * 16 * _lookW + driftY + ruaRY, -30, 30);
      const angleZVal = clamp(driftZ + _ruaTilt, -30, 30);
      // 2026-11-21 照搬他们 Spring（springK=130/springC=13）：头角度过弹簧，有惯性/过冲才自然
      {
        const [sK, sC] = ruaKc();   // 摸 150/14 · 松手 200/28 · 融化 90/9 · 平时 130/13
        [angleS.x, angleS.xv] = ruaSpring(angleS.x, angleS.xv, angleXVal, sK, sC, dt);
        [angleS.y, angleS.yv] = ruaSpring(angleS.y, angleS.yv, angleYVal, sK, sC, dt);
        [angleS.z, angleS.zv] = ruaSpring(angleS.z, angleS.zv, angleZVal, sK, sC, dt);
      }
      writeRole('angleX', angleS.x);
      writeRole('angleY', angleS.y);
      writeRole('angleZ', angleS.z);
      // 2026-11-21 vtube 原样：PositionX = FaceAngleX（1:1）。不再混 lean/swing。
      // 2026-11-21 vtube 映射原样（main.cpp:596-609）：PositionX/Y/Z = FaceAngle 经**每条映射自己的平滑**，
      // lag = smoothing*0.005。大肥鱼.vtube.json：FaceAngleX 15→0.075s、Y 4→0.02s、Z 30→0.15s。
      if (!mapS.started) { mapS.X = angleXVal; mapS.Y = angleYVal; mapS.Z = angleZVal; mapS.started = true; }
      else {
        mapS.X += (angleXVal - mapS.X) * (1 - Math.exp(-dt / 0.075));
        mapS.Y += (angleYVal - mapS.Y) * (1 - Math.exp(-dt / 0.02));
        mapS.Z += (angleZVal - mapS.Z) * (1 - Math.exp(-dt / 0.15));
      }
      writeRole('bodyX', clamp(mapS.X, -30, 30));
      { const _pyi = paramIndex.get('PositionY'), _pzi = paramIndex.get('PositionZ'), _ryi = paramIndex.get('ParamBodyAngleRY');
        if (_pyi !== undefined) model._model.setParameterValueByIndex(_pyi, mapS.Y);
        if (_pzi !== undefined) model._model.setParameterValueByIndex(_pzi, mapS.Z);
        // 2026-11-21：frame.low = sitK*29（睡觉下沉）+ bob|sin|（走路颠簸）→ 身体 Y 位移。之前完全没接 → 睡觉站着、走路不颠。
        if (_ryi !== undefined) model._model.setParameterValueByIndex(_ryi, -(frame.low ?? 0)); }
      { const _bi = paramIndex.get('ParamBreath'); if (_bi !== undefined) model._model.setParameterValueByIndex(_bi, 0.5 + 0.5 * Math.sin(clockT * 2 * Math.PI / 3.2345)); }
    }

    // 2026-11-21 拖拽惯性（PetWindow.cs:872 + main.cpp:614-620 原样）：
    //   每帧窗口位移 ×30 后 /40（= ×0.75，clamp ±30）→ target
    //   → 缓动 rate 8 / target 每帧衰减 exp(-dt*6) → Add 到 PositionX/Y；AngleZ += -swayX*0.4
    // 之前完全没有：拖拽时身体不甩。
    {
      const pushX = (frame.velX ?? 0) * dt * 0.75, pushY = (frame.velY ?? 0) * dt * 0.75;
      if (Math.abs(pushX) > 1e-4 || Math.abs(pushY) > 1e-4) {
        swayS.tx = clamp(pushX, -30, 30);
        swayS.ty = clamp(pushY, -30, 30);
      }
      swayS.tx *= Math.exp(-dt * 6); swayS.ty *= Math.exp(-dt * 6);
      swayS.x += (swayS.tx - swayS.x) * (1 - Math.exp(-dt * 8));
      swayS.y += (swayS.ty - swayS.y) * (1 - Math.exp(-dt * 8));
      const _swx = paramIndex.get('PositionX'), _swy = paramIndex.get('PositionY'), _swz = paramIndex.get('AngleZ');
      if (_swx !== undefined) model._model.setParameterValueByIndex(_swx, model._model.getParameterValueByIndex(_swx) + swayS.x);
      if (_swy !== undefined) model._model.setParameterValueByIndex(_swy, model._model.getParameterValueByIndex(_swy) + swayS.y);
      if (_swz !== undefined) model._model.setParameterValueByIndex(_swz, model._model.getParameterValueByIndex(_swz) - swayS.x * 0.4);
    }

    // 6) 外部直接驱动（工作台滑杆 / 参数面板）；放在最后，压过表情和待机
    for (const [name, value] of Object.entries(roleOverrides)) {
      if (Number.isFinite(value)) writeRole(name, value);
    }
  }

  // ---------- 取景 ----------
  // fitState 已在上方声明；这里只定义怎么应用
  function applyFit() {
    const fit = fitState;
    const cw = model._model.getCanvasWidth?.() ?? 1;
    const ch = model._model.getCanvasHeight?.() ?? 1;
    const aspect = cw / ch;
    const [px, py] = fit.padding ?? [0, 0];
    const availW = 2 * (1 - 2 * px);
    const availH = 2 * (1 - 2 * py);
    const base = fit.mode === 'cover'
      ? Math.max(availH, availW / aspect)
      : Math.min(availH, availW / aspect);
    const h = base * (Number.isFinite(fit.zoom) ? fit.zoom : 1);

    model._modelMatrix.setHeight(h);

    const [ox, oy] = fit.offset ?? [0, 0];
    const anchor = fit.anchor ?? 'center';
    const y = anchor === 'bottom' ? (-1 + py + h / 2)
      : anchor === 'top' ? (1 - py - h / 2)
        : 0;
    model._modelMatrix.setY(y + oy);
    if (typeof model._modelMatrix.setX === 'function') model._modelMatrix.setX(ox);
  }

  // ---------- 绘制 ----------
  function render() {
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const projection = new CubismMatrix44();
    projection.scale(canvas.height / canvas.width, 1);
    projection.multiplyByMatrix(model._modelMatrix);
    renderer.setMvpMatrix(projection);
    renderer.setRenderState(gl.getParameter(gl.FRAMEBUFFER_BINDING), [0, 0, canvas.width, canvas.height]);
    renderer.drawModel();
  }

  /**
   * 量取景时强制中性姿势。
   * 待机 / 呼吸 / 物理会让包围盒每帧变化；直接 measure 会把“这一帧”的姿势写死，
   * 每次自动贴合就会得到不同的 zoom / offset。而且外部调用 readPixels 时，
   * 默认帧缓冲可能已经被合成器清空。先重画一帧中性姿势再读，结果才稳定。
   */
  function renderNeutralPose() {
    if (!texturesReady) return false;
    model._model.loadParameters();
    applyFrame({}, {}, 1 / 60, true);
    applyPartOpacity(null);
    model._model.saveParameters();
    // 物理是有状态的：同一中性姿势也会因为上一帧的惯性读出不同包围盒。
    // 简单模式量取景不跑物理（脚底 / 躯干 / 高度不受头发尾巴滞后影响）。
    if (!SIMPLE) {
      if (_eyeBlink) _eyeBlink.updateParameters(model._model, 1 / 60);
      try { model._physics?.evaluate(model._model, 1 / 60); } catch { /* 物理失败不致命 */ }
      try { model._pose?.updateParameters(model._model, 1 / 60); } catch { /* 姿势失败不致命 */ }
    }
    applyCleanParams();
    model._model.update();
    render();
    return true;
  }

  function measureNeutralExtent() {
    if (!renderNeutralPose()) return null;
    return measureExtent();
  }

  /**
   * 把当前 WebGL 帧抓成透明 PNG（data URL）。
   * readPixels 是底向上、预乘 alpha；这里翻转并反预乘，再按最长边缩到 size。
   * 调用前必须刚 render 过，否则默认帧缓冲可能已被合成器清空。
   */
  function canvasPng(size = 512) {
    const w = canvas.width;
    const h = canvas.height;
    const src = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, src);
    const out = doc.createElement('canvas');
    out.width = w;
    out.height = h;
    const ctx = out.getContext('2d');
    const image = ctx.createImageData(w, h);
    const d = image.data;
    for (let y = 0; y < h; y++) {
      const sy = h - 1 - y;
      for (let x = 0; x < w; x++) {
        const i = (sy * w + x) * 4;
        const o = (y * w + x) * 4;
        const a = src[i + 3];
        d[o + 3] = a;
        if (a === 0) {
          d[o] = d[o + 1] = d[o + 2] = 0;
        } else {
          // WebGL 里是预乘 alpha；2D canvas 的 ImageData 要 straight alpha
          d[o] = Math.min(255, Math.round((src[i] * 255) / a));
          d[o + 1] = Math.min(255, Math.round((src[i + 1] * 255) / a));
          d[o + 2] = Math.min(255, Math.round((src[i + 2] * 255) / a));
        }
      }
    }
    ctx.putImageData(image, 0, 0);
    if (size === w) return out.toDataURL('image/png');
    const small = doc.createElement('canvas');
    small.width = size;
    small.height = size;
    const sctx = small.getContext('2d');
    sctx.imageSmoothingEnabled = true;
    sctx.imageSmoothingQuality = 'high';
    sctx.drawImage(out, 0, 0, size, size);
    return small.toDataURL('image/png');
  }

  // ---------- 交给 kit ----------
  // extent / anchors 优先用实测：第一帧画出来后读一次 alpha 包围盒，
  // 换模型/换贴图都不用再手填（不同画布留白差异太大，写死一定错）。
  // profile.extent / profile.anchors 仍然可以覆盖（工作台校准后写死）。
  const DEFAULT_EXTENT = [20, 8, 236, 256];
  let extent = profile.extent ?? null;
  /** 命中圈按高度带取可见 alpha 的中心；整张 bbox 会被尾巴/胡须带偏。 */
  let hitBands = null;

  function measureExtent() {
    const w = canvas.width;
    const h = canvas.height;
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    const rowMin = new Int32Array(h).fill(w);
    const rowMax = new Int32Array(h).fill(-1);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (buf[(y * w + x) * 4 + 3] > 8) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
          if (x < rowMin[y]) rowMin[y] = x;
          if (x > rowMax[y]) rowMax[y] = x;
        }
      }
    }
    if (x1 < 0) { hitBands = null; return null; }
    const unit = BOX / w;                       // 每像素多少 logo 单位
    const lx0 = x0 * unit, lx1 = (x1 + 1) * unit;
    const ly0 = (h - 1 - y1) * unit, ly1 = (h - y0) * unit;
    const lw = Math.max(1, lx1 - lx0), lh = Math.max(1, ly1 - ly0);
    const radii = [
      Math.min(lw * .46, lh * .18),
      Math.min(lw * .52, lh * .26),
      Math.min(lw * .48, lh * .22),
    ];
    hitBands = [0.14, 0.47, 0.80].map((k, i) => {
      const cy = ly0 + lh * k;
      const yc = Math.round(h - 1 - cy / unit);
      const half = Math.max(2, Math.round(lh * .045 / unit));
      let min = w, max = -1;
      for (let yy = Math.max(0, yc - half); yy <= Math.min(h - 1, yc + half); yy++) {
        if (rowMax[yy] < 0) continue;
        if (rowMin[yy] < min) min = rowMin[yy];
        if (rowMax[yy] > max) max = rowMax[yy];
      }
      const cx = max >= 0 ? (min + max + 1) / 2 * unit : (lx0 + lx1) / 2;
      return [cx, cy, Math.max(1, radii[i])];
    });
    // 三段的水平中心统一用躯干：头/腿的单段 span 会被尾巴、胡须带偏
    const bodyCx = hitBands[1]?.[0] ?? (lx0 + lx1) / 2;
    for (const b of hitBands) b[0] = bodyCx;
    return [
      Math.round(lx0),
      Math.round(ly0),
      Math.round(lx1),
      Math.round(ly1),
    ];
  }

  /**
   * 自动贴合：把可见 alpha 映射到 256 契约。
   * 脚 256 / 中心 128 / 高约 232 / 宽 ≤ 208；宽模型只压宽，不压脚底。
   */
  function autoFitExtent(target = {}) {
    const wantH = Number.isFinite(target.height) ? target.height : 232;
    const maxW = Number.isFinite(target.maxWidth) ? target.maxWidth : 208;
    const feet = Number.isFinite(target.feet) ? target.feet : 256;
    const center = Number.isFinite(target.center) ? target.center : 128;
    let m = measureNeutralExtent();
    if (!m) return null;
    for (let i = 0; i < 6; i++) {
      const [x0, y0, x1, y1] = m;
      const w = Math.max(1, x1 - x0);
      const h = Math.max(1, y1 - y0);
      const targetH = Math.min(wantH, (maxW * h) / w);
      // 用“躯干可见带”的中心，而不是整张 bbox：尾巴/胡须会把 bbox 中心拉偏
      const cx = hitBands?.[1]?.[0] ?? (x0 + x1) / 2;
      const okH = Math.abs(h - targetH) <= 1.5;
      const okX = Math.abs(cx - center) <= 1.5;
      const okY = Math.abs(y1 - feet) <= 1.5;
      if (okH && okX && okY) break;
      if (!okH) fitState.zoom = clamp((Number(fitState.zoom) || 1) * (targetH / h), 0.15, 6);
      const [ox, oy] = fitState.offset ?? [0, 0];
      fitState.offset = [
        clamp(ox + (center - cx) / 128, -1.5, 1.5),
        clamp(oy + (y1 - feet) / 128, -1.5, 1.5),
      ];
      applyFit();
      m = measureNeutralExtent() ?? m;
    }
    return m;
  }

  let extentFrames = 0;
  const currentExtent = () => extent ?? DEFAULT_EXTENT;
  const currentHits = () => profile.hits ?? hitBands ?? (() => {
    const [x0, y0, x1, y1] = currentExtent();
    const w = x1 - x0;
    const h = y1 - y0;
    const cx = (x0 + x1) / 2;
    const r = (v) => Math.max(1, v);
    // 单圆只覆盖胸口：头/脚抓不到，空白处又会吃点击。按可见范围给头 / 身 / 下三段。
    return [
      [cx, y0 + h * .14, r(Math.min(w * .46, h * .18))],
      [cx, y0 + h * .47, r(Math.min(w * .52, h * .26))],
      [cx, y0 + h * .80, r(Math.min(w * .48, h * .22))],
    ];
  })();
  const currentAnchors = () => profile.anchors ?? deriveAnchors(currentExtent());

  const publishInfo = () => {
    globalThis.__l2dInfo = {
      extent: currentExtent(),
      measured: extent,
      anchors: currentAnchors(),
      hits: currentHits(),
      roles: [...roles.keys()],
      expressions: [...expressions.keys()],
      idle: idleIds,
      motion: profile.motion?.kind === 'stand' ? 'stand' : 'roam',
      fit: { ...fitState, offset: [...(fitState.offset ?? [0, 0])], padding: [...(fitState.padding ?? [0, 0])] },
    };
  };

  const figure = {
    // 摸摸分区（kit 的 zoneAt 读这个，坐标是**模型坐标**，kit 会乘 kx/ky 转屏幕）。
    // 2026-11-23（S0）：头/脸优先用**模型部件树的实时包围盒**（见 buildPartBoxes）；
    // 拿不到部件才退回旧的「整幅包围盒 × 比例」——那份比例是照他们 Behavior.HeadBox 抄的，
    // 但乘的是被尾巴撑宽的 canvas 包围盒，头心本来就偏，所以只当兜底。
    touchZones() {
      const [x0, y0, x1, y1] = currentExtent();
      const w = x1 - x0, h = y1 - y0;
      const { head: hb, face: fb } = headFaceBoxes();
      let heads;
      if (hb) {
        heads = [{ id: 'head', x: hb.x, y: hb.y, rx: hb.rx, ry: hb.ry }];
        // 脸盒：有「五官/脸」部件就用它的包围盒；没有再按头的下半部推
        const f = fb ?? { x: hb.x, y: hb.y + hb.ry * .18, rx: hb.rx * .62, ry: hb.ry * .42 };
        heads.push({ id: 'face', x: f.x, y: f.y, rx: f.rx, ry: f.ry });
      } else {
        const _legacyHead = (profile.touchZones ?? []).find((z) => z.id === 'head');
        const cx = _legacyHead?.x ?? (x0 + x1) / 2;
        const cy = _legacyHead?.y ?? (y0 + h * .31);
        heads = [
          { id: 'head', x: cx, y: cy, rx: w * .26, ry: h * .22 },
          { id: 'face', x: cx, y: cy, rx: w * .17, ry: h * .10 },
        ];
      }
      // 下面几个沿用手写数据（胸部/裙子/腿/尾巴），只为「右键点在别处不触发」。
      const rest = (profile.touchZones ?? []).filter((z) => z.id !== 'head' && z.id !== 'face');
      return [...heads, ...rest];
    },
    // 头/脸的实时盒（模型坐标）+ 部件树诊断，给调试和 kit 读
    get headBox() { return headFaceBoxes().head; },
    get faceBox() { return headFaceBoxes().face; },
    // 调试/测试：直接演一条摸后反应（不经过命中判定）
    playMood(id) { return !!startLayerClip(MOOD_CLIPS[id]); },
    // 测试用：每帧最后强写一个参数（量「这个参数到底动不动模型」）
    debugSetParam(id, v) { if (v === null) debugOverrides.delete(id); else debugOverrides.set(id, v); },
    // 调试/测试：走真实的「松手 → 按峰值档位选 mood」分支（不经过 kit 的命中）
    debugRuaAfter(sec) { ruaPeak = sec; ruaPrevOn = true; stepRuaState({}); return clipList.at(-1)?.def.mood ?? null; },
    get clipDebug() { return clipList.map((c) => ({ mood: c.def.mood, age: +(clockT - c.t0 - (c.def.delay ?? 0)).toFixed(2), dur: c.def.dur })); },
    get partBoxDebug() { return { ...headBoxDbg, head: headBoxModel(), face: faceBoxModel(), extent: currentExtent() }; },
    // 彩蛋台词：交给页面临时显示一句话（页面侧不排队、不发给 World）。
    // 她正在说话/有问答挂着时页面自己忽略，所以不会和对话抢气泡。
    emitBubble(text, seconds) {
      audit('skit-say 「' + text + '」 桥=' + typeof figure.emitEvent);
      try { figure.emitEvent?.('bubble', { text, seconds }); } catch { /* 页面没这桥就静默 */ }
    },
    get extent() { return currentExtent(); },
    get hits() { return currentHits(); },
    get anchors() { return currentAnchors(); },
    // 2.7 整图压扁：kit 每帧读，叠加进自己的 sq 弹簧（sqT += squash()）——
    // 弹簧（280/14）、锚点、阴影、与落地/拖拽的叠加全部白拿
    squash() {
      const e = virtualParams.get('ViewSquash');
      const v = e ? e.v : 0;
      if (Date.now() - (globalThis.__sqDbg ?? 0) > 2000) {
        globalThis.__sqDbg = Date.now();
        audit('sq ViewSquash=' + v.toFixed(4) + ' hasEntry=' + !!e);
      }
      return v;
    },
    colors: { z: '#7fb0e8' },
    // 整图滚转：他们的 ViewRoll（main.cpp:565 的 bodyRoll，作用在整个图形矩阵上，单位度）。
    // kit 本来就会把 groupTilt 的返回值当整组旋转 —— 直接把 ViewRoll 加进去，不用改 kit。
    groupTilt(mode, tilt, lean) {
      const roll = virtualParams.get('ViewRoll')?.v ?? 0;
      return tilt + lean + roll;
    },
    // 整图平移：他们的 ViewX/ViewY（main.cpp:649 的 bodyX/bodyY），原本是 NDC（1 = 半个屏宽）。
    // 我们的形象只占窗口宽 43%（他们 94%），用屏宽当基准会显得位移大一倍 ——
    // 所以这里按**形象自身的半宽/半高**换算：返回值的 1 = 半个形象宽，kit 再乘 kx/ky 变成像素。
    // 视觉比例就和他们一致（同样是「形象宽的 1%」），曲线数值一个没改。
    groupMove() {
      const vx = virtualParams.get('ViewX')?.v ?? 0;
      const vy = virtualParams.get('ViewY')?.v ?? 0;
      if (!vx && !vy) return null;
      const [x0, y0, x1, y1] = currentExtent();
      return { x: vx * (x1 - x0) / 2, y: vy * (y1 - y0) / 2 };
    },
    // 2.8 叠加层：外力源（rua/触摸）在主通道结果之上相加——不动词表、不触发 face 清场
    overlaySet,
    overlayClear,
    // 渲染组级抖动（kit 渲染循环每帧调用）：情绪词的"浑身抖动"——
    // 对齐 kit 脸配方 fc.shake 的组级语义（整组一起抖，身体+头），参数级 wave 只抖头不够。
    // 时间用 kit 传入的 T（秒）——iframe 沙箱里 performance.now 不可用（踩过）。
    faceShake(t) {
      for (const c of [...channel.values(), ...tracks]) {
        if (c.emo === 'angry') return Math.sin(t * 60) * 1.4;
        if (c.emo === 'scared') return Math.sin(t * 66) * 1.1;
      }
      return 0;
    },
    // 情绪词的 kit 表情名（wordExtras 用）：pet_act 传中文原词、baseWord 还原成配方 id
    // （blush/tears/heart-eyes…），kit 的 FACE_TONES/爱心/挤压按 kit 表情名（shy/sad/love…）——
    // 用 emotionArc 换算回去，主动触发的音效/粒子才和随机表情一致
    onTone(t) {
      currentTone = t || '';
      globalThis.__l2dTone = currentTone;   // 诊断：harness diag 可读
    },
    emotionFace(w) {
      return (profile.emotionArc ?? {})[w] ?? (profile.expression?.[w] ? w : null);
    },
    // kit 的 doWord 会先问这里：返回 true 表示这个词形象自己处理（通道叠加），
    // 不走 kit 的单槽 pulse。白名单外的词返回 false，保持旧行为。
    actWord,
    // 3.9 统一闲时池：kit decide() 的 idle-word 选项从这里拿词表（{word,kind,w,life}），
    // 抽中后走 doWord(word, {idle, life}) 回到 actWord——音效/爱心/挤压在 kit 那头照发。
    idlePool() { return profile.idleRepertoire ?? []; },
    // kit 在 doWord 最前面调用：剥修饰 + 中文转 id，返回基础词
    baseWord,
    // Live2D 只有一个正面，镜像会把左右手整体换边（手里的狗尾草从右手换到左手），
    // 看起来就是"卡片翻面"。所以声明不镜像：转身改用头部转向表现。
    // kit 会据此跳过整个容器的 scaleX 翻转（见 patch-pet-kit.mjs 的 noMirror 补丁）。
    noMirror: profile.facing !== 'mirror',
    // 这几个动作由本图用模型参数实现，kit 不要再叠通用 pulse
    gestures: Object.keys(profile.paramActs ?? {}),

    // 工作台调试接口：直接写 role（不是 ParamXXX），优先级高于表情/待机
    __roles: {
      list: () => [...roles.keys()],
      set(values) {
        for (const [name, value] of Object.entries(values ?? {})) {
          if (roles.has(name) && Number.isFinite(value)) roleOverrides[name] = value;
          else delete roleOverrides[name];
        }
      },
      clear() { for (const name of Object.keys(roleOverrides)) delete roleOverrides[name]; },
      read: () => ({ ...roleOverrides }),
    },

    // 工作台试看：临时指定一个 exp3，不写回 profile
    __expr: {
      list: () => [...expressions.keys()],
      set(id) {
        // '' 表示「明确不要 exp3」（压过 profile 映射）；null 表示回退到 profile
        expressionOverride = id === '' ? '' : (id && expressions.has(id) ? id : null);
      },
      clear() { expressionOverride = null; },
      read: () => expressionOverride,
    },

    // 工作台取景：位置/大小实时改，构建时写进 profile.fit
    __fit: {
      get: () => ({ ...fitState, offset: [...(fitState.offset ?? [0, 0])], padding: [...(fitState.padding ?? [0, 0])] }),
      set(values) {
        const next = { ...fitState, ...(values ?? {}) };
        if (values?.mode) next.mode = values.mode;
        fitState = next;
        applyFit();
      },
      reset() {
        fitState = { mode: 'contain', anchor: 'bottom', padding: [0.04, 0.02], offset: [0, 0], zoom: 1, ...(profile.fit ?? {}) };
        applyFit();
      },
    },

    // 工作台：改完 fit 后重量一次 alpha 包围盒（否则 extent / 命中圈还是旧的）
    setScheme(id, o) {
      opts.scheme = id;
      resolveScheme();
      try { applySchemeParams(); } catch { /* 下一帧会写 */ }
      // 换装后身形（裙摆宽度）变了，取景要重算，否则会一直沿用上一套的缩放
      extent = null;
      extentFrames = 0;
      try { render(); } catch { /* 下一帧会画 */ }
      return o?.fade ? new Promise((r) => setTimeout(r, 0)) : undefined;
    },

    __remeasure() {
      try {
        const m = measureNeutralExtent();
        if (m) { extent = m; publishInfo(); }
        return m;
      } catch { return null; }
    },

    /**
     * 封面：中性姿势 + 专用取景（高 200 / 脚底 236 / 中心 128）拍 512 和 128 两张 PNG。
     * 拍完把 fitState / extent / 命中圈全部还原，绝不影响正常预览和命中测试。
     */
    __cover() {
      if (!texturesReady) return null;
      const oldFit = {
        ...fitState,
        offset: [...(fitState.offset ?? [0, 0])],
        padding: [...(fitState.padding ?? [0, 0])],
      };
      const oldExtent = extent;
      const oldHits = hitBands;
      try {
        // 封面从固定的基准取景出发，不继承上一次的 zoom / offset；否则两次构建会差几像素。
        fitState = { mode: 'contain', anchor: 'bottom', padding: [0.04, 0.02], offset: [0, 0], zoom: 1, autoFit: false };
        applyFit();
        const m = autoFitExtent({ height: 200, feet: 236, center: 128, maxWidth: 208 });
        if (!m) return null;
        if (!renderNeutralPose()) return null;
        const png = canvasPng(canvas.width);
        const png128 = canvasPng(128);
        return png && png128 ? { png, png128 } : null;
      } catch (e) {
        console.warn('[l2d] 封面生成失败', e);
        return null;
      } finally {
        fitState = oldFit;
        applyFit();
        extent = oldExtent;
        hitBands = oldHits;
        publishInfo();
        render();
      }
    },

    draw(petG, face, frame) {
      if (fo.parentNode !== petG) petG.appendChild(fo);
      if (!texturesReady) return;
      globalThis.__l2dModel = model;
      globalThis.__l2dFigure = figure;   // 诊断/测试：harness 的 ?addp 走 overlaySet
      globalThis.__l2dFitState = { zoom: fitState.zoom, offset: fitState.offset, autoFit: fitState.autoFit, hasExtent: !!extent };

      // 2026-11-21：frame.dt 比实际帧间隔小一半（实测 clockT 增长慢 2 倍 → 眨眼 630ms 而设定 300ms）。
      // 用 Date.now() 算真实帧间隔，clockT 和实际时间对齐（本作用域 performance 是物理引擎对象，不能用）。
      const _dtNow = Date.now();
      const dt = clamp((_dtNow - (globalThis.__dtLast ?? _dtNow)) / 1000, 0.001, 0.05);
      globalThis.__dtLast = _dtNow;
      clockT += dt;
      frameDt = dt;
      if (skit && frame.mode !== 'idle' && frame.mode !== 'look' && frame.mode !== 'sit') stopSkit('mode:' + frame.mode);
      stepSkit(dt);   // 通道的指数缓动（LID_TAU）用真实帧间隔
      // 诊断（摸头冻结 bug）：draw 的墙上时钟间隙 >800ms 就打点——tick 断流或 iframe 被卡在这里现形。
      // 用 Date.now()：本作用域的 performance 是物理引擎对象（line 411），且 iframe 沙箱里 window.performance.now 不可用（1713 行注释，踩过）。
      {
        const __w = Date.now();
        const __g = __w - (globalThis.__l2dLastDrawW ?? __w);
        if (__g > 800) { audit('frame-gap ' + Math.round(__g) + 'ms dt=' + dt.toFixed(3)); auditFlush(); }
        globalThis.__l2dLastDrawW = __w;
      }

      model._model.loadParameters();
      stepRuaState(frame);   // 松手反应（按峰值时长）
      applyFrame(face, frame, dt, !extent);
      // 服装/大小这类"状态"要压在 role 之上、并进入基准（换装后应该持久）。
      // 它们会写 key9/10/11/12（兔牙、钢盆、眼镜…），必须排在表情之前，
      // 否则表情刚把 key11 抬起来就被这里按回 0，眼镜永远出不来。
      applyCleanParams();
      applyIdlePhysics(clockT);
      applyBodyFollow(dt, frame.mode, frame.facing);   // 必须在物理之前：写的是 PositionX/Z 这类物理输入
      stepIdleWords(clockT, frame.mode);
      applyParamActs(frame);
      applySchemeParams();
      // 基准只存 role + 状态。动作、表情、物理都是"每帧重算"的输出，
      // 一旦被 saveParameters 存进基准，下一帧 loadParameters 就会把它们当成默认值
      // —— 表情停了参数却回不去，表现就是圈圈眼 / 黑脸 / 白眼永久残留。
      model._model.saveParameters();            // ← 必须在 physics 之前
      stepMotion(frame, dt);
      stepExpression(frame.face, dt);
      // exp3 联动的自动放松（2.6 补全）：说完话 2 秒后，当前表情写的 keyN 渐退。
      // expressionManager 在 face 不变时每帧保持参数，我们在这里后写衰减值——
      // 每帧拉锯但渲染归零；face 一变（新句新表情）就重置重来。
      if (lastSpeechEnd >= 0 && currentExpr) {
        const sinceEnd = clockT - lastSpeechEnd;
        if (sinceEnd > SPEECH_END_DELAY) {
          const fade = clamp((sinceEnd - SPEECH_END_DELAY) / RELAX_FADE, 0, 1);
          for (const qid of exp3Params.get(currentExpr) ?? []) {
            try {
              const cur = model._model.getParameterValueById(qid);
              model._model.setParameterValueById(qid, cur * (1 - fade));
            } catch { /* 参数不存在则跳过 */ }
          }
        }
      }
      applyPartOpacity(currentId);
      // 通道叠加必须写在 stepMotion 之后：Cubism 的 idle 动作每帧会改参数，
      // 写早了会被它盖掉（实测鞠躬的低头被 idle 吃掉，AngleY 读回是正值）。
      // 放物理之前，物理才能把它当输入用。
      applyChannel(clockT);
      // 2026-11-21 照搬 DeepFish 的 Lids（main.cpp:327-338）：
      //   eyeBlink 每帧写 r（不眨=1）→ 之后把通道的眼睛乘数乘上去（1 + (value-1)*weight）。
      // 之前是「通道里有眼睛参数就整个停掉自动眨眼 + 直写参数」：闭眼类词（state 型）
      // 于是不能眨，而且直写用的是参数默认值（这个模型默认是 0=闭眼）当起点 ——
      // 每个眼睛词开帧先闭死一刀，用户看到的就是「先闭眼再半睁」「先闭眼再眯眼笑」。
      // 他们只有**单眼动画**（track/keys 里有 ParamEyeLOpen）才 blinkBlocked，这里同款。
      {
        const _el = paramIndex.get('ParamEyeLOpen'), _er = paramIndex.get('ParamEyeROpen');
        const _soloEye = tracks.some((c) => c.kind === 'keys' && c.eyeLid);
        const _blinkRan = !!_eyeBlink && !_soloEye;
        if (_blinkRan) _eyeBlink.updateParameters(model._model, dt);
        // 通道乘数（他们 Lids updater：在 eyeBlink 之后、物理之前）。
        // eyeBlink 把参数整个写成 r（不含 applyFrame 的 open），所以这里要乘回
        // role 的非配方开度系数（shape/困意/睡姿）——之前半睁的 role 0.37 就是这么丢的。
        // 三类相乘：hold 词的乘数（闭眼/半睁）× 关键帧增量（1+Σ，单眨眼/sigh 微闭）× role 的非配方开度
        // ---- rua 的档位开度（照他们 StrokeFace）----
        // 笑眼 open=.45*(1-melt)，融化到 0（眯眼笑）；猛摸瞪眼时 1（睁大）。
        // 关键：**必须写在这里**（eyeBlink 之后），因为它每帧把 ParamEyeL/ROpen 整个写成 1：
        // 写早一步就被吃掉 —— 用户看到的「rua 时两个眼睛瞪得老大」就是这个。
        const _rv = frame.rua;
        const _ruaOn = !!_rv?.on;
        // ruaW 在 applyFrame 开头统一推进（整帧唯一来源），这里只读。
        // 档位用「松手前最后一次」的秒数：frame.rua 没了之后 seconds 会变 0，
        // 8 秒档的眉心会突然掉掉（用户：松手后什么都没了）。
        const _secR = _ruaOn ? (_rv?.seconds ?? 0) : ruaSecHold;
        const _ruaOpenLive = ruaStartleK > .25 ? 1 : .45 * (1 - ruaMeltHold);
        const _ruaOpen = ruaW > 0.002 ? _ruaOpenLive : null;
        const _blinkBase = _blinkRan ? lastOpenNoBase : 1;
        // 淡出时在「正常开度」和「rua 开度」之间按 ruaW 插值
        const _baseL = _ruaOpen !== null ? _blinkBase * (1 - ruaW) + _ruaOpen * ruaW : _blinkBase;
        const _baseR = _baseL;
        const _mulL = _baseL * lidMul.L * Math.max(0, 1 + lidAdd.L);
        const _mulR = _baseR * lidMul.R * Math.max(0, 1 + lidAdd.R);
        if (_el !== undefined && _mulL !== 1) model._model.setParameterValueByIndex(_el, model._model.getParameterValueByIndex(_el) * _mulL);
        if (_er !== undefined && _mulR !== 1) model._model.setParameterValueByIndex(_er, model._model.getParameterValueByIndex(_er) * _mulR);
        // rua 单闭眼：手在哪侧闭哪只眼（side=1 右、-1 左）。
        // 2026-11-21 改成 0.15 秒时间常数的指数缓动（他们 Hold 的 1-exp(-dt/0.15)）：
        // 原来是硬写 0 —— 手移过去眼睛「啪」一下闭上。改成缓动后是「半眯→闭」的柔和过渡，
        // 反过来松手时也是慢慢睁开（后面搬 rua 头/表情档位就靠这条）。
        const _rs = frame.rua?.side ?? 0;
        // 2026-11-22 对齐他们 StrokeFace：side=1（手在屏幕右）闭的是 ParamEyeLOpen
        // （模型的左眼在屏幕右边）；摸到脸上且居中 = 双眼都闭（眯眼笑）。之前两侧是反的。
        const _rFace = !!frame.rua?.face && _rs === 0;
        const _wantL = (_rs === 1 || _rFace) ? 1 : 0;
        const _wantR = (_rs === -1 || _rFace) ? 1 : 0;
        const _rEase = 1 - Math.exp(-dt / 0.15);
        ruaEyeS.L += (_wantL - ruaEyeS.L) * _rEase;
        ruaEyeS.R += (_wantR - ruaEyeS.R) * _rEase;
        // 绝对值写（不是乘）：他们 Face() 是 set，blink 之后写才不会被打回去。
        // 摸到脸上 → 双眼 0（闭）；手在屏幕右 → 闭模型左眼（ParamEyeLOpen），
        // 另一只保持笑眼半眯 .45；两边都没到 → 双眼半眯。
        if (_ruaOpen !== null) {
          if (_el !== undefined) model._model.setParameterValueByIndex(_el, _baseL * (1 - ruaEyeS.L * ruaW));
          if (_er !== undefined) model._model.setParameterValueByIndex(_er, _baseR * (1 - ruaEyeS.R * ruaW));
          // 表情也要在这层再写：applyChannel 在 applyFrame 之后，会把 role 的笑眼/嘴形盖掉
          // （用户：rua 到后面就没表情了）。他们 Face() 每帧 set，同样压过心情。
          // 全部乘 ruaW —— 松手后 0.35 秒淡回 0，而不是「啪」一下没了。
          // 自动过别名表：他们的名字（FaceAngleY / ParamMouthPressLipOpen…）在这里统一换成我们的。
          // 2026-11-22：8 秒档的「微张嘴」写的就是 ParamMouthPressLipOpen，模型里没有 → 一次都没生效。
          const _sp = (id, v) => { const _i = paramIndex.get(resolveId(id)); if (_i !== undefined) model._model.setParameterValueByIndex(_i, v); };
          _sp('EyeSmile', ruaW);
          _sp('ParamMouthForm', ruaW);
          // 8 秒档：眉心上抬 + 微张嘴（他们 BrowInnerUp .5 / MouthPressLipOpen .4）
          if (_secR >= 8) {
            _sp('BrowInnerUp', .5 * ruaW);
            _sp('ParamMouthPressLipOpen', .4 * ruaW);
            if (Date.now() - (globalThis.__tier8 ?? 0) > 1500) {
              globalThis.__tier8 = Date.now();
              const gi = (id) => { const i = paramIndex.get(resolveId(id)); return i === undefined ? 'n/a' : +model._model.getParameterValueByIndex(i).toFixed(3); };
              audit('rua-tier8 sec=' + _secR.toFixed(1) + ' Brow=' + gi('BrowInnerUp') + ' Lip=' + gi('ParamMouthPressLipOpen') + ' smile=' + gi('EyeSmile'));
            }
          }
          else if (_secR >= 3) { _sp('BrowInnerUp', .2 * ruaW); }
        }
        // 脸红（key7）单独一段：**只能写在这里**（saveParameters 之后）。写进 applyFrame 会被
        // 存成基准，之后每帧 loadParameters 都从「红」开始 —— 表现就是脸一直红、消退不了。
        // 它不受 ruaW 影响：他们 EndStroke 是 Face(NoSets, ["脸红"])，脸红一路带到摸后。
        {
          // 他们：摸到 3 秒 PlayAfterStroke 前是 Face(NoSets, ["脸红"])，mood 里 Expressions 又带 ["脸红"]
          // → 脸红从 3 秒起一直挂到**摸后动作演完**才退，不是松手就退。
          const _wantBlush = (_ruaOn && _secR >= 3) || clipAlive() ? 1 : 0;
          blushK += (_wantBlush - blushK) * (1 - Math.exp(-dt / (_wantBlush ? 0.5 : 1.2)));
          if (Date.now() - (globalThis.__blushDbg ?? 0) > 400) {
            globalThis.__blushDbg = Date.now();
            audit('blush want=' + _wantBlush + ' k=' + blushK.toFixed(3) + ' rua=' + _ruaOn + ' sec=' + _secR.toFixed(1) + ' after=' + (clipList[0]?.def.mood ?? '-'));
          }
          if (blushK > 0.003) {
            const _k7 = paramIndex.get('key7');
            if (_k7 !== undefined) model._model.setParameterValueByIndex(_k7, blushK);
          }
        }
        globalThis.__lidMul = [+lidMul.L.toFixed(3), +lidMul.R.toFixed(3)];
        // 打点：眼睛链路（乘数 / 最终开度 / role 算出来的 open）
        if (Date.now() - (globalThis.__lidDbg ?? 0) > 100) {
          globalThis.__lidDbg = Date.now();
          const gv = (id) => { const i = paramIndex.get(id); return i !== undefined ? +model._model.getParameterValueByIndex(i).toFixed(3) : null; };
          audit('lid L=' + lidMul.L.toFixed(3) + ' R=' + lidMul.R.toFixed(3) + ' eL=' + gv('ParamEyeLOpen') + ' eR=' + gv('ParamEyeROpen') + ' open=' + (globalThis.__l2dLast?.open ?? '?') + ' ec=' + (globalThis.__l2dLast?.ec ?? '?'));
        }
      }
      // Layer：一段表演（含 rua 摸后四档）。**必须在物理之前** ——
      // AngleX/Y/Z、LeanInput、PositionX/Y/Z 都是 physics3.json 的输入
      // （AngleX→ParamAngleX、LeanInput→ParamBodyAngleY、PositionX→ParamBodyAngleX …），
      // 写在物理后面等于这帧的参数物理根本没看见，下一帧 loadParameters 又恢复基准，
      // 头和身体一次都不会动（用户：「只有手在执行」）。2026-11-23 修正。
      stepClips(clockT);
      try { model._physics?.evaluate(model._model, dt); } catch { /* 物理失败不致命 */ }
      // ---------- 摸后的四个 mood（Behavior.cs:59-67）----------
      // 全部写在这里（saveParameters 之后、物理之前）：直写参数不会进基准，
      // 播完下一帧 loadParameters 就恢复（写进 applyFrame 会永久残留）。

      // 打点：眨眼只在眨时打（0.05 秒一次，精确测时长）+ 每秒打身体/呼吸
      {
        const gv = (id) => { const i = paramIndex.get(id); return i !== undefined ? model._model.getParameterValueByIndex(i) : null; };
        const eL = gv('ParamEyeLOpen'), bodyAX = gv('ParamBodyAngleX'), bodyAY = gv('ParamBodyAngleY');
        const px = gv('PositionX'), py = gv('PositionY'), br = gv('ParamBreath'), aY = gv('AngleY'), pAY = gv('ParamAngleY'), pAX = gv('ParamAngleX'), hipX = gv('HipAngleX'), lookX = frame.look?.[0];
        // 眨眼：eyeL < 0.95 时每帧打，同时记 Date.now() 真实毫秒（验证 clockT 和实际时间是否一致）
        if (eL != null && eL < 0.95) {
          if (!globalThis.__blinkStart) globalThis.__blinkStart = Date.now();
          audit('blink-in real=' + (Date.now() - globalThis.__blinkStart) + 'ms t=' + clockT.toFixed(2) + ' eyeL=' + eL.toFixed(3));
        } else if (globalThis.__blinkStart) {
          audit('blink-end real=' + (Date.now() - globalThis.__blinkStart) + 'ms t=' + clockT.toFixed(2));
          globalThis.__blinkStart = 0;
        }
        // 每秒打身体/呼吸
        if (Date.now() - (globalThis.__earDbg ?? 0) > 1000) {
          globalThis.__earDbg = Date.now();
          audit('dbg look=' + (lookX?.toFixed(2) ?? 'null') + ' px=' + (px?.toFixed(2) ?? 'null') + ' py=' + (py?.toFixed(2) ?? 'null') + ' aY=' + (aY?.toFixed(2) ?? 'null') + ' bAY=' + (bodyAY?.toFixed(2) ?? 'null') + ' pAX=' + (pAX?.toFixed(2) ?? 'null') + ' hipX=' + (hipX?.toFixed(2) ?? 'null'));
        }
      }
      applyPhysicsWaves(clockT);
      applyActPostWaves(clockT);
      applyChannelPost(clockT);   // 通道里标了 post 的那批（腰/胯）：必须是物理之后当帧最终值
      try { model._pose?.updateParameters(model._model, dt); } catch { /* 姿势失败不致命 */ }
      model._model.update();
      render();

      globalThis.__l2dMotion = {
        id: currentId,
        idle: idlePlaying,
        idleCount: idleIds.length,
        expr: currentExpr,
        exprCount: expressions.size,
        // 手势进度：调试"动作只做一半/没动"时最关键的就是这个数
        g: frame.gesture ? `${frame.gesture.kind}@${(+frame.gesture.k).toFixed(3)}` : null,
        clips: [...clips.keys()],
        act: activeAct,
        actT: activeAct && paramActs[activeAct]?._t0 !== undefined
          ? +(clockT - paramActs[activeAct]._t0).toFixed(2) : null,
        clock: +clockT.toFixed(2),
      };

      // 贴图就绪后的第 3 帧量一次可见范围（等姿势稳定，别量到眨眼/动作的瞬间）
      if (!extent && extentFrames < 30 && ++extentFrames >= 3) {
        let m = null;
        try {
          m = fitState.autoFit !== false ? autoFitExtent() : measureNeutralExtent();
        } catch (e) {
          console.warn('[l2d] 量取景失败', e);
        }
        if (m) {
          extent = m;
          publishInfo();
          console.info('[l2d] extent', JSON.stringify(m));
          console.info('[l2d] fit', JSON.stringify(fitState));
        } else if (extentFrames === 3) {
          console.info('[l2d] extent 没量到（画面全透明？）');
        }
      }
    },

    dispose() {
      fo.remove();
      try { performance?.dispose(); } catch { /* 忽略 */ }
      try { model.release?.(); } catch { /* 忽略 */ }
    },
  };

  // 只有动作词交给 kit；表情走 profile.expression，kit 自己的 KIT_EXPRESSIONS 仍然可用
  const words = {};
  for (const m of entry.motions ?? []) {
    // idle 是常驻循环；exit-* 是动作的"收手"片段，由 exitClip 触发，不该变成可调用的词
    if (m.id === 'idle' || m.id.startsWith('exit-')) continue;
    // 与 paramActs 同名的动作：手势时长要跟参数层一致（参数要"保持"住），
    // 原生 motion 只负责开头那段过渡，播完就停、参数继续生效。
    const act = profile.paramActs?.[m.id];
    words[m.id] = { motion: { seconds: act?.dur ?? m.duration ?? 3 } };
  }
  for (const word of Object.keys(profile.extraExpressions ?? {})) {
    if (!words[word]) words[word] = { expression: { seconds: 3 } };
  }
  for (const [word, act] of Object.entries(profile.paramActs ?? {})) {
    // 时长必须与 paramActs.dur 一致：它是 k(0..1) 到真实秒数的换算基准，
    // 不一致会让波形被按比例加速/减速（之前写成 2.4 而 dur 是 3.6，实际快了 1.5 倍）。
    if (!words[word]) words[word] = { motion: { seconds: act.dur ?? 2.4 } };
  }

  publishInfo();
  globalThis.__l2dDrive = figure.__roles;
  globalThis.__l2dFit = figure.__fit;
  globalThis.__l2dRemesure = figure.__remeasure;
  globalThis.__l2dAutoFit = () => {
    const m = autoFitExtent();
    if (m) { extent = m; publishInfo(); }
    return m;
  };
  globalThis.__l2dCover = figure.__cover;
  globalThis.__l2dExpr = figure.__expr;

  const onSpeechStart = () => { sentenceCount++; stopSkit('speech'); auditFlush(); };   // 新句冲审计缓冲
  const onSpeechEnd = () => { lastSpeechEnd = clockT; };
  // onBeat（气泡边界）：「每个【】表情是这句话的脸」——情绪脸（face-big 成员）在
  // 新气泡边界让位（原机制保留，用途正当：黑脸→害羞这类跨句换脸）。
  // 2026-11-20 修复：原来把【全部】state 词都清了——细节/姿态词（闭眼/半睁/歪头/
  // 手型/视线）跟情绪是【叠加】关系（用户定过的语义），不该跟着情绪每句让位，
  // 【闭眼,害羞】的闭眼就是这么被连坐的。现在只清 face-big 成员；
  // 附加层（blush/sweat/tears/bunny-teeth，挂 2 句的贴图层）继续豁免。
  const ADDON_WORDS = new Set(['blush', 'sweat', 'tears', 'bunny-teeth']);
  const faceBigWords = new Set(profile.exclusiveGroups?.['face-big'] ?? []);
  const onBeat = () => {
    // 气泡边界：face-big 成员让位（一个情绪一次一张脸）。
    // 组合词展开后参数挂在零件上（眉毛/嘴/眼泪各自一条），靠条目的 group 认祖——
    // 按 def.params 遍历的话组合词是空壳，一个参数都清不到。
    for (const [id, c] of [...channel]) {
      const owner = c.group ?? c.src;
      if (!owner || ADDON_WORDS.has(owner) || !faceBigWords.has(owner)) continue;
      dropParam(id);
    }
    for (let n = tracks.length - 1; n >= 0; n--) {
      const owner = tracks[n].group ?? tracks[n].src;
      if (!owner || ADDON_WORDS.has(owner) || !faceBigWords.has(owner)) continue;
      tracks.splice(n, 1);
    }
  };
  const body = kit.createBody(host, { figure, words, css: 'foreignObject{pointer-events:none}', onSpeechStart, onSpeechEnd, onBeat });
  const motionKind = profile.motion?.kind === 'stand' ? 'stand' : 'roam';
  if (SIMPLE && motionKind === 'stand') {
    // 站定：无论 Coo / 预览传什么 roam，都强制 off；正面立绘也不镜像。
    const setBase = body.set.bind(body);
    body.set = (s) => setBase({ ...(s || {}), roam: 'off' });
    try { setBase({ roam: 'off' }); } catch { /* ignore */ }
    if (profile.facing !== 'mirror') {
      const placeBase = body.place.bind(body);
      body.place = (x, facing, y) => placeBase(x, 1, y);
      try { placeBase(body.layout?.().x ?? 0, 1); } catch { /* ignore */ }
      const stepBase = body.step.bind(body);
      body.step = (dt) => {
        try {
          const l = body.layout?.();
          if (l?.mode === 'idle' && !l.pressing && !l.busy) body.place(l.x, 1);
        } catch { /* ignore */ }
        stepBase(dt);
      };
    }
  }
  // roam：不拦截 set，也不驱动 place。让 kit 自己的 decide 跑
  // look / walk / run / jump / sit / expr，和旧版一致。
  return body;
}
