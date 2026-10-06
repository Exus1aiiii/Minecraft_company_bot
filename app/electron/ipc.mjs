// app/electron/ipc.mjs
// 主进程对渲染进程暴露的全部能力。每一个 handler 都遵守两条纪律：
//   ① 永不抛异常给渲染进程 —— 一律返回 { ok:false, error:'中文人话' }；
//   ② 永不吞掉原因 —— 失败要能直接显示给用户看，而不是只进控制台。

import { app, ipcMain, BrowserWindow, dialog, shell } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  PROJECT_ROOT, TMP_DIR, RUNTIME_DIR, findNodeRuntime, ensureDirs, memoryFileFor,
} from './paths.mjs';
import {
  loadConfigForUi, saveConfigRaw, configForRun, validateConfig, stripDerived,
  setSecret, clearSecret, getSecret, makeFirstRunBackup, newId, DEFAULT_RULES,
} from './store.mjs';
import { getEnv } from './env.mjs';
import { testLLM } from './llm.mjs';
import { hub } from './events.mjs';
import { supervisor } from './supervisor.mjs';
import { listPersonas } from '../../runner/personas/index.mjs';
import { Memory } from '../../runner/memory.mjs';

const SKIN_EXTS = ['png'];

// ── 事件广播 ────────────────────────────────────────────────────────────────

function broadcast(payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    // 整个循环体都在 try 里：窗口对象在关闭过程中可能处于各种半死状态，
    // 连 isDestroyed() 本身都可能抛（拿不到原生句柄时）。
    try {
      if (win.isDestroyed()) continue;
      win.webContents.send('mcbot:event', payload);
    } catch { /* 窗口正在关，丢掉这条 */ }
  }
}

const LEVEL_TAG = { info: '信息', warn: '警告', error: '错误' };

function timeOf(ts) {
  try { return new Date(ts || Date.now()).toLocaleTimeString('zh-CN', { hour12: false }); }
  catch { return '--:--:--'; }
}

const GATE_REASON_TEXT = {
  rejectedNoWakeName: '公屏没叫它名字',
  rejectedNotOwner: '不是主人',
  rejectedSelf: '它是自己说的话',
  rejectedRateLimited: '说话太频繁',
  rejectedBudget: '今日 token 预算用完了',
  rejectedEmpty: '空消息',
  ruleUnresolved: '规则命中但认不出要采什么/找什么，改问大模型',
  unknown: '未知原因',
};

/** 把子进程上报的结构化事件翻译成一行中文日志（渲染进程只认字符串） */
function fmtLine(ev) {
  const t = `[${timeOf(ev.ts)}]`;
  switch (ev.type) {
    case 'gate': {
      const who = ev.from ? `来自 ${ev.from}` : '';
      const what = ev.msg != null ? `「${ev.msg}」` : '';
      if (ev.decision === 'PASS' && ev.via === 'rule') {
        return `${t} [门禁] 放行·规则命中 ${who} ${what} → ${ev.cmd}`;
      }
      if (ev.decision === 'PASS') {
        return `${t} [门禁] 放行·交给大模型 ${who} ${what}`;
      }
      if (ev.decision === 'FALLBACK') {
        const why = GATE_REASON_TEXT[ev.reason] || ev.reason || '未知';
        return `${t} [门禁] 规则没认准（${why}）${who} ${what} → 退回大模型`;
      }
      const why = GATE_REASON_TEXT[ev.reason] || ev.reason || '未知';
      return `${t} [门禁] 拦下（${why}）${who} ${what} —— 零 token`;
    }
    case 'llm': {
      if (ev.phase === 'request') return `${t} [大模型] 请求 ${ev.model} …`;
      if (ev.failed) return `${t} [大模型] 请求失败（用时 ${ev.latencyMs}ms）`;
      const u = ev.usage;
      const usage = u ? ` · 输入 ${u.promptTokens} / 输出 ${u.completionTokens} tokens` : ' · 该厂商未返回用量';
      return `${t} [大模型] ${ev.model} 用时 ${ev.latencyMs}ms${usage}`;
    }
    case 'mc': {
      switch (ev.kind) {
        case 'login': return `${t} [游戏] 已登录 ${ev.name || ''}`;
        case 'spawn': return `${t} [游戏] 已进入世界 ${ev.position ? `@ ${ev.position.x}, ${ev.position.y}, ${ev.position.z}` : ''}`;
        case 'end': return `${t} [游戏] 与服务器断开${ev.reason ? `：${ev.reason}` : ''}`;
        case 'kicked': return `${t} [游戏] 被服务器踢出${ev.reason ? `：${ev.reason}` : ''}`;
        case 'death': return `${t} [游戏] 死亡${ev.position ? ` @ ${ev.position.x}, ${ev.position.y}, ${ev.position.z}` : ''}`;
        case 'stats': return `${t} [游戏] 血量 ${ev.health} · 饱食 ${ev.food} · ${ev.dimension || ''}${ev.position ? ` @ ${ev.position.x}, ${ev.position.y}, ${ev.position.z}` : ''}`;
        default: return `${t} [游戏] ${JSON.stringify(ev)}`;
      }
    }
    case 'status':
      return `${t} [状态] ${ev.detail || ev.status || ''}`;
    case 'error':
      return `${t} [错误] ${ev.message || ''}`;
    default:
      return `${t} [${LEVEL_TAG[ev.level] || '信息'}] ${ev.line || ''}`;
  }
}

