#!/usr/bin/env node
/**
 * 从小剧场脚本生成 profile.skits。
 *
 * 数据源：tools/data/skits.txt（他们的待机小剧场脚本，格式看得懂的那种）
 *   # 名字
 *   @道具 单片眼镜 兔牙        （可选：演的时候临时戴）
 *   台词|动作 动作 动作|停留秒数
 *
 * 生成规则：
 *   - 每行 = 一个 step：at 是前面所有停留秒数的累加
 *   - 动作用空格分开，走 profile.wordAlias 转成 id；几个修饰词在这里展开
 *     （大前倾 = lean-forward×1.8、微点头 = nod×0.5、快摇头×3 = shake 快×3 …）
 *   - 带 @ 的（生日/跨年/亲密度）跳过：那是条件彩蛋，要条件系统，见文件后半段
 *   - 时间轴末端留 0.8 秒收尾；life = dur + 4（她的情绪挂到这个彩蛋结束）
 *
 *   node tools/gen-skits.mjs          只对账（列出每个剧本的时间轴与未知动作词）
 *   node tools/gen-skits.mjs --write  把生成的 skits 写回 profile.js
 */
import fs from 'node:fs';

const WRITE = process.argv.includes('--write');
const SRC = 'tools/data/skits.txt';
const PROFILE = 'models/deepseek/profile.js';

const profile = (await import(`../${PROFILE}?t=${Date.now()}`)).default;
const alias = profile.wordAlias ?? {};

// 标题 → 我们的 id（和现在 profile 里的一一对应）
const IDS = {
  名侦探: 'detective', 认真加班: 'overtime', 偷吃零食: 'snack', 突然入戏: 'entrance',
  魔法少女: 'magical', 学习打瞌睡: 'doze', 自己吓自己: 'selfscare', 吸血鬼: 'vampire',
  小学老师: 'teacher', 减肥计划: 'diet', 寻宝: 'treasure', 保安大叔: 'guard', 跳舞: 'dancefloor',
};

// 他们的「修饰词 + 基础词」连写在别的语言里是一个词，我们拆成 base + 修饰
const COMBO = {
  大前倾: { w: 'lean-forward', scale: 1.8 },  // PetWindow 里「大」= 1.8 倍
  微摇头: { w: 'shake', scale: 0.5 },
  微点头: { w: 'nod', scale: 0.5 },
  慢摇头: { w: 'shake', pace: 1.6 },
  快摇头: { w: 'shake', pace: 0.65 },
  慢眨眼: { w: 'blink', pace: 1.7 },
  快眨眼: { w: 'blink', pace: 0.65 },
  大前倾: { w: 'lean-forward', scale: 1.8 },
};
const PROPS = {
  单片眼镜: 'monocle-face', 黑框眼镜: 'glasses-face', 兔牙: 'bunny-teeth', 钢盆: 'pan-face',
};

/** 一个动作词 → 我们的 step 元素（字符串 = 原样 id；对象 = 带修饰） */
function toPart(word) {
  let s = word.trim();
  if (!s) return null;
  // 方向：瞟一眼:右 / 歪头:右 → 我们的 dirSide（-1 = 镜像）
  let side = 1;
  const m = s.match(/[:：](左|右)$/);
  if (m) { s = s.slice(0, s.length - m[0].length); if (m[1] === '右') side = -1; }
  // 次数：点头×3 / 快眨眼×2
  let repeat = 1;
  const r = /[×x*](\d+)$/.exec(s);
  if (r) { s = s.slice(0, r.index); repeat = Math.max(1, Math.min(6, Number(r[1]))); }
  // 连写修饰词
  if (COMBO[s]) {
    const c = { ...COMBO[s] };
    if (repeat > 1) c.repeat = repeat;
    if (side === -1) c.side = -1;
    return c;
  }
  const id = alias[s];
  if (!id) return { unknown: s };
  if (repeat > 1 || side === -1) {
    const o = { w: id };
    if (repeat > 1) o.repeat = repeat;
    if (side === -1) o.side = -1;
    return o;
  }
  return id;
}

// ---------- 解析 ----------
const lines = fs.readFileSync(SRC, 'utf8').split('\n');
const skits = [];
let cur = null;
for (const raw of lines) {
  const line = raw.trim();
  if (!line || line.startsWith('//')) continue;
  if (line.startsWith('# ')) {
    const title = line.slice(2).trim();
    const base = title.split(/\s+/)[0];
    const cond = title.includes('@');
    cur = { title: base, id: IDS[base] ?? null, cond, prop: null, rows: [] };
    skits.push(cur);
    continue;
  }
  if (!cur) continue;
  if (line.startsWith('@道具')) { cur.prop = line.slice(3).trim(); continue; }
  const p = line.split('|');
  cur.rows.push({
    say: (p[0] ?? '').replace(/｜/g, '').trim(),
    acts: (p[1] ?? '').trim(),
    sec: p[2] !== undefined ? Number(p[2]) : 3.5,
  });
}

