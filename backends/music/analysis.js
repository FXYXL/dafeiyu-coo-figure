/** Port of DeepFish Beat.cs / Tempo.cs / Music.cs.
 * Seconds are supplied by callers; no IO or animation phase driving here.
 */
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
export function roundEven(x) {
  const n = Math.floor(x), f = x - n;
  return f === 0.5 ? (n % 2 === 0 ? n : n + 1) : Math.round(x);
}
export class TempoTracker {
  constructor() { this.reset(); }
  reset() { this.seconds = 0.62; this.last = null; this.beats = 0; }
  get bpm() { return clamp(60 / this.seconds, 40, 190); }
  beat(t) {
    if (this.last === null) { this.last = t; this.beats++; return true; }
    const gap = t - this.last;
    if (gap < 0.25) return false;
    if (gap > 2.6) { this.last = t; return false; }
    let unit = gap;
    if (gap > this.seconds * 1.7) {
      const folded = gap / Math.max(1, roundEven(gap / this.seconds));
      if (folded > 0.25 && Math.abs(folded - this.seconds) < this.seconds * 0.2) unit = folded;
    }
    unit = clamp(unit, this.seconds * 0.55, this.seconds * 1.8);
    this.seconds += (unit - this.seconds) * (this.beats < 3 ? 0.44 : 0.25);
    this.last = t; this.beats++; return true;
  }
}
const CELL = 0.025, DELAY = 0.035, RING = 1024, WINDOW = 320, MASK = RING - 1;
const KERNEL = Array.from({ length: 9 }, (_, i) => Math.exp(-0.5 * ((i - 4) / 1.4) ** 2));
const KSUM = KERNEL.reduce((a, b) => a + b, 0);
for (let i = 0; i < 9; i++) KERNEL[i] /= KSUM;
export class BeatTracker {
  constructor() {
    this.ring = new Float32Array(RING); this.smooth = new Float64Array(WINDOW);
    this.centered = new Float64Array(WINDOW); this.scores = new Float64Array(121);
    this.period = 0.6; this.anchor = 0; this.anchorIndex = 0; this.reset();
  }
  reset() {
    this.ring.fill(0); this.head = this.firstCell = -1; this.nextUpdate = 0;
    this.quietSince = -1; this.lastClearAt = 0; this.locked = this.anchored = false;
    this.candidate = 0; this.candidateRuns = this.strangerRuns = this.jumpRuns = 0; this.clarity = 0;
  }
  get isLocked() { return this.locked && this.anchored; }
  get bpm() { return 60 / this.period; }
  position(t) { return this.anchored ? this.anchorIndex + (t - this.anchor) / this.period : NaN; }
  add(t, onset) {
    if (!(onset >= 0) || !Number.isFinite(onset)) onset = 0;
    const x = (t - DELAY) / CELL, cell = Math.floor(x), part = x - cell;
    if (this.head < 0) { this.head = this.firstCell = cell; this.ring.fill(0); }
    else if (cell + 1 - this.head >= RING) { this.ring.fill(0); this.head = this.firstCell = cell; }
    else if (cell < this.head - WINDOW) return;
    while (this.head < cell + 1) { this.head++; this.ring[this.head & MASK] = 0; }
    // C# casts each contribution to float before adding to its float ring.
    this.ring[cell & MASK] += Math.fround(onset * (1 - part));
    this.ring[(cell + 1) & MASK] += Math.fround(onset * part);
    if (t >= this.nextUpdate && this.head - this.firstCell >= 162) {
      this.nextUpdate = t + 0.5; this.analyze(t, this.head - 2);
    }
  }
  static prior(bpm) { const x = Math.log2(bpm / 115) / 0.7; return Math.exp(-0.5 * x * x); }
  static score(z, n, bpm) {
    const lag = 60 / bpm / CELL; let total = 0;
    for (let m = 1; m <= 4; m *= 2) {
      const length = lag * m, i = Math.trunc(length), f = length - i;
      if (i + 1 >= n) continue;
      let sum = 0; const count = n - i - 1;
      for (let k = 0; k < count; k++) sum += z[k] * (z[k + i] * (1 - f) + z[k + i + 1] * f);
      total += (m === 1 ? 1 : m === 2 ? 0.5 : 0.25) * sum / count;
    }
    return total;
  }
  static related(ratio) { return [1, 2, 0.5, 1.5, 2 / 3].some((h) => Math.abs(ratio / h - 1) < 0.04); }
  analyze(now, end) {
    const n = Math.min(WINDOW, end - this.firstCell + 1); if (n < 160) return;
    const begin = end - n + 1; let mean = 0;
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let k = -4; k <= 4; k++) {
        const cell = begin + i + k;
        if (cell < begin || cell > end) continue;
        sum += this.ring[cell & MASK] * KERNEL[k + 4];
      }
      this.smooth[i] = sum; mean += sum;
    }
    mean /= n;
    if (mean < 0.0008) {
      if (this.quietSince < 0) this.quietSince = now;
      if (this.locked && now - this.quietSince > 3) this.locked = false;
      return;
    }
    this.quietSince = -1;
    for (let i = 0; i < n; i++) this.centered[i] = this.smooth[i] - mean;
    let best = -Number.MAX_VALUE, topBpm = 0;
    for (let i = 0; i < this.scores.length; i++) {
      const bpm = 60 + i;
      this.scores[i] = BeatTracker.score(this.centered, n, bpm) * BeatTracker.prior(bpm);
      if (this.scores[i] > best) { best = this.scores[i]; topBpm = bpm; }
    }
    const magnitudes = Array.from(this.scores, Math.abs).sort((a, b) => a - b);
    const clarity = best / (magnitudes[magnitudes.length >> 1] + 1e-12); this.clarity = clarity;
    if (clarity >= 1.5) this.lastClearAt = now;
    if (!this.locked) {
      if (clarity < 3) { this.candidateRuns = 0; return; }
      if (this.candidateRuns > 0 && Math.abs(topBpm / this.candidate - 1) < 0.05) this.candidateRuns++;
      else { this.candidate = topBpm; this.candidateRuns = 1; }
      if (this.candidateRuns < 2) return;
      this.period = 60 / topBpm; this.locked = true; this.anchored = false;
      this.strangerRuns = this.jumpRuns = 0; this.lastClearAt = now;
    } else {
      const current = 60 / this.period; let currentScore = -Number.MAX_VALUE;
      for (let bpm = current * 0.96; bpm <= current * 1.04; bpm += 0.5)
        currentScore = Math.max(currentScore, BeatTracker.score(this.centered, n, bpm));
      currentScore *= BeatTracker.prior(current);
      if (best > (BeatTracker.related(topBpm / current) ? 2.5 : 1.4) * currentScore && clarity >= 3) this.strangerRuns++;
      else this.strangerRuns = Math.max(0, this.strangerRuns - 1);
      if (this.strangerRuns >= 6) {
        this.period = 60 / topBpm; this.anchored = false; this.strangerRuns = this.jumpRuns = 0;
      } else {
        let bestFine = current, bestFineScore = -Number.MAX_VALUE;
        for (let bpm = current * 0.96; bpm <= current * 1.04; bpm += 0.25) {
          const s = BeatTracker.score(this.centered, n, bpm);
          if (s > bestFineScore) { bestFineScore = s; bestFine = bpm; }
        }
        this.period = 0.85 * this.period + 0.15 * (60 / bestFine);
      }
      if (now - this.lastClearAt > 12) { this.locked = false; this.candidateRuns = 0; return; }
    }
    this.findPhase(this.smooth, n, end);
  }
  findPhase(e, n, end) {
    const cells = this.period / CELL; let bestPhase = 0, bestValue = -Number.MAX_VALUE;
    for (let phase = 0; phase < cells; phase += 0.2) {
      let sum = 0, weight = 1, total = 0;
      for (let x = n - 1 - phase; x >= 0; x -= cells) {
        const i = Math.trunc(x), f = x - i;
        const v = i + 1 < n ? e[i] * (1 - f) + e[i + 1] * f : e[i];
        sum += weight * v; total += weight; weight *= 0.93;
      }
      if (total > 0 && sum / total > bestValue) { bestValue = sum / total; bestPhase = phase; }
    }
    const lastBeat = (end - bestPhase) * CELL;
    if (!this.anchored) { this.anchor = lastBeat; this.anchorIndex = 0; this.anchored = true; this.jumpRuns = 0; return; }
    const m = roundEven((lastBeat - this.anchor) / this.period);
    const error = lastBeat - (this.anchor + m * this.period); let gain = 0.3;
    if (Math.abs(error) > this.period * 0.25) {
      this.jumpRuns++; gain = this.jumpRuns >= 4 ? 1 : 0.08;
      if (this.jumpRuns >= 4) this.jumpRuns = 0;
    } else this.jumpRuns = 0;
    this.anchor += m * this.period + gain * error; this.anchorIndex += m;
  }
}

