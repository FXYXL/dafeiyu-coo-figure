/**
 * The pet kit: a body that stands on the floor of the stage (or anywhere on it, `ground: 'free'`), walks, runs, jumps, sits, sleeps,
 * is picked up and thrown, makes faces and short gestures, with particles (hearts, tears, z's,
 * dust, notes) and a shadow. A figure pack builds its body on it (`createBody`) and only draws:
 * Coo (web/coo/figure.js) and the whale (web/whale/figure.js) both do. A pack may also ignore the
 * kit and answer the body contract (web/figure-frame.js) on its own.
 *
 * Coordinates: the figure is drawn in logo units, facing right, ground at y=256, inside a 256 square.
 * The stage places it with translate(AX AY) rotate(rot) scale(kx ky) translate(-ax -ay); `toStage`
 * maps a logo point back to stage pixels for hit tests, particles and the bubble's spot.
 *
 * Nothing here plays sound or talks to the World: sounds are asked for through `opts.sfx` and what
 * happens to the body is told through `opts.onEvent`; the page around the frame does the rest.
 */
export { createRig } from './rig.js';

export const f = n => Math.round(n * 10) / 10;
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, k) => a + (b - a) * k;
const rnd = (a, b) => a + Math.random() * (b - a);
const ease = (rate, dt) => 1 - Math.exp(-rate * dt);
const smooth = k => k * k * (3 - 2 * k);
/** 0 → 1 over [0, a] of k, holds, then back to 0 over [b, 1]: the shape of a gesture held for a moment. */
export const envelope = (k, a, b) => smooth(clamp(k / a, 0, 1)) * (1 - smooth(clamp((k - b) / (1 - b), 0, 1)));

/* ---------- legs and particles ---------- */
export const HIPS = [[104, 212], [150, 212]];
export const LEG_W = 30;
// a foot's round cap touches the ground
const FOOT_Y = 256 - LEG_W / 2;
export const STAND = HIPS.map(h => [h[0], h[1], h[0], FOOT_Y]);
export const DROP = 'M0 -9C4 -3 6 0 6 3.5A6 6 0 0 1 -6 3.5C-6 0 -4 -3 0 -9Z';
export function heartD(cx, cy, s) {
  const p = (x, y) => `${f(cx + x * s)} ${f(cy + y * s)}`;
  return `M${p(0, 14)}C${p(-7, 8)} ${p(-19, 1)} ${p(-19, -6)}C${p(-19, -15)} ${p(-8, -18)} ${p(0, -9)}C${p(8, -18)} ${p(19, -15)} ${p(19, -6)}C${p(19, 1)} ${p(7, 8)} ${p(0, 14)}Z`;
}

/* ---------- faces ----------
   What a face asks of the body and the figure: eye shapes and sizes, mouth gap, blush, marks over
   the head, particles. Coo draws these as they are; a figure with its own art reads what it can. */
const ring = o => ({ shape: 'ring', rx: 16, ry: 16, ...o });
const yawn = t => { const p = (t % 4.2) / 1.6; return p < 1 ? Math.sin(Math.PI * p) ** 2 : 0; };

export const FACES = {
  neutral:   { label: '平静', kao: '(0 0',  f: () => ({ gap: [50, 50], eyes: [ring(), ring()] }) },
  happy:     { label: '开心', kao: '(^ ^',  f: () => ({ gap: [58, 58], eyes: [{ shape: 'up' }, { shape: 'up' }], blush: .45 }) },
  wink:      { label: '眨眼', kao: '(0 ^',  f: () => ({ gap: [56, 52], eyes: [ring(), { shape: 'up' }] }) },
  love:      { label: '喜欢', kao: '(♡ ♡',  f: t => { const s = .8 + .08 * Math.sin(t * 9); return { gap: [56, 56], eyes: [{ shape: 'heart', s, sw: 8 }, { shape: 'heart', s, sw: 8 }], blush: .7, emit: 'heart' }; } },
  shy:       { label: '害羞', kao: '(o o *', f: () => ({ gap: [40, 40], eyes: [ring({ rx: 13, ry: 12, dx: -3, dy: 5 }), ring({ rx: 13, ry: 12, dx: -3, dy: 5 })], blush: 1, lookLock: true }) },
  surprised: { label: '惊讶', kao: '(O O',  f: () => ({ gap: [62, 62], eyes: [ring({ rx: 20, ry: 21 }), ring({ rx: 20, ry: 21 })], bang: true }) },
  angry:     { label: '生气', kao: '(ò ó',  f: () => ({ gap: [36, 36], eyes: [ring({ ry: 11, dy: 4 }), ring({ ry: 11, dy: 4 })], brows: 'angry', anger: true, shake: true }) },
  sad:       { label: '难过', kao: '(ó ò',  f: () => ({ gap: [34, 40], eyes: [ring({ ry: 14, dy: 4 }), ring({ ry: 14, dy: 4 })], brows: 'sad', emit: 'tear' }) },
  // a yawn narrows the eyes without squeezing them to a slit
  sleepy:    { label: '犯困', kao: '(- -',  f: t => { const y = yawn(t); return { gap: [50 + 14 * y, 50 + 14 * y], eyes: [{ shape: 'lid', ry: 10 - 5 * y }, { shape: 'lid', ry: 10 - 5 * y }] }; } },
  sleep:     { label: '睡着', kao: '(u u',  f: t => { const b = 40 + 6 * Math.sin(t * 1.7); return { gap: [b, b], eyes: [{ shape: 'down' }, { shape: 'down' }], emit: 'z' }; } },
  dizzy:     { label: '晕乎', kao: '(@ @',  f: t => ({ gap: [54 + 5 * Math.sin(t * 5), 48], eyes: [{ shape: 'spiral', rot: t * 7 }, { shape: 'spiral', rot: t * 7 + 1.4 }], orbit: true }) },
  dragged:   { label: '被拎起', kao: '(> <', f: t => { const g = 55 + 3 * Math.sin(t * 22); return { gap: [g, g], eyes: [{ shape: 'gt' }, { shape: 'lt' }], sweat: true }; } },
  // seated eyes rest open; once drowse passes .7 they are the closed sleep sprite (the shape swap hides under a blink)
  content:   { label: '惬意', f: (t, p) => { const d = p ? p.drowse : 0; const e = d > .7 ? { shape: 'down' } : { shape: 'lid', ry: 13.5 - 10 * d }; return { gap: [46, 46], eyes: [e, { ...e }] }; } },
  waking:    { label: '醒来', f: (t, p) => {
    const mt = p ? p.modeT : 1;
    const k = clamp(mt / .5, 0, 1), y = mt > .5 ? Math.sin(clamp((mt - .5) / .9, 0, 1) * Math.PI) : 0;
    const r = Math.max(0, 10 * k * (1 - .7 * y));
    return { gap: [50 + 12 * y, 50 + 12 * y], eyes: [{ shape: 'lid', ry: r }, { shape: 'lid', ry: r }] };
  } },
  squeeze:   { label: '回神', f: () => ({ gap: [44, 44], eyes: [{ shape: 'lid', ry: 0 }, { shape: 'lid', ry: 0 }] }) },
  listening: { label: '倾听', f: () => ({ gap: [44, 44], eyes: [ring({ rx: 17, ry: 18, dy: -1 }), ring({ rx: 17, ry: 18, dy: -1 })], listen: true }) },
  thinking:  { label: '思考', f: t => ({ gap: [46, 46], eyes: [ring({ rx: 14, ry: 15, dx: 3, dy: -4 }), ring({ rx: 14, ry: 15, dx: 3, dy: -4 })], think: true }) },
  run:       { label: '冲刺', f: t => { const g = 55 + 4 * Math.sin(t * 16); return { gap: [g, g], eyes: [ring(), ring()], sweat: true }; } },
  smug:      { label: '得意', kao: '(¬ ¬', f: () => ({ gap: [52, 46], eyes: [{ shape: 'lid', ry: 8, dx: 4 }, { shape: 'lid', ry: 8, dx: 4 }], blush: .25 }) },
  // `lookAt` holds the gaze (and with it a figure's head) on a point, here away from whoever is there
  pout:      { label: '嘟嘴', kao: '(o o 3', f: () => ({ gap: [28, 28], eyes: [ring({ rx: 14, ry: 13 }), ring({ rx: 14, ry: 13 })], blush: .6, lookAt: [-5, -1] }) },
  worried:   { label: '担心', kao: '(ó ò ;', f: () => ({ gap: [40, 44], eyes: [ring({ ry: 17, dy: 2 }), ring({ ry: 17, dy: 2 })], brows: 'sad', sweat: true }) },
  determined: { label: '认真', kao: '(ò ó', f: () => ({ gap: [42, 42], eyes: [ring({ ry: 13, dy: 1 }), ring({ ry: 13, dy: 1 })], brows: 'angry' }) },
  flustered: { label: '慌张', kao: '(> <;', f: t => ({ gap: [50 + 3 * Math.sin(t * 22), 48], eyes: [{ shape: 'gt' }, { shape: 'lt' }], blush: 1, sweat: true }) },
  // `wide`: eyes wider than open (a figure with drawn eyes may use its surprised ones)
  scared:    { label: '害怕', kao: '(O O;', f: () => ({ gap: [38, 38], eyes: [ring({ rx: 18, ry: 19 }), ring({ rx: 18, ry: 19 })], brows: 'sad', wide: true, shake: true, sweat: true }) },
  excited:   { label: '期待', kao: '(☆ ☆', f: () => ({ gap: [60, 60], eyes: [ring({ rx: 18, ry: 19, dy: -1 }), ring({ rx: 18, ry: 19, dy: -1 })], sparkle: true, blush: .4 }) },
  cry:       { label: '大哭', kao: '(T T', f: t => { const g = 36 + 6 * Math.abs(Math.sin(t * 9)); return { gap: [g, g], eyes: [{ shape: 'lid', ry: 0 }, { shape: 'lid', ry: 0 }], brows: 'sad', emit: 'tears', streams: true }; } },
  // a motion's own face (not one to ask for): eyes shut through a bow
  bowing:    { label: '鞠躬', f: () => ({ gap: [48, 48], eyes: [{ shape: 'lid', ry: 0 }, { shape: 'lid', ry: 0 }] }) },
  confused:  { label: '疑惑', kao: '(0 o ?', f: () => ({ gap: [44, 40], eyes: [ring(), ring({ rx: 14, ry: 11 })], question: true }) },
};

/** The faces a word can ask for, and the motions the kit does by name. */
export const KIT_EXPRESSIONS = ['neutral', 'happy', 'wink', 'love', 'shy', 'surprised', 'angry', 'sad', 'sleepy', 'thinking',
  'smug', 'pout', 'worried', 'determined', 'flustered', 'scared', 'excited', 'cry', 'confused'];
export const KIT_MOTIONS = ['stand', 'jump', 'hop', 'look', 'turn', 'nod', 'shake', 'spin', 'sit', 'sleep', 'dizzy', 'walk', 'run',
  'wave', 'bow', 'shiver', 'flap', 'dance'];
/** The tone each face plays as it comes on (the host's synthesized sounds, web/sound.js), filed as a face sound. */
const FACE_TONES = {
  happy: 'happy', wink: 'wink', love: 'love', surprised: 'surprised', angry: 'angry', sad: 'sad', shy: 'shy', sleepy: 'yawn',
  smug: 'wink', worried: 'hmm', determined: 'pop', flustered: 'shy', scared: 'surprised', excited: 'sparkle', cry: 'sad', confused: 'hmm',
};
/** Body modes in which the figure travels across the stage or squashes fast (dancing steps and sways on the spot). */
const MOVING_MODES = new Set(['drag', 'air', 'crouch', 'land', 'walk', 'run', 'dance']);
/** Points on the body in logo units, for a figure that names none: where the eyes look from, where a tear starts,
 *  where z's and hearts start ([x from, x to, y]), the bubble's spot. `tears` (one start under each eye) has no default. */
