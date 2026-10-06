// app/electron/supervisor.mjs
// 每个 bot 一个引擎进程的生命周期管理：启动、停止、崩溃退避重连、状态与用量聚合。
//
// ★ 硬约束（踩过的坑）：spawn 的 stdio **不能用 'pipe'** —— 本机沙箱禁止打开命名管道，
//   管道会让子进程 EPERM。这里改用"把文件描述符直接交给子进程"，既不经过管道，
//   又能把引擎的原始控制台输出完整留存下来（供"原始日志"面板查看）。

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { LOG_DIR, RUNNER_DIR, LAUNCHER_FILE, logFileFor, findNodeRuntime, ensureDirs } from './paths.mjs';
import { configForRun, validateConfig, getSecret } from './store.mjs';
import { getEnv } from './env.mjs';
import { hub } from './events.mjs';
import { buildLaunchSpec } from './launcher.mjs';

const BACKOFF_BASE_MS = 3000;
const BACKOFF_MAX_MS = 60000;
const MAX_RESTARTS = 5;              // 窗口内连续失败这么多次就放弃，避免无限重启把服务器刷屏
const RESTART_WINDOW_MS = 10 * 60 * 1000;

function emptyRuntime(bot) {
  return {
    id: bot.id,
    name: bot.name,
    displayName: bot.displayName || bot.name,
    status: 'stopped',
    pid: null,
    restarts: 0,
    startedAt: null,
    uptimeMs: 0,
    mc: { connected: false, health: null, food: null, position: null, dimension: null, gamemode: null },
    llm: { calls: 0, promptTokens: 0, completionTokens: 0, lastLatencyMs: null, todayTokens: 0, budget: bot.dailyTokenBudget || 0 },
    gate: { passed: 0, blocked: 0, fallback: 0, byReason: {}, lastDecision: null },
    lastError: null,
  };
}

/**
 * 从引擎日志的尾巴上找一句"为什么退出"。
 *
 * 动机：引擎被杀掉时只会以 `code=1` 退场，而真正的原因（同名玩家已在线、
 * 连不上服务器、名字不合法……）只写在日志里。面板上显示"引擎进程退出（code=1）"
 * 对用户等于没说 —— 这条函数把那句人话捞出来。
 *
 * @param {string} file 引擎的原始输出日志路径
 * @returns {string} 一句中文（找不到就返回空串，调用方退回原始退出码话术）
 */
function readExitReason(file) {
  let text = '';
  try {
    const st = fs.statSync(file);
    const from = Math.max(0, st.size - 16 * 1024);           // 只看最后 16KB，日志可能很大
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(st.size - from);
      fs.readSync(fd, buf, 0, buf.length, from);
      text = buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return ''; }

  const lines = text.split(/\r?\n/).filter(Boolean);
  // 从后往前找，取最后一条像样的原因
  for (let i = lines.length - 1; i >= 0 && i > lines.length - 60; i--) {
    const l = lines[i];
    if (/duplicate_login|You are already logged in/i.test(l)) return '这个名字已经有人在服务器上了';
    if (/ECONNREFUSED|connect ECONNREFUSED/i.test(l)) return '连不上服务器（端口不通？）';
    if (/ENOTFOUND|getaddrinfo/i.test(l)) return '服务器地址解析不了（地址写错了吗？）';
    if (/kicked|Kicked/i.test(l)) return `被服务器踢出：${l.replace(/^.*?kicked[^:]*:\s*/i, '').slice(0, 60)}`;
    if (/Invalid username|validateNameFormat/i.test(l)) return '名字不合法（只能用字母数字下划线，3–16 位）';
    if (/unsupported protocol version/i.test(l)) return '服务端版本和引擎对不上';
    if (/\[LoginGuard\]/i.test(l)) return l.replace(/^.*\[LoginGuard\]\s*/, '').slice(0, 80);
    if (/Error:|Error\b/.test(l) && !/PartialReadError/.test(l)) {
      return l.replace(/^.*?Error:\s*/, '').slice(0, 80);
    }
  }
  return '';
}

