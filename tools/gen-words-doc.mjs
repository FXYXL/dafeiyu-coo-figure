#!/usr/bin/env node
/**
 * 从 figure.json 生成 WORDS.md（完整词表）。
 *
 *   node tools/gen-words-doc.mjs
 *
 * 词表是 figure.json 里的 source of truth，这份文档只是它的可读视图；
 * 加了词之后重跑一次，不要再手改 WORDS.md。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const figurePath = path.join(root, 'figure.json');
const outPath = path.join(root, 'WORDS.md');

const figure = JSON.parse(fs.readFileSync(figurePath, 'utf8'));
const words = Object.values(figure.vocab || {});

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const zhName = (w) => (w.names?.zh || []).join(' / ') || w.id;
const enName = (w) => (w.names?.en || [])[0] || '';
const remarks = (w) => {
  const out = [];
  if (w.lasting) out.push('保持到下一个动作');
  if (w.handish) out.push('切换手臂');
  return out.join('，');
};
const seconds = (w) => (typeof w.seconds === 'number' ? `${w.seconds}s` : '—');

// 保持 figure.json 里的原始顺序：常用的在前，后面是按批次追加的彩蛋，作者排过序。
const expressions = words.filter((w) => w.kind === 'expression');
const motions = words.filter((w) => w.kind === 'motion');

const table = (list) => {
  const rows = list.map((w) => {
    const en = enName(w);
    const name = en && en !== w.id ? `${esc(zhName(w))}（${esc(en)}）` : esc(zhName(w));
    return `| ${name} | \`${w.id}\` | ${esc(w.about?.zh || '')} | ${seconds(w)} | ${remarks(w)} |`;
  });
  return [
    '| 中文 | id | 说明 | 时长 | 备注 |',
    '|---|---|---|---|---|',
    ...rows,
  ].join('\n');
};

const md = `# 大肥鱼 · 完整词表

> 由 \`figure.json\` 自动生成，共 **${words.length}** 个词（${expressions.length} 个表情 + ${motions.length} 个动作）。
> 当前版本 **${figure.version}**。加词后跑 \`node tools/gen-words-doc.mjs\` 重新生成，不要手改这份文件。

## 怎么用

- 对话里写 **\`<词>\`**（跟着打字走的小动作）或 **\`【词】\`**（另起一个气泡的整段表演）；中文名和 id 都认。
- 一次 1~3 个词最自然；不同部位的词会同时生效（歪头 + 鼓腮 + 脸红）。
- 词前可加修饰：\`微\` / \`大\`（幅度）、\`快\` / \`慢\`（节奏）；一次性的小动作后加 \`×2\` / \`×3\` 重复。
- 方向词默认朝左，加 \`:右\` 镜像，例如 \`看右边:右\`。
- 附加层（脸红 / 冷汗 / 流泪 / 兔牙）可以叠；整脸表情（黑脸 / 圈圈眼 / 爱心眼 / 无语 / 狐疑）一次只有一张脸。
- 想清空所有表情用 **\`恢复\`**。

完整语法与示例见 [README](README.md#词表与语法)。

## 表情（${expressions.length}）

${table(expressions)}

## 动作（${motions.length}）

${table(motions)}
`;

fs.writeFileSync(outPath, md, 'utf8');
console.log(`✓ ${path.relative(root, outPath)}  ${words.length} 词（${expressions.length} 表情 + ${motions.length} 动作）`);
