// app/electron/events.mjs
// 事件总线的**主进程侧**：轮询 tail 每个 bot 的 jsonl 文件，归一化后推给界面。
//
// 设计取舍：只用轮询（500ms），不用 fs.watch —— Windows 上 fs.watch 对"同目录内新建文件"
// 与"追加写"的语义不稳，轮询一个小文件的开销可以忽略，但可靠性差别很大。

import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { LOG_DIR, logFileFor } from './paths.mjs';

const POLL_MS = 500;

export class EventHub extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, {offset:number, buf:string, partial:string}>} */
    this.tails = new Map();
    this.timer = null;
    this.ring = [];          // 最近 2000 条，供界面首次加载时回填
    this.ringMax = 2000;
  }

  start() {
    if (this.timer) return;
    try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch { /* ignore */ }
    this.timer = setInterval(() => this.poll(), POLL_MS);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** 清空某个 bot 的事件文件（用于"清屏"），不影响轮询状态 */
  truncate(botId) {
    const file = logFileFor(botId);
    try { fs.writeFileSync(file, '', 'utf8'); } catch { /* 文件可能不存在 */ }
    const st = this.tails.get(botId);
    if (st) { st.offset = 0; st.partial = ''; }
    this.ring = this.ring.filter(e => e.botId !== botId);
  }

  /** 首次加载时回填的环形缓冲 */
  recent(botId, limit = 500) {
    const list = botId ? this.ring.filter(e => e.botId === botId) : this.ring;
    return list.slice(-limit);
  }

  poll() {
    let files;
    try {
      files = fs.readdirSync(LOG_DIR).filter(f => f.endsWith('.jsonl'));
    } catch { return; }

    for (const f of files) {
      const botId = f.slice(0, -'.jsonl'.length);
      this.readFile(botId, path.join(LOG_DIR, f));
    }
  }

  readFile(botId, file) {
    let st = this.tails.get(botId);
    if (!st) { st = { offset: 0, partial: '' }; this.tails.set(botId, st); }

    let fd;
    try {
      const stat = fs.statSync(file);
      if (stat.size < st.offset) { st.offset = 0; st.partial = ''; }   // 文件被截断/重建
      if (stat.size === st.offset) return;

      fd = fs.openSync(file, 'r');
      const len = stat.size - st.offset;
      const buf = Buffer.allocUnsafe(len);
      fs.readSync(fd, buf, 0, len, st.offset);
      st.offset = stat.size;

      const text = st.partial + buf.toString('utf8');
      const lines = text.split('\n');
      st.partial = lines.pop() ?? '';                                   // 最后一段可能不完整
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        this.dispatch(botId, t);
      }
    } catch { /* 文件刚好被删/被占用，下一轮再说 */ }
    finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } } }
  }

  dispatch(botId, rawLine) {
    let ev;
    try {
      ev = JSON.parse(rawLine);
      if (typeof ev !== 'object' || ev === null) throw new Error('not an object');
    } catch {
      ev = { ts: Date.now(), botId, type: 'log', level: 'info', line: rawLine };
    }
    if (!ev.botId) ev.botId = botId;

    this.ring.push(ev);
    if (this.ring.length > this.ringMax) this.ring.splice(0, this.ring.length - this.ringMax);

    this.emit('event', ev);
    this.emit(ev.type, ev);
  }

  /** 主进程自己产生的通知（环境问题、启动失败等），不需要经过文件 */
  notice(level, text, botId = null) {
    const ev = { ts: Date.now(), botId, type: 'notice', level, text };
    this.ring.push(ev);
    if (this.ring.length > this.ringMax) this.ring.splice(0, this.ring.length - this.ringMax);
    this.emit('event', ev);
    this.emit('notice', ev);
  }
}

export const hub = new EventHub();