const ANCHORS = { gaze: [140, 117], tear: [166, 136], z: [196, 40], hearts: [90, 175, 34], bubble: [128, 0] };
/** The body's box in logo units, for a figure that names none (`figure.extent`), and its hit circles (`figure.hits`). */
const EXTENT = [20, 12, 236, 256];
export const DEFAULT_HITS = [[128, 128, 108]];
const DEFAULT_HALF_WIDTH = 104;
const EDGE_INSET = 8;

/* ---------- the live pet: simulation, rendering, pointer ---------- */
/**
 * `els`: { petG, shadowEl, fxG }, SVG elements the body draws into (the shadow is an ellipse).
 * `opts.bounds()` returns { W, H, floorY, S } in stage pixels.
 * `opts.onEvent(kind, detail)` reports what happened to the body: arrived, interrupted, touch, mode, done.
 * `opts.sfx.play(name, kind, ...args)` asks for a sound (web/sound.js names them); an `sfx` without `play`
 * is called by name instead (`sfx.jump()`), for pages that record the calls.
 * `opts.startX` and `opts.startFacing` (1 right, -1 left) are where the pet first stands and which way it faces.
 * `opts.enter: 'drop'` starts the pet above the top edge, falling to the floor.
 * `opts.ground: 'free'` lets the body stand anywhere on the stage above the floor, as seen from above: it walks
 * to any point (`walkTo` with a y), is set down where it is let go of, a throw tosses it across the stage, and
 * free roaming wanders both ways. Its own ground line (where its feet are) then starts at `opts.startY`, else the floor.
 * `opts.words` are the pack's own words, beyond the kit's (KIT_EXPRESSIONS, KIT_MOTIONS):
 *   `{ id: { expression: { like, seconds?, sound? } } }` holds a face that takes its eyes and marks from the kit's
 *   face `like` (the figure gets the word as `frame.face` and may draw it its own way);
 *   `{ id: { motion: { seconds, face?, sound? } } }` is a gesture the figure draws from `frame.gesture`.
 * `opts.figure` draws the body: `figure.draw(petG, face, frame)` keeps its own elements inside `petG` (logo space,
 * feet at y=256), once for every frame drawn, rest included, so it should write only what changed. Its frame adds
 * the face's name, the mode, how long the mode has run, the talk level, drowsiness, how far the body sits, and
 * `status`: the kind of work the page's status bubble shows (src/status.ts), or null.
 * `figure.groupTilt(mode, tilt, lean)`, if present, returns the rotation (degrees) the whole group gets
 * instead of tilt + lean; the frame carries tilt, lean and that rotation (groupRot) so the figure can bend the rest.
 * `figure.colors.z`, if present, colours the sleep z's (otherwise they take the `eye` class).
 * `figure.gestures`, if present, names the short gestures (nod, shake) the figure draws itself: the body then
 * leaves them out, and the frame's `gesture` ({ kind, k: 0..1 }, or null) says which one is playing and how far.
 * `figure.anchors`, `figure.extent` ([x0, y0, x1, y1]) and `figure.hits` ([[x, y, r]]) are in logo units; each
 * is read every frame, so a getter may follow the skin. `extent` is the body facing right, mirrored about x=128
 * when it faces left; each side comes as near the screen edge as `extent` reaches on it.
 * `figure.setSkin(skin)` hears each skin change.
 */
