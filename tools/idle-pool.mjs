#!/usr/bin/env node
/**
 * 闲时动作池：把 profile.idleRepertoire 摊开看，连带算出频率。
 *
 *   node tools/idle-pool.mjs              看当前权重
 *   node tools/idle-pool.mjs --skit=20    假设小剧场权重改成 20 会变成什么样
 *   node tools/idle-pool.mjs --json       机器可读
 *
 * 频率怎么来的（kit/body.js 的 decide）：
 *   每 25~50 秒（平均 37.5）掷一次决定做什么，其中「闲时词」占 24%，
 *   掷中后再按池内权重 w 抽一条。所以某条的平均间隔 ≈ 37.5 / 0.24 / 占比。
 *   走路/跑/看/跳/坐 占掉其余 76%，那些不在这里调。
 */
import fs from 'node:fs';

const arg = (k) => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? Number(hit.slice(k.length + 3)) : null;
};
const SKIT = arg('skit');
const JSON_OUT = process.argv.includes('--json');

const p = (await import('../models/deepseek/profile.js')).default;
const alias = p.wordAlias ?? {};

// id → 中文（取最短的那个别名，通常是常用叫法）
const zh = {};
for (const [k, v] of Object.entries(alias)) if (!zh[v] || k.length < zh[v].length) zh[v] = k;
const NAME = {
  'tilt-look': '歪头看', dazed: '发愣', happy: '开心', 'heart-eyes': '爱心眼', 'eye-half': '半睁眼',
  surprised: '惊讶', blush: '脸红', pout: '嘟嘴', 'smug-face': '得意脸', 'bunny-teeth': '兔牙',
  'tongue-out': '吐舌', 'puff-cheek': '鼓腮', 'tongue-tilt': '吐舌歪头', 'wink-tongue': '吐舌眨眼',
  'wink-slow': '单眼眨', 'glance': '瞟一眼', 'look-around': '左右张望', 'head-swing': '晃头',
  'slow-tilt': '慢歪头', hum: '哼歌', sigh: '叹气', 'drowsy-combo': '犯困', 'slow-sway': '慢摇',
  'theater-sway-1': '剧场摇摆一', 'theater-sway-2': '剧场摇摆二', 'grass-hand': '狗尾草',
  'chest-hand': '抚胸', 'finger-point': '竖手指', swing: '甩草', skit: '小剧场',
};
const label = (w) => NAME[w] ?? zh[w] ?? w;

// 池子（可按 --skit 覆盖小剧场的权重，方便试算）
const pool = p.idleRepertoire.map((it) => ({ ...it }));
if (SKIT !== null) for (const it of pool) if (it.word === 'skit') it.w = SKIT;

const total = pool.reduce((a, x) => a + (x.w ?? 1), 0);
const gapSec = (w) => 37.5 / 0.24 / (w / total);
const fmt = (s) => (s < 90 ? `${Math.round(s)} 秒` : s < 5400 ? `${Math.round(s / 60)} 分钟` : `${(s / 3600).toFixed(1)} 小时`);

if (JSON_OUT) {
  console.log(JSON.stringify(pool.map((it) => ({ ...it, pct: (it.w ?? 1) / total, gap: gapSec(it.w ?? 1) })), null, 1));
} else {
  const kindName = { face: '表情', act: '动作' };
  const groups = ['face', 'act'];
  console.log(`\n闲时池：${pool.length} 条，总权重 ${total}（小剧场 ${pool.find((x) => x.word === 'skit')?.w}）\n`);
  for (const g of groups) {
    const rows = pool.filter((x) => (x.kind ?? 'act') === g).sort((a, b) => (b.w ?? 1) - (a.w ?? 1));
    const sum = rows.reduce((a, x) => a + (x.w ?? 1), 0);
    console.log(`— ${kindName[g]}（${rows.length} 条，合计权重 ${sum}，${(sum / total * 100).toFixed(0)}%）`);
    for (const r of rows) {
      const pct = (r.w ?? 1) / total;
      console.log(`  ${label(r.word).padEnd(10)} ${String(r.w ?? 1).padStart(3)}  ${(pct * 100).toFixed(1).padStart(5)}%  ≈${fmt(gapSec(r.w ?? 1)).padStart(8)}一次${r.life ? `  (挂 ${r.life}s)` : ''}`);
    }
    console.log('');
  }
  const skit = pool.find((x) => x.word === 'skit');
  console.log(`— 小剧场：权重 ${skit.w}，占 ${(skit.w / total * 100).toFixed(0)}%，≈${fmt(gapSec(skit.w))}一次（每段 7~28 秒，实际会更稀）`);
  console.log(`\n提示：改 profile.idleRepertoire 里的 w 即可；--skit=N 可以试算。`);
}
