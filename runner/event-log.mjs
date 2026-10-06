// runner/event-log.mjs
// 子进程（引擎 / agent / 聊天门）→ 主进程的结构化事件通道。
//
// 为什么用文件而不是管道：本机沙箱下 spawn 的 piped stdio 会 EPERM，而文件追加在沙箱内外都工作，
// 而且引擎崩溃后日志仍然留在磁盘上，便于事后排查。
// 主进程侧由 app/electron/events.mjs 轮询 tail 这个文件。

import fs from 'node:fs';
import path from 'node:path';

const TYPE_OK = new Set(['log', 'gate', 'llm', 'mc', 'status', 'error']);

/**
 * @param {{botId: string, file: string, echo?: boolean}} opts
 * @returns {{ emit(type: string, payload?: object): void, file: string }}
 */
export function createEventLog({ botId, file, echo = true }) {
  let broken = false;

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch { /* 已存在 */ }

  const emit = (type, payload = {}) => {
    const ev = { ts: Date.now(), botId, type, ...payload };
    // 控制台回声：直接跑 engine-launcher 时（没有主进程 tail）也能看见
    if (echo) {
      const tag = type === 'gate' ? (payload.decision === 'PASS' ? 'PASS ' : 'BLOCK') : type.toUpperCase();
      const detail = payload.line ?? payload.reason ?? payload.text ?? '';
      console.log(`[MCBOT-EV] ${tag} ${detail}`.trimEnd());
    }
    if (broken) return;
    try {
      fs.appendFileSync(file, JSON.stringify(ev) + '\n', 'utf8');
    } catch (e) {
      // 写不进去不能拖垮 bot，只报告一次
      broken = true;
      console.error(`[MCBOT-EV] 事件日志写入失败（后续事件只走控制台）: ${e.message}`);
    }
  };

  return { emit, file };
}

/** 把引擎标准输出的一行朴素文本也变成事件（供主进程展示原始日志） */
export function lineToEvent(botId, line, level = 'info') {
  return { ts: Date.now(), botId, type: 'log', level, line };
}