export function createPet(els, opts) {
  const { petG, shadowEl, fxG } = els;
  let custom = opts.figure;
  custom.kitHearts = () => { for (let i = 0; i < 4; i++) emitHeart(); };   // emitHeart 函数声明提升，此处可用
  const sfx = opts.sfx;
  const play = (name, kind, ...args) => (sfx.play ? sfx.play(name, kind, ...args) : sfx[name]?.(...args));
  const onEvent = opts.onEvent || (() => {});
  custom.emitEvent = (kind, d) => onEvent(kind, d);   // figure 自己发的事件（彩蛋台词等）走同一条上报路
  const words = opts.words || {};
  let W = 0, H = 0, floorY = 0, S = .42, T = 0;
  let roam = opts.roam ?? 'free';
  let skin = opts.skin || null;
  let hold = 0; // until T: an order from outside is in progress, free roaming waits
  const freeGround = opts.ground === 'free';
  const startFacing = opts.startFacing === -1 ? -1 : 1;
  const pet = {
    x: 260, fy: 0, gy: 0, gvy: 0, targetY: 0, vx: 0, vy: 0, facing: startFacing, faceVis: startFacing, mode: 'idle', modeT: 0, dur: 0, target: 0,
    speed: 0, stride: 0, lift: 0, bob: 0, phase: 0, lastHalf: 0, lean: 0, tilt: 0, tiltV: 0,
    sq: 0, sqv: 0, sitK: 0, stretch: 0, low: 0, gap: [50, 50], look: [0, 0], drowse: 0,
    feet: STAND.map(l => [l[2], l[3]]), blinkT: 1.5, blinkAge: 9, expr: null, exprUntil: 0,
    nextAt: 1.2, emitAt: 0, airKind: 'jump', turned: false, startle: false, lastAct: '',
    turnAcc: 0, dx: 0, dy: 0, jumpV: 700, jumpVx: 0, xf: null, blushK: 0,
    eyeSig: '', eyeCur: null, eyePrev: null, eyeDims: [[16, 16, 0, 0], [16, 16, 0, 0]], swapAge: 9,
    glance: [0, 0], glanceAt: 0, swing: 0, swingV: 0, prevA: null, prevAY: null, velX: 0, velY: 0, talkK: 0, sfxAt: 0, skid: false, cue: 0,
    pulse: null, walkId: 0, walkWord: null, listening: false, thinking: false, thoughtShown: false, placed: false, noteAt: 0, tearN: 0,
    cursor: '', status: null,
  };
  const pointer = { x: -1e4, y: -1e4, inside: false, vx: 0, vy: 0, samples: [] };
  let press = null, strokeAcc = 0, petCool = 0;
  // ===== 4.2 rua 摸头（参考他们家 PetWindow.Touch.cs）=====
  let ruaDown = false, ruaLast = null, ruaVel = { x: 0, y: 0 }, ruaTravel = 0;
  let ruaHeadTime = 0, ruaDeepTime = 0, ruaMax = 0, ruaTier = 0, ruaStillAt = 0, ruaMelted = false;
  let rua = null;   // 活跃时每帧传给形象：{ ux, uy, side, face, seconds, melt, moving, fx }
  let ruaLingerAt = 0;   // 1.5 秒宽限开始时刻（手离开头区/停下时）
  let lastRuaAt = -9;    // 最近一次 rua 活动（crash 抑制用）
  /** Whether the last frame found the horizontal speed not finite: a run of such frames is logged once. */
  let velXBad = false;
  const P = [];
  const anchors = () => ({ ...ANCHORS, ...custom?.anchors });
  let A = anchors();
  const figureExtent = () => {
    const e = custom?.extent;
    if (!e || !Number.isFinite(e[0]) || !Number.isFinite(e[1]) || !Number.isFinite(e[2]) || !Number.isFinite(e[3])
      || e[0] > e[2] || e[1] > e[3]) return null;
    return e;
  };
  /**
   * How far the body reaches left and right of the line it turns about (x=128) when facing `face`, in logo units:
   * the turn mirrors `extent` about that line, so the two sides trade places as `faceVis` goes from 1 to -1.
   */
  const sideReach = (e = figureExtent(), face = pet.faceVis) => {
    if (!e) return [DEFAULT_HALF_WIDTH, DEFAULT_HALF_WIDTH];
    const a = (e[0] - 128) * face, b = (e[2] - 128) * face;
    return [-Math.min(a, b), Math.max(a, b)];
  };
  /** The wider of the body's two sides, in logo units. */
  const halfWidth = (e = figureExtent()) => Math.max(...sideReach(e, 1));
  /** Where the body's middle may stand facing `face` (as it faces now when left out); a body wider than the stage stands in its middle. */
  const minX = (face) => Math.min(W / 2, sideReach(undefined, face)[0] * S + EDGE_INSET);
  const maxX = (face) => Math.max(W / 2, W - sideReach(undefined, face)[1] * S - EDGE_INSET);
  /** Where a walk toward stage x may end, for the way the body faces on that walk (see the walk step). */
  const walkEnd = (x) => {
    const face = !freeGround || Math.abs(x - pet.x) > 2 ? Math.sign(x - pet.x) || pet.facing : pet.facing;
    return clamp(x, minX(face), maxX(face));
  };
  /** The highest ground line a free body stands on: its head stays on the stage. */
  const minY = () => Math.min(floorY, 250 * S + 8);
  /** Where the feet rest: the floor, or a free body's own ground line. */
  const groundY = () => (freeGround ? pet.gy : floorY);
  /** Detail for a walk's events: a free body says how far down it stands. */
  const at = () => ({ x: Math.round(pet.x), ...(freeGround ? { y: Math.round(pet.gy) } : {}) });
  const faceDef = n => FACES[n] ?? FACES[words[n]?.expression?.like] ?? FACES.neutral;

  function resize() {
    const b = opts.bounds();
    W = b.W; H = b.H; floorY = b.floorY; S = b.S;
    if (!pet.placed && W > 0) {
      pet.x = opts.startX != null ? opts.startX : W * .7; pet.placed = true;
      pet.gy = freeGround && opts.startY != null ? opts.startY : floorY;
      if (opts.enter === 'drop') { pet.fy = -8; pet.vy = 0; pet.vx = 0; pet.airKind = 'drop'; setMode('air'); }
    }
    pet.x = clamp(pet.x, minX(), maxX());
    pet.target = walkEnd(pet.target);
    pet.gy = freeGround ? clamp(pet.gy, minY(), floorY) : floorY;
    pet.targetY = freeGround ? clamp(pet.targetY, minY(), floorY) : floorY;
    if (pet.mode !== 'air' && pet.mode !== 'drag') pet.fy = pet.gy;
  }

  function toStage(lx, ly) {
    const c = pet.xf;
    if (!c) return { x: pet.x, y: groundY() };
    const x = (lx - c.ax) * c.kx, y = (ly - c.ay) * c.ky, r = c.rot * Math.PI / 180;
    return { x: c.AX + x * Math.cos(r) - y * Math.sin(r), y: c.AY + x * Math.sin(r) + y * Math.cos(r) };
  }
  function stageBox(e) {
    const x0 = e[0], y0 = e[1], x1 = e[2], y1 = e[3];
    const corners = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map(([x, y]) => toStage(x, y));
    const xs = corners.map((p) => p.x), ys = corners.map((p) => p.y);
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  }
  /** The hit circles in stage pixels. */
  function hits() {
    return (custom?.hits ?? DEFAULT_HITS).map(([x, y, r]) => ({ ...toStage(x, y), r: r * S }));
  }
  function hitPet(p) {
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
    // 2026-11-22：上下限照他们的定时器 clamp(.001,.05)。
    // 下限原来是 .016 —— 那是「一帧」，但 stepRua 是每个 pointermove 调一次，
    // 高回报率鼠标 1~2ms 一个事件，全被抬到 16ms，rua 15 秒被算成 25 秒（1.67 倍）。
    // 上限 .05 保留：鼠标停住再动，不该把停顿算成在摸。
    const dt = Math.min(.05, Math.max(0, (t - ((ruaLast && ruaLast.t) || t)) / 1000));
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
    // 2026-11-22 用户：左右摆得比他们大得多。之前 *.35 等于 2.86 倍增益（当时为了脸上小范围也能动），
    // 但 touchZones.rx 本身虚高（实测 205，真实头半宽约 125），再放大就一碰就顶到极限。改回 .75。
    // 2026-11-23 用户：rua 到右脸要闭右眼、摸脸中间要双眼闭 —— 现在都不行。
    // 根因：side / face 判定和「头角度摆动幅度」共用了一个带 .75 增益的 ux（那个增益是为了
    // 压左右摆幅），结果侧向阈值被一起调迟钝。他们把两件事分得很清楚：
    //   ux = clamp((x-hx)/rx)  ← 没有增益，头边缘 = ±1，side .65 就在这个尺度上
    // 所以这里恢复他们的口径：uxRaw 给 side/face，ux（打折后的）只给头角度。
    const uxRaw = Math.max(-1.3, Math.min(1.3, (p.x - c.x) / headRx));
    const ux = Math.max(-1.3, Math.min(1.3, uxRaw / .75));   // 驱动头角度：我们 touchZones.rx 虚高，打折
    const uy = Math.max(-1.3, Math.min(1.3, (p.y - c.y) / headRy));
    if (t - (globalThis.__ruaDbg ?? 0) > 2000) { globalThis.__ruaDbg = t; try { new Image().src = '/api/figure-log?m=' + encodeURIComponent('rua p=' + Math.round(p.x) + ',' + Math.round(p.y) + ' c=' + Math.round(c.x) + ',' + Math.round(c.y) + ' uxRaw=' + uxRaw.toFixed(2) + ' uy=' + uy.toFixed(2) + ' side=' + rua.side + ' face=' + rua.face + ' on=' + onHead + ' rx=' + Math.round(headRx) + ' ry=' + Math.round(headRy)); } catch {} }
    if (engaged && !rua) { rua = { ux: 0, uy: 0, side: 0, face: false, seconds: 0, melt: 0, moving: false, fx: 0 }; onEvent('touch', { kind: 'rua-start', hx: c.x, hy: c.y, rx: headRx, ry: headRy }); }
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
    rua.speed = speed;   // 2026-11-22：真实手速（px/s），猛摸瞪眼用它判定
    // 档位：3s 轻摸（脸红）→ 8s 温柔（眉眼软）→ 20s 融化；升档发事件；8s 后每 2.5s 一次「还在摸」
    const tier = rua.melt >= 1 ? 3 : ruaHeadTime >= 8 ? 2 : ruaHeadTime >= 3 ? 1 : 0;
    if (tier > ruaTier) {
      ruaTier = tier;
      onEvent('touch', { kind: 'rua-tier', tier, seconds: Math.max(rua.seconds, ruaMax) });   // 用峰值：headTime 会衰减，直接发会倒退
      ruaStillAt = t + (ruaTier >= 3 || tier >= 3 ? 5500 : 2500);
    } else if (ruaTier >= 2 && t > ruaStillAt) {
      ruaStillAt = t + (ruaTier >= 3 || tier >= 3 ? 5500 : 2500);
      onEvent('touch', { kind: 'rua-still', tier: ruaTier, seconds: Math.max(rua.seconds, ruaMax) });   // 峰值，防倒退
    }
    lastRuaAt = T;   // 秒（T 是同单位）；别写 now(p)，那是毫秒
    // 2026-11-22 用户：1.5 秒宽限不要了 —— 手离开头区就算了，只在松手时结算。
  }
  /** rua 结算：按总时长四档发结束事件（失落 <3s / 不舍 3~8 / 腻歪 8~20 / 融化 20+）。返回是否真的结束了一场 rua。 */
  function endRua() {
    if (!ruaDown) return false;
    ruaDown = false;
    const held = Math.round(ruaMax * 10) / 10;
    // 摸后 mood 还在演：按档位压住闲时动作（融化 6s+0.8s 空档，留一点余量）
    pet.idleHoldUntil = T + (ruaMelted ? 25 : held >= 8 ? 20 : held >= 3 ? 15 : 10);
    const tier = ruaMelted ? 3 : held >= 8 ? 2 : held >= 3 ? 1 : 0;
    onEvent('touch', { kind: 'rua-end', tier, seconds: held });
    rua = null; ruaMax = 0; ruaTier = 0; ruaMelted = false;
    press = null;   // press 一并清掉：残留会让下一次移动被当成拖拽（2026-11-20 用户实测）
    petCool = Math.max(petCool, 3);   // 抑制原生划过摸头反应：否则 setExpr(shy) 半眯眼残留（2026-11-20）
    return true;
  }

  function setMode(m, o = {}) {
    const prev = pet.mode;
    // an arrival clears walkId before going idle, so anything else that ends a walk (a turn, a bow, listening) cuts it short
    if ((prev === 'walk' || prev === 'run') && pet.walkId) {
      onEvent('interrupted', { walkId: pet.walkId, ...at(), by: m });
      pet.walkId = 0;
    }
    // a walk or run asked for as a word is done once the body stops going, whatever stopped it
    if ((prev === 'walk' || prev === 'run') && pet.walkWord && m !== prev) { onEvent('done', { word: pet.walkWord }); pet.walkWord = null; }
    pet.mode = m; pet.modeT = 0; pet.turned = false; pet.startle = false; pet.skid = false; pet.cue = 0;
    Object.assign(pet, o);
    if (prev !== m) onEvent('mode', { mode: m });
  }
  const busy = () => pet.mode === 'drag' || pet.mode === 'air' || pet.mode === 'crouch';
  function pickTarget(minDist) {
    for (let i = 0; i < 12; i++) {
      const x = walkEnd(rnd(minX(-1), maxX(1)));
      if (Math.abs(x - pet.x) > minDist) return x;
    }
    return pet.x - minX(-1) > maxX(1) - pet.x ? minX(-1) : maxX(1);
  }
  /** A ground line to walk to: anywhere for a free body, else where it stands. */
  const pickY = () => (freeGround ? rnd(minY(), floorY) : pet.gy);

  /** Runs a motion. Returns false when the body cannot take it now (in the air, being dragged). */
  function act(a) {
    if (busy()) return false;
    pet.expr = null; pet.lastAct = a;
    const seated = pet.mode === 'sleep' || pet.mode === 'sit';
    switch (a) {
      case 'stand': setMode(seated ? 'wake' : 'idle', seated ? { startle: false } : {}); pet.nextAt = T + 3; break;
      case 'walk': setMode('walk', { target: pickTarget(160), targetY: pickY() }); break;
      case 'run': setMode('run', { target: pet.x < W / 2 ? maxX(1) - rnd(0, 30) : minX(-1) + rnd(0, 30), targetY: pickY() }); break;
      case 'jump': setMode('crouch', { jumpV: 720, jumpVx: pet.facing * 40 }); break;
      case 'hop': setMode('crouch', { jumpV: 480, jumpVx: 0 }); break;
      case 'look': setMode('look'); break;
      case 'turn': if (!seated) setMode('idle'); pet.facing *= -1; play('tick', 'move'); break;
      case 'nod': pulse('nod', .7); play('nod', 'move'); break;
      case 'shake': pulse('shake', .7); play('shake', 'move'); break;
      case 'spin': if (!seated) setMode('idle'); pulse('spin', .6); play('spin', 'move'); break;
      case 'sit': setMode('sit', { dur: 1e9, willSleep: false }); break;
      case 'sleep': setMode('sleep', { dur: 1e9 }); break;
      case 'dizzy': setMode('dizzy'); break;
      case 'wave': pulse('wave', 1.6); break;   // actFaceSkip：挥手不附带 happy 脸（Live2D 的脸由词/弧度管）
      case 'bow': if (!seated) setMode('idle'); pulse('bow', 1.6); play('tick', 'move'); break;   // actFaceSkip
      case 'shiver': pulse('shiver', 1.8); play('shiver', 'move'); break;
      case 'flap': setMode('crouch', { jumpV: 540, jumpVx: 0 }); pulse('flap', 1.4); play('chirps', 'move'); break;   // actFaceSkip
      case 'dance': setMode('dance', { dur: 3.2 }); play('dance', 'move'); break;   // actFaceSkip
      default: {
        // a gesture of the pack's own, drawn by its figure from frame.gesture
        const m = words[a]?.motion;
        if (!m) return false;
        if (!seated) setMode('idle');
        pulse(a, m.seconds);
        if (m.face) holdFace(m.face, m.seconds);
        if (m.sound) play(m.sound, 'move');
      }
    }
    return true;
  }
  function pulse(kind, dur) { pet.pulse = { kind, t0: T, dur }; }
  /** A motion's own face, without the expression's sound and bounce (act() has just cleared any held face). */
  function holdFace(n, seconds) { pet.expr = n; pet.exprUntil = T + seconds; pet.nextAt = Math.max(pet.nextAt, pet.exprUntil + .6); }

  function setExpr(n, seconds) {
    if (n === 'sleep') { act('sleep'); return; }
    if (busy()) return;
    if (n === 'dragged') {
      pet.expr = null;
      pet.vy = -1150; pet.vx = rnd(-120, 120); pet.airKind = 'throw'; pet.sqv -= 3;
      play('whoosh', 'move'); play('jump', 'move');
      setMode('air'); return;
    }
    if (n === 'dizzy') { pet.expr = null; setMode('dizzy'); return; }
    if (pet.mode === 'look' || pet.mode === 'land') setMode('idle');
    const own = words[n]?.expression;
    pet.expr = n; pet.exprUntil = T + (seconds ?? own?.seconds ?? (n === 'sleepy' ? 4.4 : 3.2));
    pet.nextAt = Math.max(pet.nextAt, pet.exprUntil + .6);
    pet.sqv += n === 'surprised' ? -2.2 : .8;
    const tone = own?.sound ?? FACE_TONES[n];
    if (tone) play(tone, 'face');
    if (n === 'love') for (let i = 0; i < 4; i++) emitHeart();
  }

  /**
   * Does a word of the body's vocabulary: one of the kit's faces or motions, or one of the pack's own
   * (`opts.words`). A walk or run goes to the other side of the stage and reports `done` once it stops.
   * Returns false for a word it does not know or cannot take now.
   */
  function doWord(w, o) {   // o：闲时调度透传（{idle:true, life:秒}），对话词不传
    const orig = w;
    // rua-word-admission-v1: consume rejected words before parser side effects or kit extras.
    if (custom?.allowWord?.(w, o, !!rua) === false) return true;
    const base = custom?.baseWord?.(w, o);
    if (base) w = base;
    if (custom?.actWord?.(w, null, o)) {
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
    }
    if (w === 'neutral') { setExpr('neutral', .1); return true; }
    if (w === 'walk' || w === 'run') {
      const x = pet.x < W / 2 ? W * (.55 + Math.random() * .35) : W * (.1 + Math.random() * .35);
      if (!walkTo(x, w === 'run', 0, pickY())) return false;
      if (pet.mode === w) pet.walkWord = w;
      else onEvent('done', { word: w });
      return true;
    }
    if (KIT_MOTIONS.includes(w) || words[w]?.motion) return act(w);
    if (KIT_EXPRESSIONS.includes(w) || words[w]?.expression) {
      if (busy()) return false;
      setExpr(w);
      return true;
    }
    return false;
  }

  /**
   * Walks (or runs) to stage x, and for a free body to ground line y (where it stands now when left out).
   * Resolves the walk through onEvent('arrived' | 'interrupted').
   */
  function walkTo(x, run, walkId, y) {
    if (busy()) return false;
    if (pet.mode === 'sleep' || pet.mode === 'sit') setMode('wake', { startle: true });
    const target = walkEnd(x);
    const targetY = freeGround && typeof y === 'number' && Number.isFinite(y) ? clamp(y, minY(), floorY) : pet.gy;
    pet.expr = null;
    if (Math.hypot(target - pet.x, targetY - pet.gy) < 2) { onEvent('arrived', { walkId, ...at() }); return true; }
    setMode(run ? 'run' : 'walk', { target, targetY, walkId });
    return true;
  }

  /** Stops the walk `walkId` where the pet stands; it reports the walk 'interrupted'. A finished walk is left alone. */
  function stopWalk(walkId) {
    if ((pet.mode === 'walk' || pet.mode === 'run') && pet.walkId === walkId) setMode('idle');
  }

  function faceName() {
    const m = pet.mode;
    if (m === 'drag') return 'dragged';
    if (m === 'air' && pet.airKind === 'throw') return pet.vy < 0 ? 'dragged' : 'surprised';
    if (m === 'air' && pet.airKind === 'drop') return 'surprised';
    if (m === 'dizzy') return pet.modeT < 2.4 ? 'dizzy' : 'squeeze';
    if (m === 'wake') return pet.startle ? 'surprised' : 'waking';
    if (pet.listening && m !== 'sleep') return 'listening';
    if (m === 'sleep') return 'sleep';
    if (pet.expr && T < pet.exprUntil) return pet.expr;
    if (pet.thinking) return 'thinking';
    if (m === 'sit') return 'content';
    if (m === 'run') return 'run';
    return 'neutral';
  }

  function decide() {
    if (custom?.musicActive?.()) return;   // 听歌时不做随机漫游/待机（小剧场也在 idle 池里）
    if (ruaDown) return;   // rua 期间不做闲时动作（他们 behavior.Touching = true）
    if (T < (pet.idleHoldUntil ?? 0)) return;   // rua 刚结束：摸后 mood 还在演，别插动作
    const calm = roam === 'calm';
    const opts2 = [['walk', calm ? 10 : 28], ['run', calm ? 0 : 12], ['look', 14], ['jump', calm ? 2 : 8], ['sit', 6], ['idle-word', T >= (pet.idleWordAt ?? 0) ? 25 : 0], ['wait', calm ? 40 : 10]]   // 3.9a 多待着：发呆权重上调
      .filter(o => o[1] > 0 && (o[0] !== pet.lastAct || o[0] === 'wait'));
    let r = Math.random() * opts2.reduce((a, o) => a + o[1], 0), pick = 'wait';
    for (const o of opts2) { if ((r -= o[1]) < 0) { pick = o[0]; break; } }
    if (pick === 'look') { setMode('look'); pet.lastAct = 'look'; }
    else if (pick === 'idle-word') {   // 3.9 统一闲时池：表情+小动作归形象包管（kit 原六张脸已收编进池子）
      const pool = custom?.idlePool?.() ?? [];
      const total = pool.reduce((a, m) => a + (m.w ?? 1), 0);
      let r2 = Math.random() * total, pick2 = pool[pool.length - 1];
      for (const m of pool) { r2 -= (m.w ?? 1); if (r2 <= 0) { pick2 = m; break; } }
      const word = typeof pick2 === 'object' ? pick2.word : pick2;
      pet.idleWordAt = T + rnd(25, 50);   // 冷却先记上：词被拒（busy）也不连着掷。2026-11-20 用户反馈随机动作难触发，40~80 → 25~50（对齐旧待机换手节奏）
      if (word) doWord(word, { idle: true, life: pick2.life });
      pet.lastAct = 'idle-word';
    }
    // a sit she chose decides up front whether it ends in sleep, so she only gets drowsy when she will fall asleep
    else if (pick === 'sit') { setMode('sit', { dur: rnd(6, 9), willSleep: Math.random() < .18 }); pet.lastAct = 'sit'; }
    else if (pick !== 'wait') act(pick);
    if (pet.mode === 'idle' && T >= pet.nextAt) pet.nextAt = T + (calm ? rnd(5, 10) : rnd(2, 4));   // 3.9a calm 掷骰放缓：原节奏的 2.5 倍（6~14 试过太安静，2026-11-20 用户定）
  }

  /* particles */
  function emit(type, p, o = {}) { P.push({ type, x: p.x, y: p.y, vx: 0, vy: 0, age: 0, life: 1, ...o }); }
  function emitHeart() {
    emit('heart', toStage(rnd(A.hearts[0], A.hearts[1]), A.hearts[2] + pet.low), { vx: rnd(-20, 20), vy: rnd(-70, -45), life: 1.6 });
  }
  function dustAt(lx, n, spread) {
    for (let i = 0; i < n; i++) {
      emit('dust', toStage(lx, 250), { vx: rnd(-spread, spread) - pet.facing * rnd(10, 40), vy: rnd(-30, -8), life: rnd(.4, .65) });
    }
  }

  function step(dt) {
    // a frame that took no time has nothing to advance, and the horizontal speed below divides by its length
    if (!(dt > 0 && dt < Infinity)) return;
    T += dt; pet.modeT += dt;
    A = anchors();
    // 悬停：鼠标停在某个部位上、不按不拖，**10 秒**后演一条轻微反应（他们 Behavior.cs:70-75）。
    // 10 秒 / 30 秒冷却照 PetWindow.Touch.cs:478（HoverAfter=10s, HoverCooldown=30s）。
    // 2026-11-23 23:35 用户实测：原来写 0.45 秒太容易触发 —— 想戳一下，戳之前就先被 hover 演了一遍。
    // 只在没有按键、没在摸头时算；一按下就归零重计，所以「戳」永远不会先触发悬停。
    {
      const hz = pointer.inside && !press && !ruaDown ? (zoneAt(pointer) ?? null) : null;
      if (hz && hz === pet.hoverZone) {
        pet.hoverT = (pet.hoverT ?? 0) + dt;
        if (pet.hoverT >= 10 && !pet.hoverFired && T > (pet.hoverCool ?? 0)) {
          pet.hoverFired = 1; pet.hoverCool = T + 30; custom?.hover?.(hz);
        }
      } else { pet.hoverZone = hz; pet.hoverT = 0; pet.hoverFired = 0; }
    }
    const m = pet.mode, mt = pet.modeT;
    // an extent that follows the skin, or a lopsided body turning round, can widen the body where it stands; carried and flying bodies keep to the edges on their own
    if (m !== 'drag' && m !== 'air') { pet.x = clamp(pet.x, minX(), maxX()); pet.target = walkEnd(pet.target); }
    let sqT = 0, strideT = 0, liftT = 0, leanT = 0, sitT = 0, bobT = 0, rate = 0, lookT = [0, 0], tiltT = 0;
    let tk = 160, tc = 12, drowseT = 0;
    const still = !!opts.still?.();
    // 3.9 忙闸门补「鼠标在碰我」：人正在跟她互动，她不该自己加戏。
    // 气泡还在显示/有工具在跑（holdRoam 20）/对话框开着 kit 原本就有，这里只补触摸这一项。
    const touching = pointer.inside && (press || ruaDown || hitPet(pointer));
    const free = roam !== 'off' && T > hold && !opts.dialogOpen?.() && !still && !touching;

    pet.blinkT -= dt; pet.blinkAge += dt;
    if (pet.blinkT <= 0) { pet.blinkAge = 0; pet.blinkT = Math.random() < .2 ? .28 : rnd(2.2, 5.2); }

    const head = toStage(A.gaze[0], A.gaze[1]);
    const pdx = pointer.x - head.x, pdy = pointer.y - head.y, pm = Math.hypot(pdx, pdy) || 1;
    const track = () => {
      if (!pointer.inside) {
        if (T > pet.glanceAt) { pet.glance = Math.random() < .45 ? [0, 0] : [rnd(-3, 5), rnd(-3, 3)]; pet.glanceAt = T + rnd(1.2, 3); }
        return pet.glance;
      }
      // 2026-11-21 完全对齐 DeepFish（PetWindow.cs 940行）：
      //   x = clamp((cursor.X - headX) / 500, -1, 1)
      //   y = clamp((headY - cursor.Y) / 400, -1, 1)
      // 他们用**固定像素 500/400**（几乎半个屏幕的范围）——鼠标越远影响越大。之前用形象宽/头半径都太窄，稍远就饱和。
      const _px0 = Math.max(-1, Math.min(1, (pointer.x - head.x) / 500));
      const _py0 = Math.max(-1, Math.min(1, (head.y - pointer.y) / 400));
      return [_px0 * 5 * pet.facing, _py0 * 4];
    };

    switch (m) {
      case 'idle': {
        lookT = track();
        if (!custom?.noMirror && pointer.inside && !press && pdx * pet.facing < -50 && pm < 600) {
          pet.turnAcc += dt;
          if (pet.turnAcc > .9) { pet.facing *= -1; pet.turnAcc = 0; }
        } else pet.turnAcc = 0;
        if (pet.listening) { lookT = [3, -4]; tiltT = -7; leanT = -2; }
        if (free && !pet.listening && T > pet.nextAt && !(pet.expr && T < pet.exprUntil)) decide();
        break;
      }
      case 'walk': case 'run': {
        // held still: the walk waits where it is, standing, and goes on once released
        if (still) { pet.speed = 0; lookT = track(); break; }
        const run = m === 'run', d = pet.target - pet.x, dy = pet.targetY - pet.gy, dist = Math.hypot(d, dy), dir = Math.sign(d) || pet.facing;
        // a free body walking up or down the stage keeps the way it faces
        if (!freeGround || Math.abs(d) > 2) pet.facing = dir;
        const vMax = run ? 250 : 78;
        const vT = Math.min(vMax, run ? dist * 4 + 20 : dist * 3 + 14);
        strideT = run ? 17 : 10; liftT = run ? 15 : 8; bobT = run ? 7 : 3; rate = run ? 4.4 : 2.1;
        leanT = run ? (dist < 50 && pet.speed > 120 ? -6 : 11) : 4;
        if (leanT < 0 && !pet.skid) { pet.skid = true; play('skid', 'move'); }
        const ramp = Math.min(1, mt / (run ? .35 : .25));
        pet.speed = lerp(pet.speed, vT * smooth(ramp), ease(run ? 6 : 9, dt));
        const go = Math.min(dist, pet.speed * dt);
        if (dist > 0) { pet.x += d / dist * go; pet.gy += dy / dist * go; pet.fy = pet.gy; }
        const k = clamp(pet.speed / vMax, 0, 1);
        strideT *= .4 + .6 * k; liftT *= .4 + .6 * k;
        pet.phase += Math.PI * 2 * rate * dt * Math.max(.35, k);
        lookT = [run ? 4 : 3, run ? 1 : 0];
        const half = Math.floor(pet.phase / Math.PI);
        if (half !== pet.lastHalf) {
          play('step', 'move', run, half & 1);
          if (run && pet.speed > 120) dustAt(128, dist < 50 ? 3 : 1, 20);
        }
        pet.lastHalf = half;
        if (dist < 1.5) {
          pet.speed = 0;
          const id = pet.walkId; pet.walkId = 0;
          setMode('idle'); pet.nextAt = T + rnd(1.2, 3.2);
          if (id) onEvent('arrived', { walkId: id, ...at() });
        }
        break;
      }
      case 'look': {
        if (!pet.cue) { pet.cue = 1; play('look', 'move'); }
        if (mt < .9) lookT = [4, -4];
        else if (mt < 1.8) { if (!pet.turned && !custom?.noMirror) { pet.turned = true; pet.facing *= -1; } lookT = [5, 0]; }
        else if (mt < 2.6) lookT = [1, 4];
        else { setMode('idle'); pet.nextAt = T + rnd(1, 2.5); }
        break;
      }
      case 'sit': {
        sitT = 1;
        lookT = track().map(v => v * (1 - pet.drowse));
        if (pet.listening) { lookT = [3, -4]; tiltT = -7; }
        // awake while sitting; a sit that ends in sleep closes over its last ~1.6s; a held sit (the word) never dozes off
        drowseT = pet.willSleep && free ? clamp((mt - (pet.dur - 1.6)) / 1.2, 0, 1) : .15;
        if (pet.drowse > .5) leanT = 7 * pet.drowse * Math.pow(Math.max(0, Math.sin(T * 1.3)), 6);
        if (free && mt > pet.dur) {
          if (pet.willSleep) setMode('sleep', { dur: rnd(4, 6) });
          else { setMode('idle'); pet.sqv -= 1.2; pet.nextAt = T + rnd(1.5, 3); }
        }
        break;
      }
      case 'sleep': {
        sitT = 1; drowseT = 1; leanT = 5;
        if (free && mt > pet.dur) setMode('wake');
        break;
      }
      case 'wake': {
        if (pet.startle) {
          sitT = 0; lookT = [3, -2];
          if (mt > .9) { setMode('idle'); pet.nextAt = T + rnd(1.5, 3); }
        } else {
          sitT = mt < 1.1 ? 1 : 0;
          if (mt > .5 && !pet.cue) { pet.cue = 1; play('yawn', 'face'); }
          sqT = mt > .5 && mt < 1.3 ? -.1 : 0;
          leanT = mt < .5 ? 5 : mt < 1.2 ? -5 : 0;
          lookT = mt > 1.2 ? track() : [0, 0];
          if (mt > 1.8) { setMode('idle'); pet.nextAt = T + rnd(1, 2); }
        }
        break;
      }
      case 'crouch': {
        sqT = .24; sitT = .3;
        if (mt > .16) {
          pet.vy = -pet.jumpV; pet.vx = pet.jumpVx; pet.airKind = 'jump'; pet.sqv -= 2.6;
          play('jump', 'move');
          setMode('air');
        }
        break;
      }
      case 'air': {
        pet.vy += 2300 * dt;
        pet.vx *= Math.exp(-dt * .4);
        pet.x += pet.vx * dt; pet.fy += pet.vy * dt;
        // a free body tossed across the stage: its ground line slides with the throw and slows
        if (freeGround && pet.gvy) {
          pet.gvy *= Math.exp(-dt * 1.2);
          pet.gy += pet.gvy * dt; pet.fy += pet.gvy * dt;
          if (pet.gy < minY()) { pet.fy += minY() - pet.gy; pet.gy = minY(); pet.gvy = Math.abs(pet.gvy) * .55; pet.sqv += .6; }
          if (pet.gy > floorY) { pet.fy -= pet.gy - floorY; pet.gy = floorY; pet.gvy = -Math.abs(pet.gvy) * .55; pet.sqv += .6; }
        }
        if (pet.x < minX()) { pet.x = minX(); pet.vx = Math.abs(pet.vx) * .55; pet.sqv += .6; }
        if (pet.x > maxX()) { pet.x = maxX(); pet.vx = -Math.abs(pet.vx) * .55; pet.sqv += .6; }
        if (pet.fy - 250 * S < 0 && pet.vy < 0) { pet.fy = 250 * S; pet.vy = Math.abs(pet.vy) * .3; }
        sqT = -Math.min(.12, Math.abs(pet.vy) / 6000);
        tiltT = clamp(pet.vx * .025, -30, 30);
        tk = 70; tc = 8;
        if (pet.fy >= pet.gy && pet.vy > 0) land();
        break;
      }
      case 'land': {
        sitT = .35 * (1 - smooth(clamp(mt / .35, 0, 1)));
        lookT = [2, 2];
        if (mt > .4) setMode('idle');
        break;
      }
      case 'dizzy': {
        sitT = mt < 2.6 ? 1 : 0;
        if (mt < 2.4 && T > pet.sfxAt) { play('chirps', 'move'); pet.sfxAt = T + .9; }
        if (mt >= 2.4 && !pet.cue) { pet.cue = 1; play('shake', 'move'); }
        if (mt < 2.4) tiltT = 8 * Math.sin(T * 4.5) * Math.min(1, mt * 2);
        else if (mt < 3) { const k = (mt - 2.4) / .6; tiltT = 12 * Math.sin(mt * 34) * (1 - k); }
        else { setMode('idle'); pet.sqv -= 1; pet.nextAt = T + rnd(1.5, 3); }
        break;
      }
      case 'dance': {
        // a little two-step on the spot: the feet take turns, the body sways with them, notes float up
        strideT = 5; liftT = 10; bobT = 3;
        pet.phase += Math.PI * 2 * 1.1 * dt;
        tiltT = 7 * Math.sin(pet.phase);
        lookT = [3, -2];
        const half = Math.floor(pet.phase / Math.PI);
        if (half !== pet.lastHalf) play('step', 'move', false, half & 1);
        pet.lastHalf = half;
        if (T > pet.noteAt) { emit('note', toStage(A.z[0], A.z[1] + pet.low), { vx: pet.facing * rnd(10, 30), vy: -34, life: 1.8 }); pet.noteAt = T + .6; }
        if (mt > pet.dur) { setMode('idle'); pet.nextAt = T + rnd(1.5, 3); }
        break;
      }
      case 'drag': {
        pet.dx = lerp(pet.dx, pointer.x, ease(28, dt));
        pet.dy = lerp(pet.dy, Math.min(pointer.y, floorY - 245 * S), ease(28, dt));
        // 幅度照他们的 ViewRoll（4°）再宽一点：原来 ±40 是他们的 10 倍，甩起来像被风吹。
        // 弹簧用他们的 body 70/7（原来是 90/5，更软更荡）。
        // 支点仍是 36（脖子）—— 不能改：那个点同时是「挂在鼠标上的点」。
        // 头部的「甩尾」不靠这个，靠形象侧的 _dragLag（反向补 2.5 倍，clamp ±15）。
        tiltT = clamp(pointer.vx * .006, -6, 6); tk = 70; tc = 7;
        if (Math.abs(pointer.vx) > 500 && T > pet.sfxAt) { play('squeak', 'touch'); pet.sfxAt = T + rnd(.4, .7); }
        break;
      }
    }

    // short gestures layered over whatever the body is doing
    // (a figure that lists a gesture in `figure.gestures` draws it itself, from the frame's `gesture`)
    if (pet.pulse) {
      const k = (T - pet.pulse.t0) / pet.pulse.dur;
      if (k >= 1) pet.pulse = null;
      else if (custom?.gestures?.includes(pet.pulse.kind)) { /* the figure's own */ }
      else if (pet.pulse.kind === 'nod') leanT += 9 * Math.abs(Math.sin(k * Math.PI * 2));
      else if (pet.pulse.kind === 'shake') tiltT += 10 * Math.sin(k * Math.PI * 6) * (1 - k);
      else if (pet.pulse.kind === 'wave') tiltT += 6 * Math.sin(k * Math.PI * 6) * Math.sin(k * Math.PI);
      else if (pet.pulse.kind === 'bow') leanT += 16 * envelope(k, .25, .7);
      else if (pet.pulse.kind === 'flap') { tiltT += 7 * Math.sin(k * Math.PI * 8) * (1 - k); sqT -= .06 * Math.abs(Math.sin(k * Math.PI * 8)) * (1 - k); }
      else if (pet.pulse.kind === 'spin' && k > .5 && !pet.pulse.flipped) { pet.pulse.flipped = true; pet.facing *= -1; }
      else if (pet.pulse.kind === 'spin' && k < .5 && !pet.pulse.first) { pet.pulse.first = true; pet.facing *= -1; pet.sqv -= 1; }
    }

    const fname = faceName(), fc = faceDef(fname).f(T, pet);
    // while the page shows the thought in its status bubble, the face keeps the eyes without a second thought trail
    if (pet.thinking && pet.thoughtShown && fname === 'thinking') fc.think = false;
    if (fc.lookLock || pet.mode === 'sleep' || pet.mode === 'drag') lookT = [0, 0];
    else if (fc.lookAt) lookT = fc.lookAt;

    // eye shape changes hide under a quick blink; same-shape changes (ring size) ease
    const sig = fc.eyes.map(e => e.shape).join();
    if (sig !== pet.eyeSig) {
      if (pet.eyeCur) { pet.eyePrev = pet.eyeCur; pet.swapAge = 0; }
      pet.eyeSig = sig;
      fc.eyes.forEach((e, i) => { pet.eyeDims[i] = [e.rx ?? 16, e.ry ?? 16, e.dx || 0, e.dy || 0]; });
    }
    pet.swapAge += dt;
    pet.eyeCur = fc.eyes.map((e, i) => {
      if (e.shape !== 'ring' && e.shape !== 'lid') return e;
      const d = pet.eyeDims[i], tgt = [e.rx ?? 16, e.ry ?? 16, e.dx || 0, e.dy || 0];
      for (let j = 0; j < 4; j++) d[j] = lerp(d[j], tgt[j], ease(16, dt));
      return { ...e, rx: d[0], ry: d[1], dx: d[2], dy: d[3] };
    });
    pet.blushK = lerp(pet.blushK, fc.blush || 0, ease(6, dt));

    // springs & easing
    pet.sqv += ((sqT - pet.sq) * 280 - pet.sqv * 14) * dt;   // 弹簧只跟 kit 自己的 sqT（落地/跳舞）
    pet.sq = clamp(pet.sq + pet.sqv * dt, -.35, .45);
    pet.tiltV += ((tiltT - pet.tilt) * tk - pet.tiltV * tc) * dt;
    pet.tilt += pet.tiltV * dt;
    pet.lean = lerp(pet.lean, leanT, ease(7, dt));
    pet.sitK = lerp(pet.sitK, sitT, ease(m === 'land' ? 18 : 6, dt));
    pet.drowse = lerp(pet.drowse, drowseT, ease(m === 'sleep' ? 1.5 : m === 'sit' ? 4 : 6, dt));
    // 2026-11-24 用户：「一拉起来她就拉伸一样」。原版一进 drag 就恒定拉满（sx −5% / sy +9%），
    // 看着像橡皮。他们的 ViewSquash 是跟手相对头的位置（±8%，手不动就不变），
    // 我们的抓取点可以是身上任意高度，没有「后颈」这个基准 —— 改成跟**垂直速度**：
    // 快速甩才变形，停下就归零（-1 压扁 / +1 拉长，1200 px/s 打满）。
    const stT = m === 'drag' ? clamp(-pointer.vy / 1200, -.8, 1) : 0;
    pet.stretch = lerp(pet.stretch, stT, ease(8, dt));
    pet.stride = lerp(pet.stride, strideT, ease(10, dt));
    pet.lift = lerp(pet.lift, liftT, ease(10, dt));
    pet.bob = lerp(pet.bob, bobT, ease(10, dt));
    pet.look[0] = lerp(pet.look[0], lookT[0], ease(9, dt));
    pet.look[1] = lerp(pet.look[1], lookT[1], ease(9, dt));
    pet.gap[0] = lerp(pet.gap[0], fc.gap[0], ease(8, dt));
    pet.gap[1] = lerp(pet.gap[1], fc.gap[1], ease(8, dt));
    // turning reads as a quick card flip rather than a mirror snap
    pet.faceVis = lerp(pet.faceVis, pet.facing, ease(15, dt));
    if (m !== 'walk' && m !== 'run' && m !== 'dance') pet.phase = lerp(pet.phase, Math.round(pet.phase / Math.PI) * Math.PI, ease(6, dt));
    pointer.vx *= Math.exp(-dt * 6);

    // secondary motion for ears/antenna/scarf: lags behind horizontal movement
    const AX = pet.mode === 'drag' ? pet.dx : pet.x;
    const AY = pet.mode === 'drag' ? pet.dy : pet.y;
    if (pet.prevA != null) pet.velX = lerp(pet.velX, (AX - pet.prevA) / dt, .25);
    // 2026-11-21 垂直速度（拖拽惯性 sway 要它；和 velX 同法）
    if (pet.prevAY != null) pet.velY = lerp(pet.velY, (AY - pet.prevAY) / dt, .25);
    // lerp keeps a NaN or an infinity for good, and the swing with it: a figure's warps that read the swing then
    // draw nothing. Start the speed over and say what it came from.
    if (!Number.isFinite(pet.velX)) {
      if (!velXBad) console.warn(`[pet] 横向速度不是有限数,已归零:velX=${pet.velX} x=${AX} 上一帧x=${pet.prevA} dt=${dt} 模式=${m}`);
      velXBad = true;
      pet.velX = 0;
    } else velXBad = false;
    pet.prevA = AX;
    pet.prevAY = AY;
    // dancing stays put but rocks: the rock swings what hangs off the body (ears, hair, skirt), as moving does
    const swingT = clamp(-(pet.velX * .06 + (m === 'dance' ? pet.tiltV * .22 : 0)) * Math.sign(pet.faceVis || 1), -28, 28);
    pet.swingV += ((swingT - pet.swing) * 110 - pet.swingV * 7) * dt;
    pet.swing = clamp(pet.swing + pet.swingV * dt, -40, 40);

    pet.low = pet.sitK * 29 + pet.bob * Math.abs(Math.sin(pet.phase));
    pet.feet.forEach((ft, i) => {
      const hx = HIPS[i][0], hy = HIPS[i][1] + pet.low;
      let tx, ty;
      if (m === 'drag') { tx = hx + 7 * Math.sin(T * 11 + i * 2.2); ty = hy + 36; }
      else if (m === 'air') { tx = hx + (i ? 9 : -9); ty = hy + 33; }
      else {
        const ph = pet.phase + i * Math.PI;
        const sx = hx + pet.stride * Math.sin(ph), sy = FOOT_Y - pet.lift * Math.max(0, Math.cos(ph));
        tx = lerp(sx, hx + 26, pet.sitK); ty = lerp(sy, FOOT_Y, pet.sitK);
      }
      const r = m === 'drag' || m === 'air' ? 14 : 40;
      ft[0] = lerp(ft[0], tx, ease(r, dt)); ft[1] = lerp(ft[1], ty, ease(r, dt));
    });

    if (fc.emit && T > pet.emitAt) {
      if (fc.emit === 'heart') { emitHeart(); pet.emitAt = T + .45; }
      if (fc.emit === 'z') { emit('z', toStage(A.z[0], A.z[1] + pet.low), { vx: pet.facing * 16, vy: -26, life: 2.4 }); pet.emitAt = T + 1.3; play('snore', 'snore', pet.modeT); }
      if (fc.emit === 'tear') { emit('drop', toStage(A.tear[0] + pet.look[0], A.tear[1] + pet.low), { vx: pet.facing * rnd(10, 30), vy: -20, life: 3 }); pet.emitAt = T + .8; }
      if (fc.emit === 'tears') {
        // both eyes cry, taking turns; a figure that names only its one tear spot cries from there
        const eyes = A.tears ?? [A.tear], [ex, ey] = eyes[pet.tearN++ % eyes.length];
        emit('drop', toStage(ex + pet.look[0] + rnd(-6, 6), ey + pet.low), { vx: pet.facing * rnd(-20, 50), vy: rnd(-60, -20), life: 3 }); pet.emitAt = T + .22;
      }
    }
    strokeAcc *= Math.exp(-dt * 1.5);
    petCool -= dt;

    for (let i = P.length - 1; i >= 0; i--) {
      const p = P[i];
      p.age += dt; p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.type === 'drop') { p.vy += 900 * dt; if (p.y > groundY()) p.age = p.life; }
      if (p.type === 'dust') p.vx *= Math.exp(-dt * 4);
      if (p.age >= p.life) P.splice(i, 1);
    }
    pet.talkK *= Math.exp(-dt * 12);
    pet._fc = fc; pet._fname = fname;
  }

  function land() {
    const impact = pet.vy, kind = pet.airKind;
    pet.fy = pet.gy; pet.vy = 0; pet.vx = 0; pet.gvy = 0;
    pet.sqv += clamp(impact * .0024, .8, 4.5);
    play('land', 'move', kind !== 'jump' && impact > 1000);
    dustAt(128, impact > 900 ? 7 : 3, 70);
    if (kind === 'throw' && impact > 1000) { setMode('dizzy'); onEvent('touch', { kind: 'crash' }); return; }
    setMode('land');
    if (kind === 'throw') { pet.expr = 'surprised'; pet.exprUntil = T + .9; pet.nextAt = T + 2; }
    else if (kind === 'drop') { pet.expr = 'happy'; pet.exprUntil = T + 1.6; pet.nextAt = T + 2.6; }
    else pet.nextAt = T + rnd(.8, 2);
  }

  /** What render last wrote into the group's transform, the shadow and the particles; the same value is not written again. */
  const drawn = { xf: '', shadow: '', fx: '' };
  /**
   * Places the body for this frame (`pet.xf`, which `layout` and the hit tests read) and, unless `draw` is false,
   * draws it: the figure into `petG`, the shadow and the particles.
   */
  function render(draw = true) {
    const fc = pet._fc || FACES.neutral.f(0), fname = pet._fname || 'neutral';
    const drag = pet.mode === 'drag';
    const br = Math.sin(T * (pet.mode === 'sleep' ? 1.7 : 2.4));
    // 形象给的压扁（ViewSquash）直通：他们的 renderer 是 bodySquash 直接乘进矩阵，不过弹簧
    const figSq = custom?.squash?.() ?? 0;
    const sqAll = pet.sq + figSq;
    const sx = (1 + sqAll * .7) * (1 - .05 * pet.stretch);
    const sy = (1 - sqAll) * (1 + .09 * pet.stretch);
    const ax = 128, ay = drag ? 36 : 256;
    let AX = drag ? pet.dx : pet.x, AY = drag ? pet.dy : pet.fy;
    if (fc.shake) AX += Math.sin(T * 60) * 1.4;
    else if (pet.pulse?.kind === 'shiver') AX += Math.sin(T * 75) * 1.1 * envelope((T - pet.pulse.t0) / pet.pulse.dur, .08, .85);
    AX += custom?.faceShake?.(T) ?? 0;   // 通道情绪词的组级抖动（生气/害怕）——figure 实现见形象包
    // a figure may keep tilt and lean off the whole group and bend its own parts instead
    const faceK = custom?.noMirror ? 1 : pet.faceVis;
    const kx = S * faceK * sx, ky = S * sy, lean = pet.lean * pet.faceVis;
    const rot = custom?.groupTilt ? custom.groupTilt(pet.mode, pet.tilt, lean) : pet.tilt + lean;
    // figure.groupMove：整图平移（figure 返回值的 1 = 半个形象宽/高），乘模型自身缩放变像素。
    const mv = custom?.groupMove?.(pet.mode);
    if (mv) { AX += (mv.x ?? 0) * kx; AY += (mv.y ?? 0) * ky; }
    pet.xf = { AX, AY, ax, ay, kx, ky, rot };
    const extent = figureExtent();
    if (!drag && extent && Math.min(...sideReach(extent)) < DEFAULT_HALF_WIDTH) {
      // A figure narrow on either side can travel closer to that edge. Fit its transformed outline in the stage.
      const box = stageBox(extent);
      const inset = Math.min(EDGE_INSET, (W - box.w) / 2);
      AX += clamp(0, inset - box.x, W - inset - box.x - box.w);
      pet.xf.AX = AX;
    }
    if (!draw) return fname;
    const xf = `translate(${f(AX)} ${f(AY)}) rotate(${rot.toFixed(5)}) scale(${kx.toFixed(4)} ${ky.toFixed(4)}) translate(${-ax} ${-ay})`;
    if (xf !== drawn.xf) { petG.setAttribute('transform', xf); drawn.xf = xf; }

    const legs = pet.feet.map((ft, i) => [HIPS[i][0], HIPS[i][1] + pet.low, ft[0], ft[1]]);
    // drowsy blinks are slower
    const bd = .3 + .3 * pet.drowse, blink = pet.blinkAge < bd ? Math.sin(Math.PI * pet.blinkAge / bd) : 0;
    let eyes = pet.eyeCur || fc.eyes, eyeClose = 0;
    if (pet.swapAge < .07 && pet.eyePrev) { eyes = pet.eyePrev; eyeClose = pet.swapAge / .07; }
    else if (pet.swapAge < .16) eyeClose = 1 - (pet.swapAge - .07) / .09;
    const face = { ...fc, eyes, gap: pet.gap.map(g => Math.min(64, g + pet.talkK * 12)), blush: pet.blushK };
    const gesture = pet.pulse ? { kind: pet.pulse.kind, k: clamp((T - pet.pulse.t0) / pet.pulse.dur, 0, 1) } : null;
    custom.draw(petG, face, {
      look: pet.look, legs, low: pet.low, t: T, blink, blinkAge: pet.blinkAge, blinkDur: bd, eyeClose, acc: skin, swing: pet.swing, velX: pet.velX, velY: pet.velY,
      // 指针的真实舞台坐标（不在窗口内就是 null）。形象靠它区分「人真的动了鼠标」
      // 和 pet.look —— 鼠标不在窗口时 look 是每 1.2~3 秒刷新的随机 glance。
      pointer: pointer.inside ? [pointer.x, pointer.y] : null,
      // 瞬时的朝向（±1），不是平滑的 faceVis。kit 算 look 时用的是这个，
      // 形象做镜像补偿也必须用同一个，否则翻转瞬间两边不同步，头会往回抽一下。
      facingNow: pet.facing,
      // 4.2 rua 摸头的实时状态（null = 没在摸）：形象据此画「头朝手的反方向 + 表情档位」
      rua: rua ? { on: rua.on !== false, ux: rua.ux, uy: rua.uy, bodyUy: rua.uy, side: rua.side, face: rua.face, seconds: rua.seconds, melt: rua.melt, moving: rua.moving, fx: rua.fx, speed: rua.speed } : null,   // on：弹簧开关（必须透传，漏了头就不动）
      face: fname, mode: pet.mode, modeT: pet.modeT, talk: pet.talkK, status: pet.status, drowse: pet.drowse, sit: pet.sitK, facing: pet.faceVis, tilt: pet.tilt, lean, groupRot: rot, gesture,
    });

    const footY = drag ? pet.dy + 220 * S * 1.09 : pet.fy;
    // a free body held up casts its shadow just under it, there being no floor below it to fall to
    const shadowY = freeGround && drag ? footY + 40 * S : groundY();
    const k = clamp(1 - (shadowY - footY) / 420, .3, 1);
    const shadow = [f(AX), f(shadowY - 2), f(72 * S * k * (1 + pet.sq * .5)), f(10 * S * k + 1), f(k)];
    if (shadow.join() !== drawn.shadow) {
      ['cx', 'cy', 'rx', 'ry', 'opacity'].forEach((name, i) => shadowEl.setAttribute(name, shadow[i]));
      drawn.shadow = shadow.join();
    }

    let s = '';
    const sc = S / .48;
    // sleep z's take the eye colour, or the figure's own colour for them
    const zPaint = custom?.colors?.z ? `stroke="${custom.colors.z}"` : 'class="eye"';
    for (const p of P) {
      const a = p.age / p.life;
      if (p.type === 'z') {
        const op = a < .15 ? a / .15 : 1 - (a - .15) / .85, z = (.7 + .9 * a) * sc;
        s += `<path ${zPaint} fill="none" stroke-width="${f(3 / z)}" stroke-linecap="round" stroke-linejoin="round" opacity="${f(op)}" transform="translate(${f(p.x + Math.sin(p.age * 2.5) * 6)} ${f(p.y)}) scale(${f(z)})" d="M-6 -7H6L-6 7H6"/>`;
      } else if (p.type === 'heart') {
        s += `<path class="p-heart" fill="none" stroke-width="5" stroke-linejoin="round" opacity="${f(1 - a * a)}" transform="translate(${f(p.x + Math.sin(p.age * 4) * 5)} ${f(p.y)}) scale(${f((.45 + .35 * a) * sc)})" d="${heartD(0, 0, 1)}"/>`;
      } else if (p.type === 'dust') {
        s += `<circle class="p-dust" fill="none" stroke-width="2" cx="${f(p.x)}" cy="${f(p.y)}" r="${f((3 + 8 * a) * sc)}" opacity="${f(.7 * (1 - a))}"/>`;
      } else if (p.type === 'note') {
        const op = a < .15 ? a / .15 : 1 - (a - .15) / .85, z = (.8 + .4 * a) * sc;
        s += `<g opacity="${f(op)}" transform="translate(${f(p.x + Math.sin(p.age * 3) * 8)} ${f(p.y)}) scale(${f(z)})"><path ${zPaint} fill="none" stroke-width="2.4" stroke-linecap="round" d="M3 4V-9L9 -6"/><circle ${zPaint} fill="none" stroke-width="3.6" cx="0" cy="4.5" r="1.8"/></g>`;
      } else if (p.type === 'drop') {
        s += `<path class="tearf" transform="translate(${f(p.x)} ${f(p.y)}) scale(${f(.9 * sc)})" d="${DROP}"/>`;
      }
    }
    if (s !== drawn.fx) { fxG.innerHTML = s; drawn.fx = s; }
    return fname;
  }

  /* pointer: stage-pixel coordinates; `p.t` is when it happened (ms), else now */
  const now = (p) => p?.t ?? performance.now();
  function velocity() {
    const s = pointer.samples;
    if (s.length < 2) return { x: 0, y: 0 };
    const a = s[0], b = s[s.length - 1], dt = Math.max(.016, (b.t - a.t) / 1000);
    return { x: (b.x - a.x) / dt, y: (b.y - a.y) / dt };
  }
  /** Picks the body up by the scruff; it then follows the pointer until let go of. */
  function grab() {
    const scruff = toStage(128, 36);
    pet.expr = null;
    setMode('drag', { dx: scruff.x, dy: scruff.y });
    play('grab', 'touch');
    pet.sqv -= 1.2; pet.tiltV = 0;
    onEvent('touch', { kind: 'grab' });
  }
  function pointerDown(p) {
    Object.assign(pointer, { x: p.x, y: p.y, inside: true });
    // 2026-11-22：点在窗口里但没打中她 —— 也要清掉残留 press，否则下一次移动会被当成拖拽
    if (!hitPet(p)) { press = null; return false; }
    // 2026-11-21 用户定：右键 = rua（和 DeepFish 一样左拖右摸）。彻底和拖拽分开——crash 链断掉。
    // 右键永远 press=null，不进 grab/drop，摸哪都行（不再判头区，头区只影响手感分区）。
    if (p.button === 2) {
      if (pet.mode === 'walk' || pet.mode === 'run') setMode('idle');
      press = null;
      // 2026-11-22：只有头/脸才进入 rua（用户：摸哪里都算摸头）。其它区右键不接管，
      // 交给页面区分单击（菜单）和长按（P3 的一次性轻摸）。
      {
        const _z = zoneAt(p);
        if (_z !== 'head' && _z !== 'face') { pointer.samples = [{ t: now(p), x: p.x, y: p.y }]; return true; }
      }
      pointer.samples = [{ t: now(p), x: p.x, y: p.y }];
      ruaDown = true; rua = null; ruaLast = { x: p.x, y: p.y, t: now(p) };
      ruaVel = { x: 0, y: 0 }; ruaTravel = 0; ruaHeadTime = 0; ruaDeepTime = 0;
      ruaMax = 0; ruaTier = 0; ruaStillAt = 0; ruaMelted = false;
      return true;
    }
    // 左键 = 拖拽/戳（原版）
    press = { x: p.x, y: p.y, t: now(p) };
    pointer.samples = [{ t: now(p), x: p.x, y: p.y }];
    // caught while falling or flying: held at once, since the body would fall on while the pointer moved the drag threshold
    if (pet.mode === 'air') { grab(); return true; }
    return true;
  }
  /** Returns the cursor the stage should show. */
  function pointerMove(p) {
    const t = now(p);
    const ddx = p.x - pointer.x, ddy = p.y - pointer.y;
    Object.assign(pointer, { x: p.x, y: p.y, inside: true });
    pointer.samples.push({ t, x: p.x, y: p.y });
    while (pointer.samples.length > 2 && t - pointer.samples[0].t > 110) pointer.samples.shift();
    pointer.vx = lerp(pointer.vx, velocity().x, .35);
    pointer.vy = lerp(pointer.vy, velocity().y, .35);

    // 4.2 rua：按住头区期间走 rua 推进，指针本体隐藏（页面上的手接管），绝不转成拖拽
    if (ruaDown) { stepRua(p); return (pet.cursor = 'grab'); }   // 4.2：沿用原有手形（用户：不要换指针）
    // rua 刚结束的 3 秒内绝不 grab：残留 press + 鼠标一动就会被当成拖拽，松手甩出去就是
    // 「摸头 0 秒 + 你重重落地，摔晕了一会儿」（用户 2026-11-22 实测）。
    if (press && pet.mode !== 'drag' && T - lastRuaAt > 3 && Math.hypot(p.x - press.x, p.y - press.y) > 6) grab();
    if (press) return (pet.cursor = 'grabbing');
    const over = hitPet(p);
    // 2026-11-22：划过不再有任何反应（用户：鼠标从她身上划过去就触发摸头，还不用按键）。
    // 轻摸改成必须右键按住：头/脸是持续 rua，其它区在 pointerDown 里一次性处理。
    return (pet.cursor = over ? 'grab' : '');
  }
  function pointerUp(p) {
    pet.cursor = '';
    if (ruaDown) { endRua(); return; }   // 4.2 头区 rua：press 是 null（防 crash），必须在 !press 判断前清 ruaDown——否则 rua 永不结束（用户实测「脱手还是 rua 状态」）
    if (!press) return;
    if (pet.mode === 'drag') {
      // hand over from the scruff anchor to the feet anchor without a visual jump
      const foot = toStage(128, 256);
      const v = velocity();
      pet.x = clamp(foot.x, minX(), maxX());
      const speed = Math.hypot(v.x, v.y);
      if (freeGround) {
        // set down where it was let go of; a throw tosses it on across the stage, higher the faster it went
        pet.gy = clamp(foot.y, minY(), floorY); pet.fy = Math.min(pet.gy, foot.y);
        pet.vx = clamp(v.x, -1800, 1800); pet.gvy = clamp(v.y, -1800, 1800) * .6; pet.vy = -Math.min(1400, speed * .6);
      } else {
        pet.fy = Math.min(floorY, foot.y);
        pet.vx = clamp(v.x, -1800, 1800); pet.vy = clamp(v.y, -1800, 1400);
      }
      // 2026-11-22：原来无条件写 'throw'，但事件按速度分 throw/drop ——
      // 轻轻放下落地也会走「抛出去」的判据（impact>1000 就 crash）。按速度对齐。
      pet.airKind = speed > 700 ? 'throw' : 'drop';
      if (speed > 700) play('whoosh', 'move');
      setMode('air');
      onEvent('touch', { kind: speed > 700 ? 'throw' : 'drop', x: Math.round(pet.x) });
    } else if (now(p) - press.t < 400) {
      // 戳哪儿、戳在左边还是右边：形象按 Behavior.ClickMood 演对应的那一条
      const _pz = zoneAt(p) ?? 'body';
      // 标定：把屏幕点反解回 logo 坐标，和 touchZones 的数值对照（用户 17:50 要求「在已知高度打日志」）
      try { const _xf = pet.xf || {}; const _lx = (p.x - (_xf.AX ?? 0)) / (_xf.kx || 1) + (_xf.ax ?? 128); const _ly = (p.y - (_xf.AY ?? 0)) / (_xf.ky || 1) + (_xf.ay ?? 256); new Image().src = '/api/figure-log?m=' + encodeURIComponent('zone p=' + Math.round(p.x) + ',' + Math.round(p.y) + ' logo=' + _lx.toFixed(0) + ',' + _ly.toFixed(0) + ' pz=' + _pz + ' ay=' + (_xf.ay ?? 256) + ' ky=' + (_xf.ky || 1).toFixed(2)); } catch {}
      // 侧别用他们 Behavior.Click 的约定：**左 = +1，右 = -1**（PetWindow.cs:1133 `at.X / Width < .5 ? 1 : -1`）。
      // 形象侧 `Pushed && side < 0` 才对镜像——之前这里传反了，于是戳左边往左躲（同向）。
      const _ps = p.x < toStage(128, 0).x ? 1 : -1;
      if (pet.mode === 'sleep' || pet.mode === 'sit') {
        const wasAsleep = pet.mode === 'sleep';
        setMode('wake', { startle: true }); pet.sqv -= 2.2; pet.nextAt = T + 2.4;
        play('surprised', 'face');
        onEvent('touch', { kind: 'poke', woke: wasAsleep, zone: _pz, side: _ps });
        custom?.poke?.(_pz, _ps);
      } else if (pet.mode !== 'dizzy') {
        play('poke', 'touch');
        // 2026-11-23：随机表情和随机蹦一下都删掉——它们会和形象按分区演的那条抢脸/抢动作
        // （用户：戳完先歪一下头，然后就没了）。改成把分区和侧别交给形象。
        custom?.poke?.(_pz, _ps);
        onEvent('touch', { kind: 'poke', zone: _pz, side: _ps });
      }
    }
    press = null;
  }
  /**
   * Ends a drag with the body dropped from under stage point `p` with no throw: the pointer was let
   * go of on another display and the stage now covers that one. Call after `resize()` has taken the
   * new size.
   */
  function dropAt(p) {
    press = null;
    if (pet.mode !== 'drag') return;
    Object.assign(pointer, { x: p.x, y: p.y, vx: 0, samples: [] });
    pet.x = clamp(p.x, minX(), maxX());
    pet.fy = Math.min(floorY, p.y + 220 * S);
    if (freeGround) pet.gy = clamp(pet.fy, minY(), floorY);
    pet.vx = 0; pet.vy = 0; pet.gvy = 0;
    pet.airKind = 'drop';
    setMode('air');
    onEvent('touch', { kind: 'drop', x: Math.round(pet.x) });
  }
  /**
   * Keeps a held body under the pointer when the stage moved to another display mid-drag: every
   * point on screen now sits (dx, dy) stage pixels from where it was.
   */
  function shiftDrag(dx, dy) {
    if (pet.mode !== 'drag') return;
    pet.dx += dx; pet.dy += dy; pet.x += dx;
    pointer.x += dx; pointer.y += dy;
    for (const s of pointer.samples) { s.x += dx; s.y += dy; }
    if (press) { press.x += dx; press.y += dy; }
  }
  function pointerLeave() { if (!press) pointer.inside = false; }   // 4.2：rua 出窗不结算（头贴窗口边，摸出去很正常）——headTime 冻结、回窗继续

  /** Head top in stage pixels, for placing a speech bubble. */
  const anchor = () => toStage(A.bubble[0], A.bubble[1] + pet.low);

  /**
   * Where the body is and what it is doing, in stage pixels, for the page around it: its box and hit
   * circles, the bubble's spot, the point the hover buttons sit beside (`side`, with `reach` from it to
   * the body's edge), and the cursor to show.
   */
  function layout() {
    const extent = figureExtent();
    const box = stageBox(extent ?? EXTENT);
    const side = toStage(128, 128 + pet.low);
    const half = halfWidth(extent);
    const reach = half < DEFAULT_HALF_WIDTH && pet.mode !== 'drag'
      ? Math.max(half * S, pet.x - box.x, box.x + box.w - pet.x)
      : half * S;
    return {
      x: pet.x, ...(freeGround ? { y: pet.gy } : {}), facing: pet.facing, mode: pet.mode, busy: busy(), pressing: !!press, cursor: pet.cursor,
      moving: !!press || MOVING_MODES.has(pet.mode) || !!pet.pulse || Math.abs(pet.faceVis - pet.facing) > .05,
      box, hit: hits(), bubble: anchor(), side: { x: side.x, y: side.y, reach },
    };
  }

  resize();
  custom?.setSkin?.(skin);
  return {
    pet, step, render, resize, act, setExpr, doWord, walkTo, stopWalk, toStage, hitPet, busy, layout,
    pointerDown, pointerMove, pointerUp, pointerLeave, dropAt, shiftDrag,
    get pressing() { return !!press; },
    /** Pressed, carried, airborne, walking, running, dancing, turning round, or in a short gesture (nod, wave, bow…): motion that frames far apart show as jumps. */
    get moving() {
      return !!press || MOVING_MODES.has(pet.mode) || !!pet.pulse || Math.abs(pet.faceVis - pet.facing) > .05;
    },
    get time() { return T; },
    /** The stage, and where the body's middle may stand as it faces now (`minX`, `maxX`) and as high as it may stand (`minY`). */
    get bounds() { return { W, H, floorY, S, minX: minX(), maxX: maxX(), minY: minY() }; },
    /** Where a walk to the left ends at the farthest (`minX`), and one to the right (`maxX`). */
    get walkBounds() { return { minX: minX(-1), maxX: maxX(1) }; },
    /** A free body stands anywhere on the stage (`opts.ground`). */
    freeGround,
    setSkin(s) { skin = s; custom?.setSkin?.(s); },
    /** Swaps the body's drawing (see `opts.figure`). */
    setFigure(fig) {
      if (fig === custom) return;
      // a swapped-out figure may hold a WebGL context; release it now instead of waiting for GC
      custom?.dispose?.();
      custom = fig;
      custom.setSkin?.(skin);
      A = anchors();
      petG.textContent = '';
      render();
    },
    get figure() { return custom; },
    get skin() { return skin; },
    setRoam(r) { roam = r; if (r !== 'off') pet.nextAt = T + 1; },
    get roam() { return roam; },
    /** Outside orders keep free roaming quiet for `seconds`. */
    holdRoam(seconds) { hold = Math.max(hold, T + seconds); },
    talk() { pet.talkK = 1; },
    setListening(on) { pet.listening = on; if (on && (pet.mode === 'walk' || pet.mode === 'run')) setMode('idle'); },
    setThinking(on) { pet.thinking = on; },
    /** What the bot is busy with as the page's status bubble names it (`kind`), or null; the figure reads it from `frame.status`. */
    setStatus(kind) { pet.status = typeof kind === 'string' ? kind : null; },
    /** The page shows the bot's thinking in a bubble of its own. */
    setThoughtShown(on) { pet.thoughtShown = on; },
    anchor,
    emitHeart,
  };
}

