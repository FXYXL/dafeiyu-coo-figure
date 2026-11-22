import fs from 'node:fs';

const p = 'tools/patch-pet-kit.mjs';
let s = fs.readFileSync(p, 'utf8');

if (s.includes("id: 'noHoverPet'")) { console.log('已存在，跳过'); process.exit(0); }

const anchor = "  {\n    file: 'body', id: 'emitEvent',";

const block = `  {
    file: 'body', id: 'noHoverPet',
    desc: '关掉「划过 320px 就摸头」的原生反应（用户：鼠标从身上划过去就触发，还不用按键）',
    detect: (s) => /划过不再有任何反应/.test(s),
    apply: (s) => {
      const a = \`    const over = hitPet(p);
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
    return (pet.cursor = over ? 'grab' : '');\`;
      const b = \`    const over = hitPet(p);
    // 2026-11-22：划过不再有任何反应（用户：鼠标从她身上划过去就触发摸头，还不用按键）。
    // 轻摸改成必须右键按住：头/脸是持续 rua，其它区在 pointerDown 里一次性处理。
    return (pet.cursor = over ? 'grab' : '');\`;
      if (!s.includes(a)) throw new Error('noHoverPet：划过段锚点未命中');
      return s.replace(a, b);
    },
  },
  {
    file: 'body', id: 'ruaHeadOnly',
    desc: '右键只有头/脸区进入 rua（用户：摸哪里都算摸头）；其它区不接管，留给页面区分单击/长按',
    detect: (s) => /只有头\\/脸才进入 rua/.test(s),
    apply: (s) => {
      const a = \`    if (p.button === 2) {
      if (pet.mode === 'walk' || pet.mode === 'run') setMode('idle');
      press = null;\`;
      const b = \`    if (p.button === 2) {
      if (pet.mode === 'walk' || pet.mode === 'run') setMode('idle');
      press = null;
      // 2026-11-22：只有头/脸才进入 rua（用户：摸哪里都算摸头）。其它区右键不接管，
      // 交给页面区分单击（菜单）和长按（P3 的一次性轻摸）。
      {
        const _z = zoneAt(p);
        if (_z !== 'head' && _z !== 'face') { pointer.samples = [{ t: now(p), x: p.x, y: p.y }]; return true; }
      }\`;
      if (!s.includes(a)) throw new Error('ruaHeadOnly：pointerDown 锚点未命中');
      return s.replace(a, b);
    },
  },
`;

if (!s.includes(anchor)) { console.log('MISS anchor'); process.exit(1); }
s = s.replace(anchor, block + anchor);
fs.writeFileSync(p, s, 'utf8');
console.log('已加 noHoverPet / ruaHeadOnly');