const MC_KINDS_SKIP_LOG = new Set(['stats']);   // 每 10 秒一条太吵，只在面板上显示

function relayEvent(ev) {
  if (!ev || !ev.type) return;
  const type = ev.type;

  if (type === 'status') {
    broadcast({ type: 'status', botId: ev.botId, status: ev.status, pid: ev.pid ?? null });
  }
  if (type === 'gate') {
    broadcast({
      type: 'gate', botId: ev.botId, ts: ev.ts,
      decision: ev.decision, reason: ev.reason ?? null,
      from: ev.from ?? null, channel: ev.channel ?? (ev.via === 'rule' ? 'rule' : 'chat'),
      text: ev.msg ?? '',
    });
  }
  if (type === 'llm' && ev.phase === 'response') {
    broadcast({
      type: 'llm', botId: ev.botId, ts: ev.ts,
      model: ev.model, ms: ev.latencyMs,
      promptTokens: ev.usage?.promptTokens ?? 0,
      completionTokens: ev.usage?.completionTokens ?? 0,
      ok: !ev.failed,
    });
  }
  if (type === 'mc' && MC_KINDS_SKIP_LOG.has(ev.kind)) return;

  broadcast({ type: 'log', botId: ev.botId, ts: ev.ts, level: type === 'error' ? 'error' : 'info', line: fmtLine(ev) });
}

// ── 子进程工具调用（绝不使用管道）────────────────────────────────────────────
// 受限沙箱下 `stdio:'pipe'` 会 EPERM，所以统一走"子进程写文件、父进程读文件"。

function runTool(args, { outName, timeoutMs = 30000, nodeExe } = {}) {
  return new Promise((resolve) => {
    ensureDirs();
    const node = nodeExe || findNodeRuntime().exe;
    if (!node) return resolve({ ok: false, error: '找不到 Node 运行时' });

    const outFile = path.join(TMP_DIR, outName || `tool-${Date.now()}.json`);
    const logFile = outFile + '.log';
    try { fs.rmSync(outFile, { force: true }); } catch { /* 不存在就算了 */ }

    let fd;
    try { fd = fs.openSync(logFile, 'a'); }
    catch (e) { return resolve({ ok: false, error: `无法创建探测日志：${e.message}` }); }

    let child;
    try {
      child = spawn(node, args, {
        cwd: PROJECT_ROOT,
        stdio: ['ignore', fd, fd],
        windowsHide: true,
      });
    } catch (e) {
      try { fs.closeSync(fd); } catch { /* 已经关了 */ }
      return resolve({ ok: false, error: `无法启动探测进程：${e.message}` });
    }

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try { fs.closeSync(fd); } catch { /* 已经关了 */ }
      resolve(result);
    };

    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已经没了 */ }
      finish({ ok: false, error: `探测超时（${Math.round(timeoutMs / 1000)} 秒）` });
    }, timeoutMs);

    child.on('error', (e) => { clearTimeout(timer); finish({ ok: false, error: `探测进程错误：${e.message}` }); });
    child.on('exit', () => {
      clearTimeout(timer);
      let raw = '';
      try { raw = fs.readFileSync(outFile, 'utf8').trim(); } catch { /* 没写出来 */ }
      if (!raw) return finish({ ok: false, error: '探测进程没有返回结果（详见 runtime\\tmp 下的探测日志）' });
      const lastLine = raw.split(/\r?\n/).filter(Boolean).pop();
      try { finish(JSON.parse(lastLine)); }
      catch { finish({ ok: false, error: `探测结果无法解析：${lastLine.slice(0, 200)}` }); }
    });
  });
}