/* ---------- the body a pack hands the figure frame ---------- */
/** Colours of what the kit draws itself (shadow, particles; z's take the `eye` class without a figure colour). */
const KIT_CSS = `
:root{--shadow:rgba(27,22,38,.12);--tear:#5AAEF0;--heart:#F0567A;--dust:#A39DB0;--skin-eye:#00A870}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--shadow:rgba(0,0,0,.32);--tear:#6BBDF7;--heart:#FF6F93;--dust:#5B6472;--skin-eye:#2FD59B}}
:root[data-theme="dark"]{--shadow:rgba(0,0,0,.32);--tear:#6BBDF7;--heart:#FF6F93;--dust:#5B6472;--skin-eye:#2FD59B}
.shadow{fill:var(--shadow)} .tearf{fill:var(--tear)} .p-heart{stroke:var(--heart)} .p-dust{stroke:var(--dust)} .eye{stroke:var(--skin-eye)}
svg.kit{position:absolute;inset:0;width:100%;height:100%;display:block;overflow:visible}
`;
const SVGNS = 'http://www.w3.org/2000/svg';

/**
 * The body contract (api 2, web/figure-frame.js) on top of `createPet`: what a pack's factory returns.
 * `host` is what the frame gives the factory: `root` (the element to draw in), `bounds()`, `emit(kind, detail)`
 * for what happens to the body, `sound(name, kind, ...args)` for what it wants heard, and `start` ({ x, y, facing,
 * enter, skin }: where it stands (`y`, its ground line, only for a free body that stood off the floor), or enter
 * 'drop' to fall in from above, and the skin to wear). `opts` are createPet's, with `figure` required; `opts.css` is
 * more style for the frame's document (a figure's own classes) and `opts.skinCss(skin)` the style that follows the skin.
 * `opts.moves` answers the pack's own targets (its manifest's `moves`): `{ id: (params, bounds) => ({ x, y? }) | null }`
 * gives the stage point to walk to for those params (bounds as `bounds()` gives them, with `minX` and `maxX` where a
 * walk to the left and to the right ends at the farthest, and `minY`);
 * null, or a target it does not name, answers the move `busy`.
 *
 * The body takes these calls from the page: step(dt, draw), layout(), do(word), walk(x, run, id), stopWalk(id), pointer(type, p),
 * drop(p), shift(dx, dy), place(x, facing, y), move(args, id), set({ roam, hold, dialogOpen, still, listening, thinking, thoughtShown, status, skin, theme }),
 * cue(kind), talk(), setScheme(id, o), dispose(); `words` lists every word its do() knows.
 */
