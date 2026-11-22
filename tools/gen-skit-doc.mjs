#!/usr/bin/env node
/**
 * 把小剧场导出成一份给人读的文档（她要审台词用，不参与运行）。
 *
 *   node tools/gen-skit-doc.mjs ["输出路径"]
 *
 * 默认输出到 D:/AI/大肥鱼形象用/小剧场台词.md
 */
import fs from 'node:fs';

const OUT = process.argv[2] || 'D:/AI/大肥鱼形象用/小剧场台词.md';
const profile = (await import('../models/deepseek/profile.js')).default;
const alias = profile.wordAlias ?? {};

// id → 中文（取第一个出现的，优先短词）
const back = {};
for (const [zh, id] of Object.entries(alias)) {
  if (!back[id] || zh.length < back[id].length) back[id] = zh;
}
const MOD = (x) => {
  const bits = [];
  if (x.scale !== undefined) bits.push(x.scale > 1 ? '用力' : '轻');
  if (x.pace !== undefined) bits.push(x.pace < 1 ? '快' : '慢');
  if (x.repeat !== undefined) bits.push(`×${x.repeat}`);
  if (x.side === -1) bits.push('右手边');
  return bits.length ? `（${bits.join('·')}）` : '';
};
const zh = (x) => {
  if (typeof x === 'string') return back[x] ?? x;
  return (back[x.w] ?? x.w) + MOD(x);
};

const lines = [];
lines.push('# 小剧场台词（13 段）');
lines.push('');
lines.push('待机时偶尔自己演一小段，**随机抽**，约 3~4 分钟一次（测试期频率，正式是 20 分钟）。');
lines.push('台词是固定的、我这边写好放进去的，**不进对话上下文**——她不会记得自己说过这些。');
lines.push('演到一半她真的开口说话、或者被拖动/走路，会立刻打断。');
lines.push('');
lines.push('想改哪句直接说，或者改 `repo/tools/data/skits.txt` 再重新生成。');
lines.push('');
lines.push('| # | 名字 | 句数 | 时长 | 道具 |');
lines.push('|---|---|---|---|---|');
profile.skits.forEach((s, i) => {
  const lines2 = s.steps.filter((x) => x.say).length;
  lines.push(`| ${i + 1} | ${s.title ?? s.id} | ${lines2} | ${s.dur}s | ${(s.props ?? []).map((p) => back[p] ?? p).join('、') || '—'} |`);
});
lines.push('');

for (const s of profile.skits) {
  const sayN = s.steps.filter((x) => x.say).length;
  lines.push(`## ${s.title ?? s.id}（${s.dur} 秒，${sayN} 句）`);
  if (s.props?.length) lines.push(`\n道具：${s.props.map((p) => back[p] ?? p).join('、')}（开演戴上，演完自己摘）\n`);
  lines.push('');
  lines.push('| 时间 | 台词 | 同时做的动作 |');
  lines.push('|---|---|---|');
  for (const st of s.steps) {
    const t = `${st.at}s`;
    const say = st.say ? st.say : '（不说话）';
    const acts = (st.w ?? []).map(zh).join('、') || '—';
    lines.push(`| ${t} | ${say} | ${acts} |`);
  }
  lines.push('');
}

fs.writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log('已写入', OUT, '（', profile.skits.length, '段）');
