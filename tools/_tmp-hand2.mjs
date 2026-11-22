import fs from 'node:fs';

const p = 'tools/patch-pet-kit.mjs';
let s = fs.readFileSync(p, 'utf8');

const SKIT_START = s.indexOf("  {\n    file: 'petapp', id: 'ruaHand',");
if (SKIT_START < 0) { console.log('MISS'); process.exit(1); }
const SKIT_END = s.indexOf("\n  },\n", SKIT_START);
if (SKIT_END < 0) { console.log('MISS end'); process.exit(1); }

const HAND = `/* ---------- rua 的白手（照他们 HandWindow：一只几何白手替代指针） ---------- */
const ruaHand = document.createElement('div');
ruaHand.className = 'rua-hand';
ruaHand.hidden = true;
/* 96px：他们 HandSize=.4（效果图里那只的 40%）。第一版按 160px 铺满，脸全被挡住。 */
ruaHand.style.cssText = 'position:fixed;left:0;top:0;width:96px;height:96px;pointer-events:none;z-index:2;opacity:0;transition:opacity .12s ease;will-change:transform;filter:drop-shadow(0 3px 6px rgba(0,0,0,.16))';
ruaHand.innerHTML = \`<svg viewBox="0 0 160 160" width="96" height="96" aria-hidden="true">
  <g fill="#fff" stroke="#c2c6d2" stroke-width="2.6" stroke-linejoin="round">
    <ellipse cx="80" cy="106" rx="25" ry="21"/>
    <rect x="57" y="58" width="13" height="49" rx="6.5" transform="rotate(-24 80 102)"/>
    <rect x="71" y="44" width="13" height="60" rx="6.5" transform="rotate(-8 80 102)"/>
    <rect x="86" y="47" width="13" height="56" rx="6.5" transform="rotate(5 80 102)"/>
    <rect x="100" y="60" width="12" height="44" rx="6" transform="rotate(18 80 102)"/>
    <rect x="42" y="94" width="34" height="13" rx="6.5" transform="rotate(34 80 102)"/>
  </g>
</svg>\`;
stage.append(ruaHand);
/* 指针：inline cursor 会被 stage 的 grab 手形盖掉，用一张 !important 的样式表藏 */
let ruaCursorCss = null;
function showRuaHand() {
  if (!ruaHand.hidden) return;
  ruaHand.hidden = false;
  ruaCursorCss = document.createElement('style');
  ruaCursorCss.textContent = 'html, body, body * { cursor: none !important; }';
  document.head.append(ruaCursorCss);
  requestAnimationFrame(() => { ruaHand.style.opacity = '1'; });
  updateRuaHand();
}
function hideRuaHand() {
  if (ruaHand.hidden) return;
  ruaHand.style.opacity = '0';
  if (ruaCursorCss) { ruaCursorCss.remove(); ruaCursorCss = null; }
  setTimeout(() => { ruaHand.hidden = true; }, 120);
}
/** 手跟着鼠标，朝头部中心倾（他们 HandPoseFor：离中心越远越斜、略压扁）。 */
function updateRuaHand() {
  if (ruaHand.hidden) return;
  const p0 = cursor.at;
  const a = at()?.bubble;
  if (!p0) return;
  let rot = -38, sx = 1;
  if (a) {
    const ux = clamp((p0.x - a.x) / 64, -1.2, 1.2);
    const uy = clamp((p0.y - a.y) / 46, -1.2, 1.2);
    const r = Math.min(Math.hypot(ux, uy), 1.05);
    const nz = Math.max(.55, Math.sqrt(Math.max(0, 1 - r * r * .7)));
    rot = -38 + clamp(ux, -1, 1) * 12;
    sx = .82 + .18 * nz;   // 越往侧面越"扁"（伪 3D）
  }
  ruaHand.style.transform = \`translate(\${p0.x - 48}px, \${p0.y - 56}px) rotate(\${rot}deg) scale(\${sx.toFixed(3)}, 1)\`;
}
document.addEventListener('pointermove', updateRuaHand, { passive: true });
`;

const block = `  {
    file: 'petapp', id: 'ruaHand',
    desc: 'rua 的几何白手：右键摸头时替代指针（rua-start/end 驱动），96px、朝头倾斜、指针用 !important 藏掉',
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
  },`;

s = s.slice(0, SKIT_START) + block + s.slice(SKIT_END + '\n  },'.length);
fs.writeFileSync(p, s, 'utf8');
console.log('ruaHand 已重写（96px + 指针样式表）');
