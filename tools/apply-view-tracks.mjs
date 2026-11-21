/**
 * 把 Dance / Groove 里的整图变换轨道（ViewRoll / ViewX / ViewY）补进 profile 的五个舞。
 *
 * 之前跳过是因为 figure 没有消费者（kit 里只有 groupTilt，没有整图平移）；
 * 现在 figure 补了 groupTilt（ViewRoll）和 groupMove（ViewX/ViewY），这几个虚拟参数终于有人读了。
 *
 *   node tools/apply-view-tracks.mjs            只打印
 *   node tools/apply-view-tracks.mjs --write    写进 profile
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { DANCES } from './gen-dance.mjs';

const p = 'models/deepseek/profile.js';
const write = process.argv.includes('--write');
const WANT = ['ViewRoll', 'ViewX', 'ViewY'];

const lines = readFileSync(p, 'utf8').split('\n');

for (const [word, { tracks }] of Object.entries(DANCES)) {
  const wanted = WANT.filter((id) => tracks[id]);
  if (!wanted.length) continue;

  const iWord = lines.findIndex((l) => new RegExp(`^ {4}['"]${word}['"]?:`).test(l));
  if (iWord < 0) { console.log('跳过（找不到词）', word); continue; }
  let iEnd = iWord + 1;
  while (iEnd < lines.length && !/^ {4}['"]?[a-zA-Z0-9_-]+['"]?:/.test(lines[iEnd])) iEnd++;

  let iKeys = -1;
  for (let i = iWord; i < iEnd; i++) if (/^\s*keys: \[/.test(lines[i])) { iKeys = i; break; }
  if (iKeys < 0) { console.log('跳过（没有 keys 数组）', word); continue; }

  let iClose = iKeys;
  while (iClose < iEnd && !/^\s*\],\s*$/.test(lines[iClose])) iClose++;
  if (iClose >= iEnd) { console.log('跳过（找不到 keys 收尾）', word); continue; }

  if (lines.slice(iKeys, iClose).some((l) => /id: 'View(Roll|X|Y)'/.test(l))) {
    console.log('已有 View 轨道', word);
    continue;
  }

  const block = [];
  for (const id of wanted) {
    const pairs = tracks[id];
    for (let i = 0; i < pairs.length; i += 4) {
      const seg = pairs.slice(i, i + 4).map(([t, v]) => `{ id: '${id}', t: ${t}, v: ${v} }`).join(', ');
      block.push('        ' + seg + ',');
    }
  }
  console.log(`--- ${word}：补 ${wanted.join(' / ')}（${wanted.map((w) => tracks[w].length).join('/')} 点）`);
  if (write) lines.splice(iClose, 0, ...block);
}

if (write) { writeFileSync(p, lines.join('\n'), 'utf8'); console.log('写入完成'); }