export class MusicAnalysis {
  constructor() { this.reset(); }
  reset() {
    this.beats = new BeatTracker(); this.tempo = new TempoTracker(); this.playing = false;
    this.lastOnsetBase = this.bass = this.rms = this.soundFor = this.level = this.bassSmooth = this.warmup = 0;
    this.fluxAverage = 0.012; this.lastSoundAt = this.lastLineAt = -Infinity; this.lastRead = 0;
    this.beatTimes = []; this.apps = []; this.error = null;
  }
  ingest(raw, t) {
    this.lastLineAt = t;
    if (!raw || raw.error) { this.error = raw?.error ?? 'disconnected'; return; }
    if (raw.ready) { this.error = null; return; }
    if (!Number.isFinite(raw.rms)) return;
    this.error = null;
    if (Array.isArray(raw.apps)) {
      const apps = new Map();
      for (const item of raw.apps) if (Array.isArray(item) && typeof item[0] === 'string' && Number.isFinite(item[1])) {
        const name = item[0].trim().toLowerCase();
        if (name) apps.set(name, Math.max(apps.get(name) ?? 0, item[1]));
      }
      this.apps = [...apps];
    }
    const values = (Array.isArray(raw.bands) ? raw.bands : []).filter(Number.isFinite).slice(0, 3);
    const low = values.slice(0, 2).reduce((a, b) => a + b, 0) / (Math.min(2, values.length) || 1);
    const onsetBase = Math.sqrt(Math.max(0, values.reduce((a, b) => a + b, 0) / (values.length || 1)));
    this.beats.add(t, Math.max(0, onsetBase - this.lastOnsetBase)); this.lastOnsetBase = onsetBase;
    this.rms = raw.rms;
    const rise = Math.max(0, low - this.bass); this.bass = low;
    this.fluxAverage += (rise - this.fluxAverage) * 0.06;
    const beat = rise > this.fluxAverage * 1.6 + 0.003 && low > 0.008;
    if (raw.rms >= 0.0022) {
      const gap = t - this.lastSoundAt;
      this.soundFor = gap > 0 && gap < 1.5 ? this.soundFor + gap : 0.05;
      this.lastSoundAt = t;
    } else this.soundFor = Math.max(0, this.soundFor - 0.15);
    if (!this.playing) {
      if (this.soundFor >= 1.1) { this.playing = true; this.tempo.reset(); this.beatTimes = []; }
      return;
    }
    if (beat && this.tempo.beat(t)) { this.beatTimes.push(t); this.beatTimes = this.beatTimes.filter((at) => t - at <= 20); }
  }
  read(t) {
    const dt = clamp(t - this.lastRead, 0, 0.25); this.lastRead = t;
    if (this.playing && t - this.lastSoundAt > 7) { this.playing = false; this.soundFor = 0; this.beats.reset(); }
    const stale = t - this.lastLineAt > 6;
    if (this.playing && stale) this.playing = false;
    if (this.playing) {
      const signal = this.rms <= 0.0022 ? 0 : clamp((Math.log10(this.rms) - Math.log10(0.0022)) / 2, 0, 1);
      this.level += (signal - this.level) * (1 - Math.exp(-dt / 0.18));
      this.bassSmooth += (this.bass - this.bassSmooth) * (1 - Math.exp(-dt / 0.10));
      this.warmup += (1 - this.warmup) * (1 - Math.exp(-dt / 0.5));
    }
    const beatCount = this.beatTimes.filter((at) => t - at < 8).length;
    return { playing: this.playing, rhythmic: beatCount >= 3, beatCount,
      bpm: this.beats.isLocked ? this.beats.bpm : this.tempo.bpm,
      locked: this.beats.isLocked, clarity: this.beats.clarity,
      level: this.playing ? this.level * (0.62 + 0.38 * this.warmup) : 0,
      bass: this.playing ? this.bassSmooth : 0, rms: this.rms, apps: this.apps, stale, error: this.error };
  }
}