export function createBody(host, opts) {
  const doc = host.root.ownerDocument;
  const style = doc.createElement('style');
  style.textContent = KIT_CSS + (opts.css ?? '');
  doc.head.appendChild(style);
  const svg = doc.createElementNS(SVGNS, 'svg');
  svg.setAttribute('class', 'kit');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = '<ellipse class="shadow" cx="0" cy="0" rx="0" ry="0"/><g></g><g></g>';
  host.root.appendChild(svg);
  const [shadowEl, petG, fxG] = svg.children;
  const skinStyle = doc.createElement('style');
  doc.head.appendChild(skinStyle);
  const start = host.start ?? {};
  if (opts.skinCss && start.skin) skinStyle.textContent = opts.skinCss(start.skin);
  let dialogOpen = false, still = false;
  const ctl = createPet({ petG, shadowEl, fxG }, {
    ...opts,
    skin: start.skin ?? null, startX: start.x, startFacing: start.facing, startY: start.y, enter: start.enter,
    bounds: host.bounds,
    onEvent: host.emit,
    sfx: { play: host.sound },
    dialogOpen: () => dialogOpen,
    still: () => still,
  });
  return {
    step(dt, draw = true) { ctl.step(dt); ctl.render(draw); },
    layout: ctl.layout,
    resize: ctl.resize,
    do: ctl.doWord,
    words: [...KIT_EXPRESSIONS, ...KIT_MOTIONS, ...Object.keys(opts.words ?? {}).filter((w) => opts.words[w]?.expression || opts.words[w]?.motion)],
    walk: (x, run, id) => ctl.walkTo(x, run, id),
    stopWalk: (id) => ctl.stopWalk(id),
    move(args, id) {
      const to = opts.moves?.[args?.to];
      const p = typeof to === 'function' ? to(args.params ?? {}, { ...host.bounds(), ...ctl.bounds, ...ctl.walkBounds }) : null;
      return !!p && ctl.walkTo(p.x, !!args.run, id, p.y);
    },
    pointer(type, p) {
      if (type === 'down') ctl.pointerDown(p);
      else if (type === 'move') ctl.pointerMove(p);
      else if (type === 'up' || type === 'cancel') ctl.pointerUp(p);
      else if (type === 'leave') ctl.pointerLeave();
    },
    drop: ctl.dropAt,
    shift: ctl.shiftDrag,
    /** Puts a body that is standing at stage x, turned to `facing` (1 right, -1 left); a free body also on ground line `y`. */
    place(x, facing, y) {
      if (ctl.pet.mode === 'drag' || ctl.pet.mode === 'air') return;
      if (facing === 1 || facing === -1) ctl.pet.facing = ctl.pet.faceVis = facing;
      const { minX, maxX, minY, floorY } = ctl.bounds;
      ctl.pet.x = ctl.pet.target = clamp(x, minX, maxX);
      if (ctl.freeGround && typeof y === 'number' && Number.isFinite(y)) ctl.pet.gy = ctl.pet.targetY = ctl.pet.fy = clamp(y, minY, floorY);
    },
    set(s) {
      if (s.roam) ctl.setRoam(s.roam);
      if (typeof s.hold === 'number') ctl.holdRoam(s.hold);
      if (s.speechStart) opts.figure?.onSpeechStart?.();
      if (s.speechDone) opts.figure?.onSpeechEnd?.();
      if (s.tone !== undefined) opts.figure?.onTone?.(s.tone);   // 2.3 tone：当前 beat 的语气传给 actWord
      if (s.beat !== undefined) opts.figure?.onBeat?.(s.beat);
      if (typeof s.dialogOpen === 'boolean') dialogOpen = s.dialogOpen;
      if (typeof s.still === 'boolean') still = s.still;
      if (typeof s.listening === 'boolean') ctl.setListening(s.listening);
      if (typeof s.thinking === 'boolean') ctl.setThinking(s.thinking);
      if (typeof s.thoughtShown === 'boolean') ctl.setThoughtShown(s.thoughtShown);
      if ('status' in s) ctl.setStatus(s.status);
      if (s.skin) { ctl.setSkin(s.skin); if (opts.skinCss) skinStyle.textContent = opts.skinCss(s.skin); }
      if (s.theme) doc.documentElement.dataset.theme = s.theme;
    },
    /** The page's own moments: a talk key tapped (`perk`), speech heard (`heard`), an answer sent (`cheer`), a dress pick (`bounce`). */
    cue(kind) {
      if (kind === 'perk') { ctl.pet.sqv += .6; ctl.setExpr('surprised', .5); }
      else if (kind === 'heard') ctl.pet.sqv += .9;
      else if (kind === 'cheer') ctl.setExpr('happy');
      else if (kind === 'bounce') ctl.pet.sqv += 1.2;
    },
    talk: ctl.talk,
    setScheme: (id, o) => opts.figure.setScheme?.(id, o),
    music: (d) => opts.figure.music?.(d),
    musicActive: () => opts.figure?.musicActive?.() === true,
    get z() { return opts.figure.colors?.z ?? null; },
    dispose() { opts.figure.dispose?.(); svg.remove(); style.remove(); skinStyle.remove(); },
  };
}