// ── 注册 ────────────────────────────────────────────────────────────────────

/**
 * 把探测失败的原始报错翻成人话。
 *
 * ★ 为什么要有这一条：`minecraft-protocol` 抛出来的东西长这样 ——
 *   `getaddrinfo ENOTFOUND my.server`、`connect ECONNREFUSED 1.2.3.4:25565`。
 *   界面上原样显示，用户看到的就是一行看不懂的英文。而这里每一种错误
 *   **对应一个完全不同的动作**（改地址 / 开服务器 / 关防火墙 / 换版本），
 *   分不清就只能来问我。
 *
 * ★ 认不出时**保留原文**，绝不硬编一个像模像样的原因 —— 编错了会把用户
 *   引到完全错误的方向上去。原文单独放在 `original` 里，界面另起一行显示。
 */
const PROBE_ERRORS = [
    [/ENOTFOUND|EAI_AGAIN|getaddrinfo/i, '域名解析不了 —— 服务器地址可能写错了（只填域名或 IP，端口填在右边那一栏）'],
    [/ECONNREFUSED/i, '对方拒绝了连接 —— 地址是对的，但那个端口上没有服务在听（服务器没启动？端口写错了？）'],
    [/ETIMEDOUT|ETIMEOUT|timed?\s*out/i, '连接超时 —— 地址或端口可能不对，也可能是被防火墙挡住了'],
    [/ECONNRESET/i, '连接被重置 —— 中途被防火墙或代理切断了'],
    [/EHOSTUNREACH|ENETUNREACH/i, '网络不通 —— 检查本机网络连接'],
    [/unsupported protocol version|Invalid version|version.*not supported/i, '服务端版本和探测用的版本对不上 —— 把这条服务器的「版本」改成 auto 再试'],
    [/Server is full/i, '服务器满了（在线人数已达上限）'],
    [/This server is offline|Server is offline/i, '服务器显示为离线'],
];

function translateProbeError(res) {
    const raw = String(res?.error || '');
    const hit = PROBE_ERRORS.find(([re]) => re.test(raw));
    if (!hit) return { ...res, original: raw };
    return { ...res, error: hit[1], original: raw };
}

