import fs from 'node:fs';

const p = 'tools/patch-pet-kit.mjs';
let s = fs.readFileSync(p, 'utf8');
if (s.includes("id: 'rightHoldMenu'")) { console.log('已存在'); process.exit(0); }

const anchor = "  {\n    file: 'petapp', id: 'skitNote',";

const NEW = `/* 2026-11-22：右键长按 = rua（kit 里按头区），单击才是菜单。
   在 Windows 上 contextmenu 是「右键松开」时触发，所以用按住的时长区分：
   250ms 内松开 = 单击（菜单），超过 = 长按（rua 已经由 kit 接管，不弹菜单）。 */
let rightDownAt = 0;
document.addEventListener('pointerdown', (e) => { if (e.button === 2) rightDownAt = performance.now(); }, { capture: true });
document.addEventListener('pointerup', (e) => {
  // 在别处（比如桌面）松开不会有 contextmenu，300ms 后自己清掉，免得影响下一次
  if (e.button === 2) setTimeout(() => { rightDownAt = 0; }, 300);
}, { capture: true });
document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const held = rightDownAt ? performance.now() - rightDownAt : 999;
  rightDownAt = 0;
  if (held < 250 && body?.hit({ x: e.clientX, y: e.clientY })) openMenu();
});`;

const OLD = `document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (body?.hit({ x: e.clientX, y: e.clientY })) openMenu();
});`;

const block = `  {
    file: 'petapp', id: 'rightHoldMenu',
    desc: '右键长按 = rua（kit 里按头区），单击 = 原来的菜单：250ms 内松开才算单击',
    detect: (s) => /右键长按 = rua/.test(s),
    apply: (s) => {
      const a = ${JSON.stringify(OLD)};
      const b = ${JSON.stringify(NEW)};
      if (!s.includes(a)) throw new Error('rightHoldMenu：contextmenu 锚点未命中');
      return s.replace(a, b);
    },
  },
`;

if (!s.includes(anchor)) { console.log('MISS anchor'); process.exit(1); }
s = s.replace(anchor, block + anchor);
fs.writeFileSync(p, s, 'utf8');
console.log('已加 rightHoldMenu');
