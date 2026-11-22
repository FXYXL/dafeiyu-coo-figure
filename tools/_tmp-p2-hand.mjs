import fs from 'node:fs';

const p = 'tools/patch-pet-kit.mjs';
let s = fs.readFileSync(p, 'utf8');
if (s.includes("id: 'ruaHand'")) { console.log('已存在'); process.exit(0); }

const anchor = "  {\n    file: 'petapp', id: 'skitNote',";

const HAND = `/* ---------- rua 的白手（照他们 HandWindow：一只几何白手替代指针） ---------- */
const ruaHand = document.createElement('div');
ruaHand.className = 'rua-hand';
ruaHand.hidden = true;
ruaHand.style.cssText = 'position:fixed;left:0;top:0;width:160px;height:160px;pointer-events:none;z-index:2;opacity:0;transition:opacity .12s ease;will-change:transform';
ruaHand.innerHTML = \`<svg viewBox="0 0 160 160" width="160" height="160" aria-hidden="true">
  <g fill="#fff" stroke="#b9bdc9" stroke-width="2.4" stroke-linejoin="round">
    <ellipse cx="80" cy="100" rx="31" ry="27"/>
    <rect x="53" y="48" width="15" height="56" rx="7.5" transform="rotate(-26 80 96)"/>
    <rect x="70" y="30" width="15" height="72" rx="7.5" transform="rotate(-9 80 96)"/>
    <rect x="87" y="34" width="15" height="68" rx="7.5" transform="rotate(4 80 96)"/>
    <rect x="104" y="48" width="14" height="54" rx="7" transform="rotate(16 80 96)"/>
    <rect x="33" y="88" width="42" height="15" rx="7.5" transform="rotate(38 80 96)"/>
  </g>
</svg>\`;
stage.append(ruaHand);
function showRuaHand() {
  if (!ruaHand.hidden) return;
  ruaHand.hidden = false;
  requestAnimationFrame(() => { ruaHand.style.opacity = '1'; });
  document.documentElement.style.cursor = 'none';   // 手替代了指针（他们 Mouse.OverrideCursor = None）
  updateRuaHand();
}
function hideRuaHand() {
  if (ruaHand.hidden) return;
  ruaHand.style.opacity = '0';
  document.documentElement.style.cursor = '';
  setTimeout(() => { ruaHand.hidden = true; }, 120);
}
/** 手跟着鼠标，朝头部中心倾（照他们 HandPoseFor 的味道：离中心越远越斜、略压扁）。 */
function updateRuaHand() {
  if (ruaHand.hidden) return;
  const p0 = cursor.at;
  const a = at()?.bubble;
  if (!p0) return;
  let rot = -40, sx = 1;
  if (a) {
    const ux = clamp((p0.x - a.x) / 64, -1.2, 1.2), uy = clamp((p0.y - a.y) / 46, -1.2, 1.2);
    const r = Math.min(Math.hypot(ux, uy), 1.05);
    const nz = Math.max(.55, Math.sqrt(Math.max(0, 1 - r * r * .7)));
    rot = -40 + clamp(ux, -1, 1) * 12;
    sx = .82 + .18 * nz;   // 越往侧面越"扁"（伪 3D）
  }
  ruaHand.style.transform = \`translate(\${p0.x - 64}px, \${p0.y - 96}px) rotate(\${rot}deg) scale(\${sx.toFixed(3)}, 1)\`;
}
document.addEventListener('pointermove', updateRuaHand, { passive: true });
`;

const block = `  {
    file: 'petapp', id: 'ruaHand',
    desc: 'rua 的几何白手：右键摸头时替代指针（figure 的 rua-start/end 事件驱动），跟着鼠标朝头部倾斜',
    detect: (s) => /rua-hand/.test(s),
    apply: (s) => {
      let out = s.replace('/* ---------- body events → World ---------- */', ${JSON.stringify(HAND)} + '\\n/* ---------- body events → World ---------- */');
      if (!out.includes('function showRuaHand')) throw new Error('ruaHand：插入锚点未命中');
      out = out.replace(
        "    if (d.kind === 'grab') closeMenu();",
        "    if (d.kind === 'grab') closeMenu();\\n    // rua 的白手（他们 HandWindow）：开始摸出现、松手淡出\\n    if (d.kind === 'rua-start') showRuaHand();\\n    else if (d.kind === 'rua-end') hideRuaHand();",
      );
      if (!out.includes('showRuaHand();')) throw new Error('ruaHand：onBody 分支未命中');
      return out;
    },
  },
`;

if (!s.includes(anchor)) { console.log('MISS anchor'); process.exit(1); }
s = s.replace(anchor, block + anchor);
fs.writeFileSync(p, s, 'utf8');
console.log('已加 ruaHand');