export function registerIpc() {
  ensureDirs();

  // 事件总线 -> 渲染进程
  //
  // ★ 这里必须自己兜住异常：EventEmitter 的 emit 是**按注册顺序同步调用**的，
  //   任何一个监听器抛错都会中断后面所有监听器。relayEvent 是往渲染进程发消息，
  //   它出了问题绝不该连累 Supervisor 那边的状态折叠（那个监听器注册得更晚）。
  hub.on('event', (ev) => {
    try { relayEvent(ev); }
    catch (e) { console.error('[mcbot-ipc] 转发事件失败：', e?.message || e); }
  });
  hub.on('notice', (n) => {
    try {
      broadcast({
        type: 'log', botId: n.botId ?? null, ts: n.ts || Date.now(),
        level: n.level || 'info',
        line: `[${timeOf(n.ts)}] [${LEVEL_TAG[n.level] || '信息'}] ${n.text}`,
      });
    } catch (e) { console.error('[mcbot-ipc] 转发通知失败：', e?.message || e); }
  });
  supervisor.on('runtime', () => broadcast({ type: 'runtime', bots: supervisor.list() }));
  hub.start();
  supervisor.wire();
  supervisor.sync();

  // ── 环境 ──
  ipcMain.handle('env:get', () => {
    try { return { ok: true, ...getEnv() }; }
    catch (e) { return { ok: false, error: `环境自检失败：${e.message}`, problems: [e.message] }; }
  });

  ipcMain.handle('app:versions', () => ({
    ok: true,
    app: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    v8: process.versions.v8,
  }));

  // ── 配置 ──
  ipcMain.handle('config:get', () => {
    try {
      makeFirstRunBackup();
      const cfg = loadConfigForUi();
      return { ok: true, ...cfg };
    } catch (e) {
      return { ok: false, error: `读取配置失败：${e.message}` };
    }
  });

  ipcMain.handle('config:save', (_e, cfg) => {
    try {
      const clean = stripDerived(cfg);
      const errors = validateConfig(clean);
      if (errors.length) return { ok: false, errors };
      saveConfigRaw(clean);
      supervisor.sync();
      broadcast({ type: 'runtime', bots: supervisor.list() });
      return { ok: true, errors: [], ...loadConfigForUi() };
    } catch (e) {
      return { ok: false, errors: [`保存失败：${e.message}`] };
    }
  });

  // ── 密钥 ──
  ipcMain.handle('secret:set', (_e, profileId, key) => {
    try {
      if (!key || !String(key).trim()) return { ok: false, error: '密钥不能为空' };
      setSecret(profileId, String(key).trim());
      return { ok: true, ...loadConfigForUi() };
    } catch (e) { return { ok: false, error: `保存密钥失败：${e.message}` }; }
  });

  ipcMain.handle('secret:clear', (_e, profileId) => {
    try { clearSecret(profileId); return { ok: true, ...loadConfigForUi() }; }
    catch (e) { return { ok: false, error: `清除密钥失败：${e.message}` }; }
  });

  ipcMain.handle('llm:test', async (_e, profileId, keyOverride) => {
    try {
      const cfg = configForRun();
      const profile = cfg.llm.profiles.find(p => p.id === profileId);
      if (!profile) return { ok: false, error: `找不到模型配置：${profileId}` };
      const res = await testLLM(profile, keyOverride || getSecret(profileId));
      return res;
    } catch (e) { return { ok: false, error: `测试失败：${e.message}` }; }
  });

  // ── 服务器探测 ──
  ipcMain.handle('server:probe', async (_e, server) => {
    const host = String(server?.host || '').trim();
    const port = Number(server?.port);
    const version = String(server?.version || '').trim();
    if (!host) return { ok: false, error: '服务器地址不能为空' };
    if (!Number.isFinite(port) || port <= 0 || port > 65535) return { ok: false, error: '端口必须是 1-65535' };

    // ★ 这个名字只能算一次。以前是 `--out ...probe-${Date.now()}.json` 和
    //   `outName: ...probe-${Date.now()}.json` **各算一次** —— 两次之间跨过一个毫秒时，
    //   子进程把结果写到 A 文件、父进程去读 B 文件，读不到就报
    //   「探测进程没有返回结果（详见 runtime\tmp 下的探测日志）」。
    //   这不是"探测失败"，是**假红**：任何服务器（包括用户自己的线上服）都会偶发，
    //   而且现场只剩一个 0 字节的 `probe-<另一个时间戳>.json.log`，
    //   看着像子进程崩了。2026-10 就是靠这个孤儿 .log 抓到的。
    const outName = `probe-${Date.now()}.json`;
    const args = [path.join(PROJECT_ROOT, 'tools', 'ping-server.mjs'), host, String(port)];
    if (version && version !== 'auto') args.push(version);
    args.push('--out', path.join(TMP_DIR, outName));

    const res = await runTool(args, { outName, timeoutMs: 20000 });
    if (!res.ok) return translateProbeError(res);
    return { ok: true, ...res };
  });

  // ── bot 生命周期 ──
  ipcMain.handle('bots:list', () => {
    try { return { ok: true, bots: supervisor.sync() }; }
    catch (e) { return { ok: false, error: e.message, bots: [] }; }
  });

  ipcMain.handle('bot:start', async (_e, botId) => {
    try { const r = await supervisor.start(botId); return { ...r, bots: supervisor.list() }; }
    catch (e) { return { ok: false, error: `启动失败：${e.message}` }; }
  });

  ipcMain.handle('bot:stop', async (_e, botId) => {
    try { const r = await supervisor.stop(botId); return { ...r, bots: supervisor.list() }; }
    catch (e) { return { ok: false, error: `停止失败：${e.message}` }; }
  });

  ipcMain.handle('bot:restart', async (_e, botId) => {
    try { const r = await supervisor.restart(botId); return { ...r, bots: supervisor.list() }; }
    catch (e) { return { ok: false, error: `重启失败：${e.message}` }; }
  });

  ipcMain.handle('bot:stopAll', async () => {
    try { const r = await supervisor.stopAll(); return { ...r, bots: supervisor.list() }; }
    catch (e) { return { ok: false, error: `停止全部失败：${e.message}` }; }
  });

  // ── 观测 ──
  ipcMain.handle('log:read', (_e, botId, opts = {}) => {
    try {
      const n = Number(opts?.lines) > 0 ? Number(opts.lines) : 400;
      const events = hub.recent(botId, n);
      const lines = events
        .filter(ev => !(ev.type === 'mc' && MC_KINDS_SKIP_LOG.has(ev.kind)))
        .map(fmtLine);
      return lines;
    } catch {
      return [];
    }
  });

  ipcMain.handle('stats:clear', (_e, botId) => {
    try { return supervisor.clearStats(botId); }
    catch (e) { return { ok: false, error: e.message }; }
  });

  // ── 皮肤 ──
  ipcMain.handle('skin:pick', async () => {
    try {
      const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
      const res = await dialog.showOpenDialog(win, {
        title: '选择 Minecraft 皮肤（64×64 PNG）',
        filters: [{ name: '皮肤图片', extensions: SKIN_EXTS }],
        properties: ['openFile'],
      });
      if (res.canceled || !res.filePaths?.length) return { ok: false, canceled: true };
      const p = res.filePaths[0];
      return { ok: true, path: p, dataUrl: toDataUrl(p) };
    } catch (e) { return { ok: false, error: `选择皮肤文件失败：${e.message}` }; }
  });

  ipcMain.handle('skin:read', (_e, filePath) => {
    try {
      if (!filePath) return { ok: false, error: '路径为空' };
      if (!/\.png$/i.test(filePath)) return { ok: false, error: '只支持 PNG 皮肤文件' };
      if (!fs.existsSync(filePath)) return { ok: false, error: '文件不存在，可能已被移动或删除' };
      return { ok: true, dataUrl: toDataUrl(filePath) };
    } catch (e) { return { ok: false, error: `读取皮肤失败：${e.message}` }; }
  });

  // ── 人格 ──
  ipcMain.handle('personas:list', () => {
    try { return { ok: true, personas: listPersonas() }; }
    catch (e) { return { ok: false, error: `读取人格预设失败：${e.message}`, personas: [] }; }
  });

  // ── 长期记忆 ──
  // bot 记住的事（主人是谁、家在哪、答应过什么、一起干过什么）。面板上要看得到
  // 也删得掉 —— 记忆里如果有过时或错误的一条（"家"搬了），用户得能自己清。
  ipcMain.handle('memory:get', (_e, botId) => {
    try {
      const id = String(botId || '');
      if (!id) return { ok: false, error: '缺少 botId', entries: [] };
      const mem = new Memory(memoryFileFor(id));
      const entries = mem.all().map(e => ({
        id: e.id, ts: e.ts, kind: e.kind, text: e.text, from: e.from || null,
      }));
      return { ok: true, botId: id, entries, file: mem.file };
    } catch (e) { return { ok: false, error: `读取记忆失败：${e.message}`, entries: [] }; }
  });

  ipcMain.handle('memory:add', (_e, botId, text) => {
    try {
      const id = String(botId || '');
      const body = String(text || '').trim();
      if (!id) return { ok: false, error: '缺少 botId' };
      if (body.length < 2) return { ok: false, error: '内容太短了，至少写两个字' };
      const mem = new Memory(memoryFileFor(id));
      const r = mem.remember({ text: body, kind: 'fact', from: '主人' });
      return { ok: true, dup: !!r.dup, count: mem.size };
    } catch (e) { return { ok: false, error: `写入记忆失败：${e.message}` }; }
  });

  ipcMain.handle('memory:forget', (_e, botId, what) => {
    try {
      const id = String(botId || '');
      if (!id) return { ok: false, error: '缺少 botId' };
      const mem = new Memory(memoryFileFor(id));
      const removed = mem.forget(String(what || ''));
      return { ok: true, removed, count: mem.size };
    } catch (e) { return { ok: false, error: `删除记忆失败：${e.message}` }; }
  });

  ipcMain.handle('memory:clear', (_e, botId) => {
    try {
      const id = String(botId || '');
      if (!id) return { ok: false, error: '缺少 botId' };
      const mem = new Memory(memoryFileFor(id));
      const removed = mem.forget('all');
      return { ok: true, removed };
    } catch (e) { return { ok: false, error: `清空记忆失败：${e.message}` }; }
  });

  // ── 杂项 ──
  ipcMain.handle('app:openExternal', async (_e, url) => {
    try {
      if (!/^https?:\/\//i.test(String(url || ''))) return { ok: false, error: '只允许打开 http/https 链接' };
      await shell.openExternal(url);
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('app:pickDirectory', async () => {
    try {
      const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
      const res = await dialog.showOpenDialog(win, { title: '选择目录', properties: ['openDirectory', 'createDirectory'] });
      if (res.canceled || !res.filePaths?.length) return { ok: false, canceled: true };
      return { ok: true, path: res.filePaths[0] };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  // 只在启动时用一次，之后由 events.mjs 的轮询推送
  ipcMain.handle('app:defaults', () => ({ ok: true, rules: DEFAULT_RULES, sampleId: newId('bot') }));
}

function toDataUrl(filePath) {
  const buf = fs.readFileSync(filePath);
  return `data:image/png;base64,${buf.toString('base64')}`;
}