// ---------- 生成 ----------
const unknown = new Set();
const out = [];
let at = 0;
const pad = (n) => String(n).replace(/(\.\d)$/, '$10');
for (const sk of skits) {
  if (sk.cond || !sk.id) continue;          // 条件彩蛋先不做
  const steps = [];
  let t = 0;
  // 道具（@道具 单片眼镜…）：他们单独管理、演完才摘，所以「恢复」不该把它清掉。
  // steps 里戴一次，同时记进 def.props —— figure 碰上「恢复」会重戴。
  const props = sk.prop ? sk.prop.split(/\s+/).map((p) => PROPS[p]).filter(Boolean) : [];
  if (props.length) steps.push({ at: 0, w: props });
  for (const row of sk.rows) {
    const parts = row.acts.split(/[\s　]+/).map(toPart).filter(Boolean);
    for (const p of parts) if (p.unknown) unknown.add(p.unknown);
    const clean = parts.filter((p) => !p.unknown);
    const st = { at: Number(t.toFixed(2)), w: clean };
    if (row.say) { st.say = row.say; st.sec = row.sec; }
    else if (row.sec !== 3.5) st.sec = row.sec;
    steps.push(st);
    t += row.sec;
  }
  const dur = Number((t + 0.8).toFixed(2));
  out.push({ id: sk.id, title: sk.title, dur, life: Math.round(dur + 4), props, steps });
}

// ---------- 报告 ----------
for (const s of out) {
  console.log(`\n### ${s.title} (${s.id}) dur=${s.dur}s life=${s.life} ${s.steps.length} 句`);
  for (const st of s.steps) {
    const acts = st.w.map((x) => (typeof x === 'string' ? x : `${x.w}(${[x.scale && `×${x.scale}`, x.pace && `pace${x.pace}`, x.repeat && `×${x.repeat}`, x.side === -1 && '右'].filter(Boolean).join(',')})`)).join(' ');
    console.log(`  ${st.at}s  ${st.say ? '「' + st.say + '」' : '（无词）'}  | ${acts}${st.sec ? ' | ' + st.sec + 's' : ''}`);
  }
}
console.log('\n未知动作词:', unknown.size ? [...unknown].join(' ') : '无');

// ---------- 写回 ----------
if (WRITE) {
  const fmtPart = (x) => {
    if (typeof x === 'string') return `'${x}'`;
    const o = [`w: '${x.w}'`];
    if (x.scale !== undefined) o.push(`scale: ${x.scale}`);
    if (x.pace !== undefined) o.push(`pace: ${x.pace}`);
    if (x.repeat !== undefined) o.push(`repeat: ${x.repeat}`);
    if (x.side !== undefined) o.push(`side: ${x.side}`);
    return `{ ${o.join(', ')} }`;
  };
  const body = out.map((s) => {
    const steps = s.steps.map((st) => {
      const bits = [`at: ${st.at}`, `w: [${st.w.map(fmtPart).join(', ')}]`];
      if (st.say) bits.push(`say: '${st.say.replace(/'/g, "\\'")}', sec: ${st.sec}`);
      else if (st.sec) bits.push(`sec: ${st.sec}`);
      return `        { ${bits.join(', ')} },`;
    }).join('\n');
    const props = s.props.length ? `props: [${s.props.map((x) => `'${x}'`).join(', ')}], ` : '';
    return `    { id: '${s.id}', title: '${s.title}', dur: ${s.dur}, life: ${s.life}, ${props}steps: [\n${steps}\n    ] },`;
  }).join('\n');

  let src = fs.readFileSync(PROFILE, 'utf8');
  const head = `  // ---------- 彩蛋小剧场（照他们的 skits.txt 抄，数据源 tools/data/skits.txt）----------\n`
    + `  // 每行 = 一句台词 + 一组动作（他们的「台词|动作 动作|停留秒数」）。\n`
    + `  //   at  = 这句开始的时间（前面各句停留秒数的累加）\n`
    + `  //   w   = 动作组，一行几个词就同时演；带 scale/pace/repeat/side 的见 gen-skits.mjs 的 COMBO\n`
    + `  //   say = 这句的台词（头顶气泡，走 figure → 页面的旁路，不进 AI 上下文）；没有就是纯动作行\n`
    + `  //   sec = 这句停留秒数，口型按它的 78% 说（说完停一下，不像机器一直念）\n`
    + `  // 条件剧本（生日/跨年/亲密度）没有搬：要条件系统，见 skits.txt 后半段。\n`;
  const re = /  \/\/ ---------- 彩蛋小剧场[\s\S]*?\n  skits: \[[\s\S]*?\n  \],\n/;
  if (!re.test(src)) throw new Error('profile 里找不到 skits 块');
  src = src.replace(re, head + `  skits: [\n${body}\n  ],\n`);
  fs.writeFileSync(PROFILE, src, 'utf8');
  console.log('\n已写入 profile.js');
}
