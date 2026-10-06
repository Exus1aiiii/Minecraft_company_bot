// tools/mcbot-inspect.mjs
// 开发自检工具：用 UTF-8 正确解码，避免 PowerShell 默认代码页把中文显示成乱码。
//
// 用法：
//   node tools/mcbot-inspect.mjs profile [botId]
//   node tools/mcbot-inspect.mjs events  [botId] [n]
//   node tools/mcbot-inspect.mjs all

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PROFILES_DIR = path.join(PROJECT_ROOT, 'runner', 'profiles');
const LOG_DIR = path.join(PROJECT_ROOT, 'runtime', 'logs');

const [, , cmd = 'all', arg1 = 'bot-xiaodou', arg2 = '25'] = process.argv;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function showProfile(botId) {
  const file = path.join(PROFILES_DIR, `${botId}.json`);
  const p = readJson(file);
  if (!p) return console.log(`profile: 读不到 ${file}`);
  console.log(`=== profile ${file} ===`);
  console.log('keys          :', Object.keys(p).join(', '));
  console.log('name          :', p.name);
  console.log('model         :', p.model);
  console.log('embedding     :', p.embedding);
  console.log('skin          :', p.skin ? JSON.stringify(p.skin) : '(无)');
  const c = String(p.conversing || '');
  console.log('conversing 长度:', c.length);
  console.log('--- 开头 380 字 ---');
  console.log(c.slice(0, 380));
  console.log('--- 结尾 300 字 ---');
  console.log(c.slice(-300));
  console.log('--- 引擎占位符是否保留 ---');
  for (const k of ['$COMMAND_DOCS', '$STATS', '$INVENTORY', '$EXAMPLES', '$SELF_PROMPT', '$MEMORY', '$ACTION']) {
    console.log('   ', k.padEnd(14), c.includes(k));
  }
}

function showEvents(botId, n) {
  const file = path.join(LOG_DIR, `${botId}.jsonl`);
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return console.log(`events: 读不到 ${file}`); }
  const lines = raw.split(/\r?\n/).filter(Boolean);
  console.log(`=== events ${file} （共 ${lines.length} 行，显示最后 ${n} 行）===`);
  for (const line of lines.slice(-Number(n))) {
    let ev;
    try { ev = JSON.parse(line); } catch { console.log('  [无法解析]', line.slice(0, 120)); continue; }
    const t = new Date(ev.ts).toLocaleTimeString('zh-CN', { hour12: false });
    const rest = { ...ev };
    delete rest.ts; delete rest.botId; delete rest.type;
    console.log(`  ${t} ${String(ev.type).padEnd(7)} ${JSON.stringify(rest)}`);
  }
}

function summarizeEvents(botId) {
  const file = path.join(LOG_DIR, `${botId}.jsonl`);
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return; }
  const counts = {};
  let gatePass = 0, gateBlock = 0, llmCalls = 0, tokens = 0;
  for (const line of raw.split(/\r?\n/).filter(Boolean)) {
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    counts[ev.type] = (counts[ev.type] || 0) + 1;
    if (ev.type === 'gate') { if (ev.decision === 'PASS') gatePass++; else gateBlock++; }
    if (ev.type === 'llm' && ev.phase === 'response' && !ev.failed) {
      llmCalls++;
      tokens += (ev.usage?.promptTokens || 0) + (ev.usage?.completionTokens || 0);
    }
  }
  console.log(`=== ${botId} 汇总 ===`);
  console.log('  事件类型 :', JSON.stringify(counts));
  console.log(`  门禁     : 放行 ${gatePass} / 拦下 ${gateBlock}`);
  console.log(`  大模型   : ${llmCalls} 次，累计 ${tokens} tokens`);
}

for (const botId of arg1 === 'all' || cmd === 'all' ? ['bot-xiaodou'] : [arg1]) {
  if (cmd === 'profile' || cmd === 'all') showProfile(botId);
  if (cmd === 'events' || cmd === 'all') { showEvents(botId, arg2); summarizeEvents(botId); }
  if (cmd === 'summary') summarizeEvents(botId);
}
