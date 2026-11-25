/**
 * 听歌的耳朵：拉起 `web/music/probe.ps1`，把每 50ms 一行 JSON 转给 `/music` WebSocket。
 *
 * 为什么在这里：形象包跑在 `/figure-frame` 沙箱里，CSP 只允许连自己的包目录，
 * 不能自己抓音频；引擎服务器是普通 Node 进程，可以 spawn PowerShell。
 *
 * Windows only：probe.ps1 用 WASAPI loopback（NAudio），macOS/Linux 没有。
 * 采集器借自 dsh-whale-pulse（MIT），NAudio 1.10.0（MIT）；不录音、不落盘、不上传。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { WebSocket } from 'ws';

const RETRY_MIN = 2000;
const RETRY_MAX = 30000;

export class MusicEar {
  private probe: ChildProcess | null = null;
  private readonly clients = new Set<WebSocket>();
  private latest = '';
  private failures = 0;
  private retryAt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private warnedMissing = false;
  private watch: ReturnType<typeof setInterval> | null = null;
  private lastLineAt = 0;
  private bornAt = 0;
  private readonly webDir: string;

  constructor(webDir: string) {
    this.webDir = webDir;
  }

  start(): void {
    if (process.platform !== 'win32') {
      console.warn('[music] 只有 Windows 有耳朵（WASAPI loopback），跳过');
      return;
    }
    this.stopped = false;
  }

  attach(ws: WebSocket): void {
    this.clients.add(ws);
    const release = () => {
      this.clients.delete(ws);
      if (!this.clients.size) {
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = null; this.retryAt = 0; this.failures = 0;
        this.drop('无订阅者'); this.latest = '';
      }
    };
    ws.on('close', release);
    ws.on('error', release);
    if (process.platform === 'win32') this.spawn();
    if (this.latest) {
      try { ws.send(this.latest); } catch { /* 客户端刚断开 */ }
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    this.drop('停止');
    for (const ws of this.clients) {
      try { ws.close(1001, 'music off'); } catch { /* 已经关了 */ }
    }
    this.clients.clear();
    this.latest = '';
  }

  private spawn(): void {
    if (this.stopped || this.probe || !this.clients.size) return;
    if (Date.now() < this.retryAt) return;
    const script = join(this.webDir, 'music', 'probe.ps1');
    if (!existsSync(script)) {
      if (!this.warnedMissing) {
        this.warnedMissing = true;
        console.warn('[music] 找不到 ' + script + '（补丁资源没复制？）');
      }
      return;
    }
    if (!existsSync(join(this.webDir, 'music', 'NAudio.dll'))) {
      if (!this.warnedMissing) {
        this.warnedMissing = true;
        console.warn('[music] 找不到 NAudio.dll（补丁资源没复制？）');
      }
      return;
    }

    const args = [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', script, '-IntervalMs', '50', '-ParentPid', String(process.pid),
    ];
    let p: ChildProcess;
    try {
      p = spawn('powershell.exe', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      console.warn('[music] 起不来：' + (error as Error).message);
      this.retry();
      return;
    }
    this.probe = p;
    this.lastLineAt = Date.now();
    this.bornAt = this.lastLineAt;
    this.watch = setInterval(() => {
      if (this.probe === p && Date.now() - this.lastLineAt > 6000) {
        this.drop('采集超时'); this.retry();
      }
    }, 1000);

    let buf = '';
    p.stdout?.setEncoding('utf8');
    p.stdout?.on('data', (chunk: string) => {
      if (this.probe !== p) return;
      buf += chunk;
      let at = buf.indexOf('\n');
      while (at >= 0) {
        const line = buf.slice(0, at).trim();
        buf = buf.slice(at + 1);
        if (line) this.line(line);
        at = buf.indexOf('\n');
      }
      // 防御：坏行把缓冲撑爆
      if (buf.length > 65536) buf = buf.slice(-4096);
    });
    p.stderr?.setEncoding('utf8');
    p.stderr?.on('data', (text: string) => {
      const s = String(text).trim();
      if (s) console.warn('[music] probe: ' + s.slice(0, 300));
    });
    p.on('error', (error) => {
      if (this.probe !== p) return;
      console.warn('[music] 进程错误：' + error.message);
      this.drop('进程错误');
      this.retry();
    });
    p.on('exit', (code) => {
      if (this.probe !== p) return;
      this.drop('进程退出');
      if (this.stopped) return;
      console.warn('[music] 采集器退出 code=' + code);
      this.retry();
    });
    p.on('spawn', () => {
      this.retryAt = 0;
      console.warn('[music] 耳朵开始听：' + script);
    });
  }

  private retry(): void {
    if (this.stopped || !this.clients.size) return;
    this.failures++;
    const wait = Math.min(RETRY_MAX, RETRY_MIN * Math.max(1, this.failures));
    this.retryAt = Date.now() + wait;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.stopped) this.spawn();
    }, wait + 50);
  }

  private line(line: string): void {
    if (!line.startsWith('{')) return;
    let data;
    try { data = JSON.parse(line); } catch { return; }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return;
    if (data.error) { this.drop('采集器错误'); this.retry(); return; }
    if (data.ready || Number.isFinite(data.rms)) this.lastLineAt = Date.now();
    if (Number.isFinite(data.rms) && Date.now() - this.bornAt >= 8000) this.failures = 0;
    this.latest = JSON.stringify({ ...data, sampleAt: performance.now() / 1000 });
    for (const ws of this.clients) {
      try { ws.send(this.latest); } catch { this.clients.delete(ws); }
    }
  }

  private drop(why: string): void {
    if (this.watch) clearInterval(this.watch);
    this.watch = null;
    const p = this.probe;
    this.probe = null;
    if (!p) return;
    try { p.kill(); } catch { /* 已经退出 */ }
    console.warn('[music] 采集器停：' + why);
  }
}