export class Supervisor extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, any>} */ this.runtimes = new Map();
    /** @type {Map<string, import('node:child_process').ChildProcess>} */ this.children = new Map();
    /** @type {Map<string, {intentional:boolean, attempts:number[], timer:NodeJS.Timeout|null}>} */
    this.ctl = new Map();
    this._wired = false;
  }

  /** 订阅事件总线，把子进程上报的事件折进运行时状态 */
  wire() {
    if (this._wired) return;
    this._wired = true;
    hub.on('event', (ev) => this.absorb(ev));
  }

  absorb(ev) {
    if (!ev?.botId) return;
    const rt = this.runtimes.get(ev.botId);
    if (!rt) return;

    switch (ev.type) {
      case 'status':
        // 引擎启动器（父进程）与聊天门（agent 子进程）各写各的事件，落进同一个
        // jsonl 后时间戳可能同秒、顺序可能颠倒 —— 实测出现过 "running" 之后紧跟
        // 一条迟到的 "starting"，把界面又打回启动中。已经在线的 bot 不接受回退。
        if (ev.status === 'starting' && (rt.status === 'running' || rt.status === 'reconnecting')) break;
        if (ev.status) rt.status = ev.status;
        if (ev.detail) rt.lastError = ev.status === 'error' ? ev.detail : rt.lastError;
        break;

      case 'mc': {
        const k = ev.kind;
        if (k === 'login' || k === 'spawn') { rt.mc.connected = true; rt.status = 'running'; }
        else if (k === 'end' || k === 'kicked') { rt.mc.connected = false; }
        else if (k === 'stats') {
          // 心跳能到，就说明确实连着 —— 不能只依赖 login/spawn 那两条一次性的
          // 事件（它们可能在门装好之前就已经发过了，见 mcbot-gate.mjs 的补发逻辑）。
          rt.mc.connected = true;
          rt.mc.health = ev.health ?? rt.mc.health;
          rt.mc.food = ev.food ?? rt.mc.food;
          rt.mc.position = ev.position ?? rt.mc.position;
          rt.mc.dimension = ev.dimension ?? rt.mc.dimension;
          rt.mc.gamemode = ev.gamemode ?? rt.mc.gamemode;
        }
        break;
      }

      case 'llm': {
        if (ev.phase === 'response') {
          rt.llm.calls += 1;
          if (Number.isFinite(ev.latencyMs)) rt.llm.lastLatencyMs = ev.latencyMs;
          if (ev.usage) {
            rt.llm.promptTokens += ev.usage.promptTokens || 0;
            rt.llm.completionTokens += ev.usage.completionTokens || 0;
            rt.llm.todayTokens += ev.usage.totalTokens || 0;
          }
        }
        break;
      }

      case 'gate': {
        // 三种判定：拦下（零 token）/ 规则直接放行（零 token）/ 交给大模型。
        // FALLBACK 是"规则命中但参数认不出，退回大模型"——它最终还是会走大模型，
        // 所以既不能算拦下、也不能算规则命中，单独计一档。
        if (ev.decision === 'PASS') rt.gate.passed += 1;
        else if (ev.decision === 'FALLBACK') {
          rt.gate.fallback = (rt.gate.fallback || 0) + 1;
          const r = ev.reason || 'ruleUnresolved';
          rt.gate.byReason[r] = (rt.gate.byReason[r] || 0) + 1;
        } else {
          rt.gate.blocked += 1;
          const r = ev.reason || 'unknown';
          rt.gate.byReason[r] = (rt.gate.byReason[r] || 0) + 1;
        }
        rt.gate.lastDecision = { decision: ev.decision, reason: ev.reason ?? null, from: ev.from ?? null, msg: ev.msg ?? null, ts: ev.ts };
        break;
      }

      case 'error':
        rt.lastError = ev.message || '未知错误';
        break;
    }

    if (rt.startedAt) rt.uptimeMs = Date.now() - rt.startedAt;
    this.emit('runtime', this.snapshot(rt.id));
  }

  snapshot(botId) {
    const rt = this.runtimes.get(botId);
    if (!rt) return null;
    if (rt.startedAt) rt.uptimeMs = Date.now() - rt.startedAt;
    return JSON.parse(JSON.stringify(rt));
  }

  list() {
    return [...this.runtimes.keys()].map(id => this.snapshot(id)).filter(Boolean);
  }

  /** 与配置对齐：新增的 bot 建运行时条目，删掉的清理掉 */
  sync() {
    const cfg = configForRun();
    const ids = new Set(cfg.bots.map(b => b.id));
    for (const b of cfg.bots) {
      const existing = this.runtimes.get(b.id);
      if (existing) {
        existing.name = b.name;
        existing.displayName = b.displayName || b.name;
        existing.llm.budget = b.dailyTokenBudget || 0;
      } else {
        this.runtimes.set(b.id, emptyRuntime(b));
      }
    }
    for (const id of [...this.runtimes.keys()]) {
      if (!ids.has(id) && !this.children.has(id)) { this.runtimes.delete(id); this.ctl.delete(id); }
    }
    return this.list();
  }

  rawLogFileFor(botId) {
    return path.join(LOG_DIR, `${String(botId).replace(/[^a-zA-Z0-9._-]/g, '_')}.out.log`);
  }

  async start(botId, { auto = false } = {}) {
    this.sync();

    const cfg = configForRun();
    const bot = cfg.bots.find(b => b.id === botId);
    if (!bot) return { ok: false, error: `找不到机器人 ${botId}` };

    if (this.children.has(botId)) {
      const cur = this.runtimes.get(botId);
      if (cur && (cur.status === 'running' || cur.status === 'starting')) {
        return { ok: false, error: '这个机器人已经在运行了' };
      }
    }

    const errors = validateConfig(cfg);
    if (errors.length) return { ok: false, errors };

    // 环境自检 —— 缺运行时/引擎时**不要**盲目 spawn，否则用户只会看到一堆看不懂的报错
    const env = getEnv();
    if (!env.nodePath) return { ok: false, errors: ['找不到 Node 运行时（runtime\\node-v22*-win-x64）。'] };
    if (!env.engineOk) return { ok: false, errors: [`引擎不完整：${env.engineDir} 下缺少 main.js 或 node_modules。`] };
    if (!env.launcherOk) return { ok: false, errors: ['缺少 runner\\engine-launcher.mjs'] };
    if (!env.gateOk) return { ok: false, errors: ['缺少 runner\\mcbot-gate.mjs'] };

    const server = cfg.servers.find(s => s.id === bot.serverId);
    const profile = cfg.llm.profiles.find(p => p.id === bot.llmProfileId);
    if (!server) return { ok: false, error: `机器人「${bot.displayName}」绑定的服务器不存在` };
    if (!profile) return { ok: false, error: `机器人「${bot.displayName}」绑定的模型不存在` };
    if (!getSecret(profile.id)) {
      return { ok: false, error: `模型「${profile.label}」还没有填 API Key —— 请到「大模型」页填入。` };
    }

    const rt = this.runtimes.get(botId) || emptyRuntime(bot);
    this.runtimes.set(botId, rt);
    rt.status = 'starting';
    rt.lastError = null;
    rt.startedAt = Date.now();
    rt.uptimeMs = 0;
    this.emit('runtime', this.snapshot(botId));

    let spec;
    try {
      spec = buildLaunchSpec(bot, server, profile);
    } catch (e) {
      rt.status = 'error';
      rt.lastError = `生成启动配置失败：${e.message}`;
      this.emit('runtime', this.snapshot(botId));
      return { ok: false, error: rt.lastError };
    }

    ensureDirs();
    const stdioFd = fs.openSync(this.rawLogFileFor(botId), 'a');
    const envVars = { ...process.env, ...spec.env };
    // NODE_OPTIONS 是进程级变量：必须**合并**而不是覆盖（用户/引擎可能已经设了别的）
    const gateUrl = new URL(`file:///${path.join(RUNNER_DIR, 'mcbot-gate.mjs').replace(/\\/g, '/')}`).href;
    envVars.NODE_OPTIONS = [process.env.NODE_OPTIONS, `--import ${gateUrl}`].filter(Boolean).join(' ');

    let child;
    try {
      child = spawn(spec.nodeExe, [LAUNCHER_FILE, '--bot-json', spec.file], {
        cwd: env.engineDir,
        env: envVars,
        stdio: ['ignore', stdioFd, stdioFd],   // ← 关键：文件 fd，不是管道
        windowsHide: true,
      });
    } catch (e) {
      fs.closeSync(stdioFd);
      rt.status = 'error';
      rt.lastError = `启动进程失败：${e.message}`;
      this.emit('runtime', this.snapshot(botId));
      return { ok: false, error: rt.lastError };
    } finally {
      // 子进程已经拿到句柄，父进程这份要关掉，否则文件一直被占住
      setTimeout(() => { try { fs.closeSync(stdioFd); } catch { /* 已经关了 */ } }, 1000);
    }

    this.children.set(botId, child);
    rt.pid = child.pid;

    const ctl = this.ctl.get(botId) || { intentional: false, attempts: [], timer: null };
    ctl.intentional = false;
    this.ctl.set(botId, ctl);

    hub.notice('info', `机器人「${rt.displayName}」正在启动（pid ${child.pid}）`, botId);
    this.emit('runtime', this.snapshot(botId));

    child.on('error', (e) => {
      rt.status = 'error';
      rt.lastError = `进程错误：${e.message}`;
      this.emit('runtime', this.snapshot(botId));
      hub.notice('error', `机器人「${rt.displayName}」进程错误：${e.message}`, botId);
    });

    child.on('exit', (code, signal) => {
      this.children.delete(botId);
      rt.pid = null;
      rt.mc.connected = false;
      const wasIntentional = this.ctl.get(botId)?.intentional;

      if (wasIntentional) {
        rt.status = 'stopped';
        rt.startedAt = null;
        rt.uptimeMs = 0;
        hub.notice('info', `机器人「${rt.displayName}」已停止`, botId);
        this.emit('runtime', this.snapshot(botId));
        return;
      }

      rt.status = 'error';
      // 光说"退出码 1"对用户毫无用处 —— 从引擎日志尾巴上找一句人话。
      const why = readExitReason(this.rawLogFileFor(botId));
      rt.lastError = why
        ? `引擎退出（${why}）`
        : `引擎进程退出（code=${code}${signal ? `, signal=${signal}` : ''}）`;
      hub.notice('error', `机器人「${rt.displayName}」意外退出：${rt.lastError}`, botId);

      // 退避重连
      const c = this.ctl.get(botId) || { intentional: false, attempts: [], timer: null };
      const now = Date.now();
      c.attempts = c.attempts.filter(t => now - t < RESTART_WINDOW_MS);
      if (c.attempts.length >= MAX_RESTARTS) {
        rt.status = 'error';
        rt.lastError += `；${MAX_RESTARTS} 次重连都失败，已停止自动重试。请查看日志排查。`;
        hub.notice('error', `机器人「${rt.displayName}」重连次数过多，停止自动重试`, botId);
        this.emit('runtime', this.snapshot(botId));
        return;
      }
      c.attempts.push(now);
      const delay = Math.min(BACKOFF_BASE_MS * 2 ** (c.attempts.length - 1), BACKOFF_MAX_MS);
      rt.status = 'reconnecting';
      rt.restarts += 1;
      hub.notice('warn', `机器人「${rt.displayName}」将在 ${Math.round(delay / 1000)} 秒后自动重连（第 ${c.attempts.length} 次）`, botId);
      this.emit('runtime', this.snapshot(botId));

      c.timer = setTimeout(() => {
        c.timer = null;
        if (this.ctl.get(botId)?.intentional) return;
        this.start(botId, { auto: true }).catch(() => { /* 已在 start 内部报告 */ });
      }, delay);
      c.timer.unref?.();
      this.ctl.set(botId, c);
    });

    return { ok: true, pid: child.pid };
  }

  async stop(botId) {
    const child = this.children.get(botId);
    const rt = this.runtimes.get(botId);
    const ctl = this.ctl.get(botId);
    if (ctl?.timer) { clearTimeout(ctl.timer); ctl.timer = null; }
    if (ctl) ctl.intentional = true;

    if (!child || !rt) {
      if (rt) { rt.status = 'stopped'; rt.pid = null; rt.mc.connected = false; this.emit('runtime', this.snapshot(botId)); }
      return { ok: true, alreadyStopped: true };
    }

    rt.status = 'stopping';
    this.emit('runtime', this.snapshot(botId));
    hub.notice('info', `正在停止机器人「${rt.displayName}」…`, botId);

    const pid = child.pid;
    // ★ 只按 **PID 树** 杀，绝不按进程镜像名杀 —— 用户自己的 Minecraft 客户端就叫 java.exe，
    //   按名杀会静默地把玩家的游戏一起杀掉（Bakabot 明确警告过这一点）。
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      child.once('exit', finish);
      try {
        const tk = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        tk.on('exit', () => setTimeout(finish, 500));
        tk.on('error', () => { try { child.kill('SIGKILL'); } catch { /* 已经没了 */ } setTimeout(finish, 500); });
      } catch {
        try { child.kill('SIGKILL'); } catch { /* 已经没了 */ }
        finish();
      }
      setTimeout(finish, 8000);   // 兜底：8 秒还没退就先把界面放开
    });

    this.children.delete(botId);
    rt.status = 'stopped';
    rt.pid = null;
    rt.startedAt = null;
    rt.uptimeMs = 0;
    rt.mc.connected = false;
    this.emit('runtime', this.snapshot(botId));
    return { ok: true };
  }

  async restart(botId) {
    await this.stop(botId);
    const c = this.ctl.get(botId);
    if (c) { c.attempts = []; c.intentional = false; }
    await new Promise(r => setTimeout(r, 400));
    return this.start(botId);
  }

  async stopAll() {
    const ids = [...this.children.keys()];
    await Promise.all(ids.map(id => this.stop(id)));
    return { ok: true, stopped: ids.length };
  }

  /** 应用启动时按配置里的 enabled 拉起（用户明确要求"开机不自动启动"，所以默认不调） */
  async startEnabled() {
    const cfg = configForRun();
    if (!cfg.app?.autoStartBots) return { ok: true, started: 0, skipped: 'autoStartBots=false' };
    const ids = cfg.bots.filter(b => b.enabled).map(b => b.id);
    const results = [];
    for (const id of ids) results.push({ id, ...(await this.start(id, { auto: true })) });
    return { ok: true, started: results.filter(r => r.ok).length, results };
  }

  clearStats(botId) {
    const rt = this.runtimes.get(botId);
    if (!rt) return { ok: false, error: '找不到该机器人' };
    rt.llm.calls = 0;
    rt.llm.promptTokens = 0;
    rt.llm.completionTokens = 0;
    rt.llm.todayTokens = 0;
    rt.llm.lastLatencyMs = null;
    rt.gate.passed = 0;
    rt.gate.blocked = 0;
    rt.gate.fallback = 0;
    rt.gate.byReason = {};
    rt.gate.lastDecision = null;
    hub.truncate(botId);
    this.emit('runtime', this.snapshot(botId));
    return { ok: true };
  }
}

export const supervisor = new Supervisor();
