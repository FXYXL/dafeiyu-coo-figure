#!/usr/bin/env node
/**
 * 按 DeepFish 的 Body.cs 重算 Dance / Groove 曲线，和 profile 里的舞蹈词对账。
 *
 *   node tools/gen-dance.mjs            只对比（打印差异）
 *   node tools/gen-dance.mjs --write    把算出来的 keys 写回 profile（保留我们的参数映射）
 *
 * 他们那边是程序化生成（Body.cs:140 Dance / :179 Groove），没有手写表；
 * 我们这边是提前算成 keys 存进 profile —— 所以一旦他们改了拍子系数（比如 .4*8/6、
 * 整体 /0.7 的变速），我们就得跟着重算，否则会出现「时长对了但幅度/相位是老版」的情况。
 */
import { readFileSync, writeFileSync } from 'node:fs';

const PROFILE = new URL('../models/deepseek/profile.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const round = (v, n = 3) => Math.round(v * 10 ** n) / 10 ** n;

// ---------- Body.cs:140 Dance ----------
function dance(size, beats, hits, dip, stretch = 1) {
  const gaps = beats.map((b) => (b / 0.7) * stretch);
  const times = [];
  times[0] = gaps[0] / 2;
  for (let i = 1; i < hits.length; i++) times[i] = times[i - 1] + (gaps[i - 1] + gaps[i]) / 2;
  const end = gaps.reduce((a, b) => a + b, 0);
  const HEAD_LAG = 0.14;
  const track = (amount, extra, at, lag = 0) => {
    const keys = [[0, 0]];
    for (let i = 0; i < hits.length; i++) {
      keys.push([times[i] + lag, at(i) * amount]);
      if (i + 1 < hits.length && dip && Math.sign(hits[i]) === Math.sign(hits[i + 1])) {
        keys.push([(times[i] + times[i + 1]) / 2 + lag, at(i) * amount * extra]);
      }
    }
    keys.push([end + lag, 0]);
    return keys.map(([t, v]) => [round(t), round(v * size)]);
  };
  const arch = (high, low, lag = 0) => {
    const keys = [[0, 0]];
    for (let i = 0; i < hits.length; i++) {
      keys.push([times[i] + lag, low]);
      if (i + 1 < hits.length) {
        keys.push([(times[i] + times[i + 1]) / 2 + lag, Math.sign(hits[i]) === Math.sign(hits[i + 1]) ? high * 0.25 : high]);
      }
    }
    keys.push([end + lag, 0]);
    return keys.map(([t, v]) => [round(t), round(v * size)]);
  };
  return {
    dur: round(end),
    tracks: {
      ParamBodyAngleX: track(13, 0.55, (i) => hits[i]),
      ParamBodyAngleZ: track(6.5, 0.55, (i) => hits[i]),
      ViewRoll: track(2.5, 0.55, (i) => hits[i]),
      ViewX: track(0.02, 0.55, (i) => hits[i]),
      FaceAngleX: track(-19, 0.55, (i) => hits[i], HEAD_LAG),
      FaceAngleZ: track(-8, 0.55, (i) => hits[i], HEAD_LAG),
      FaceAngleY: arch(9.5, -4.5, HEAD_LAG),
    },
  };
}

// ---------- Body.cs:179 Groove ----------
function groove(size, beats, hits, stretch = 1) {
  const gaps = beats.map((b) => (b / 0.7) * stretch);
  const times = [];
  times[0] = gaps[0] / 2;
  for (let i = 1; i < hits.length; i++) times[i] = times[i - 1] + (gaps[i - 1] + gaps[i]) / 2;
  const end = gaps.reduce((a, b) => a + b, 0);
  const again = (i) => i > 0 && Math.sign(hits[i]) === Math.sign(hits[i - 1]);
  const side = (amount, lag = 0, back = 0.45) => {
    const keys = [[0, 0]];
    for (let i = 0; i < hits.length; i++) {
      keys.push([times[i] + lag, hits[i] * amount * (again(i) ? 1.15 : 1)]);
      if (i + 1 < hits.length && Math.sign(hits[i]) === Math.sign(hits[i + 1])) {
        keys.push([(times[i] + times[i + 1]) / 2 + lag, hits[i] * amount * back]);
      }
    }
    keys.push([end + lag, 0]);
    return keys.map(([t, v]) => [round(t), round(v * size)]);
  };
  const bounce = (down, up, lag = 0) => {
    const keys = [[0, 0]];
    for (let i = 0; i < hits.length; i++) {
      keys.push([times[i] + lag, down * Math.abs(hits[i])]);
      if (i + 1 < hits.length) {
        keys.push([(times[i] + times[i + 1]) / 2 + lag, (up * (Math.abs(hits[i]) + Math.abs(hits[i + 1]))) / 2]);
      }
    }
    keys.push([end + lag, 0]);
    return keys.map(([t, v]) => [round(t), round(v * size)]);
  };
  return {
    dur: round(end),
    tracks: {
      FaceAngleZ: side(21, 0.06),
      FaceAngleX: side(9, 0.1),
      FaceAngleY: bounce(-4, 3, 0.05),
      ShoulderYy: side(14),
      ShoulderX: side(10),
      ParamBodyAngleZ: side(5),
      ParamBodyAngleX: side(4),
      ViewRoll: side(1.2),
      ViewY: bounce(-0.008, 0.004),
    },
  };
}

const rep = (v, n) => Array.from({ length: n }, () => v);
const DEAD = new Set(['ParamBodyAngleX', 'ParamBodyAngleZ']);
const ALT6 = [1, -1, 1, -1, 1, -1];
const ALT12 = rep(1, 12).map((_, i) => (i % 2 ? -1 : 1));

// 他们 Body.cs 里的五个舞（size 都是 1，由词语的 微/大 修饰缩放）
export const DANCES = {
  'sway-1': dance(1, rep(0.45, 12), ALT12, false),                       // Body.cs:124
  'dance': groove(1, rep((0.4 * 8) / 6, 6), ALT6),                        // Body.cs:126 摇摆二
  'theater-sway-1': dance(0.7, rep(0.45, 12), ALT12, false, 1 / 0.7),     // Body.cs:129
  'theater-sway-2': groove(0.7, rep((0.4 * 8) / 6, 6), ALT6, 1 / 0.7),     // Body.cs:130
  'slow-sway': groove(1, [0.7, 0.9, 1.1], [1, -0.7, 0.4]),                // Body.cs:133 慢摇
};

// 他们的参数名 → 我们的（腰/胯是物理输出，走 keysPost；整图变换走虚拟参数）
export const MAP = {
  FaceAngleX: { id: 'AngleX', post: false },
  FaceAngleY: { id: 'AngleY', post: false },
  FaceAngleZ: { id: 'AngleZ', post: false },
  ShoulderYy: { id: 'ShoulderY', post: false },
  ShoulderX: { id: 'ShoulderX', post: false },
  // ViewRoll / ViewX / ViewY 是他们的「整图变换」输入（main.cpp:565 的 bodyRoll/bodyX/bodyY）。
  // 我们这边现在有消费者了：figure.groupTilt 把 ViewRoll 并进整组旋转，
  // figure.groupMove 把 ViewX/ViewY 交给 kit 的组平移（patch-pet-kit 的 groupMove）。
  ViewRoll: { id: 'ViewRoll', post: false },
  ViewX: { id: 'ViewX', post: false },
  ViewY: { id: 'ViewY', post: false },
};

if (process.argv[1] && process.argv[1].endsWith('gen-dance.mjs')) {
  const { paramActs } = (await import(new URL('../models/deepseek/profile.js', import.meta.url).href)).default
    ?? (await import(new URL('../models/deepseek/profile.js', import.meta.url).href));
  let bad = 0;
  for (const [word, { dur, tracks }] of Object.entries(DANCES)) {
    const cur = paramActs[word];
    const ours = new Map();
    for (const f of [...(cur?.keys ?? []), ...(cur?.keysPost ?? [])]) {
      if (!ours.has(f.id)) ours.set(f.id, []);
      ours.get(f.id).push([f.t, f.v]);
    }
    const problems = [];
    if (Math.abs((cur?.dur ?? 0) - dur) > 0.02) problems.push(`dur ${cur?.dur} ≠ ${dur}`);
    for (const [theirId, keys] of Object.entries(tracks)) {
      const m = MAP[theirId];
      if (!m) {
        // ParamBodyAngleX/Z：DeepFish 写在物理之前、被物理覆盖（main.cpp:610 → :631），等效不存在。
        // 我们若在 keysPost 里补写就是多出来的一截（2026-11-24 实测）。dance（摇摆二）是用户另外调过的，不查。
        if (DEAD.has(theirId) && word !== 'dance' && ours.has(theirId)) problems.push(`${theirId} 不该物理后补写（DeepFish 里被物理覆盖）`);
        continue;
      }      const have = ours.get(m.id);
      if (!have) { problems.push(`${m.id} 缺整条`); continue; }
      if (have.length !== keys.length) { problems.push(`${m.id} 点数 ${have.length}≠${keys.length}`); continue; }
      let worst = 0;
      for (let i = 0; i < keys.length; i++) {
        worst = Math.max(worst, Math.abs(have[i][0] - keys[i][0]), Math.abs(have[i][1] - keys[i][1]) / 20);
      }
      if (worst > 0.02) problems.push(`${m.id} 偏差 ${worst.toFixed(2)}`);
    }
    // 我们自己的适配轨道（PositionX 驱动胸晃、HipAngleX 扭胯…）不算差异
    const ADAPT = new Set(['PositionX', 'ParamBodyAngleRZ', 'HipAngleX', 'ParamAngleX', 'ParamAngleY', 'ParamAngleZ']);
    const extra = [...ours.keys()].filter((id) => !Object.values(MAP).some((m) => m.id === id) && !ADAPT.has(id) && !DEAD.has(id));
    if (problems.length || extra.length) {
      bad++;
      console.log(`✗ ${word}（理论 dur ${dur}）`);
      for (const p of problems) console.log('   ', p);
      if (extra.length) console.log('    我们没有对应映射:', extra.join(','));
    } else {
      console.log(`✓ ${word}`);
    }
  }
  console.log(bad ? `\n${bad} 个词对不上` : '\n全部一致');
}
