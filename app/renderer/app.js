// ============================================================================
// app.js —— 渲染进程入口
//
// 职责只有四件事：
//   1. 装配静态外壳（顶部状态条 / 左侧导航 / 内容区）；
//   2. 持有唯一一份内存里的 AppConfig 副本，并把「编辑 → 标脏 → 保存」这条链打通；
//   3. 全局只订阅一次 window.mcbot.onEvent()，把事件分发给当前视图；
//   4. 保证任何一步出错都变成一条中文提示，而不是白屏。
//
// 视图模块统一导出 render(container, ctx)，本文件是唯一调度者。
// ============================================================================

import { h, clear, mount, button, fmtTokens, fmtNum, errText } from './ui.js';
import { installMock } from './mock.js';

import * as botsView from './views/bots.js';
import * as serversView from './views/servers.js';
import * as modelsView from './views/models.js';
import * as personaView from './views/persona.js';
import * as memoryView from './views/memory.js';
import * as skinView from './views/skin.js';
import * as logsView from './views/logs.js';
import * as envView from './views/env.js';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 事件缓冲上限（契约要求：内存里最多留 2000 条，不能无限涨） */
const MAX_BUFFER = 2000;

/** 导航顺序。环境放最后 —— 出问题才去看它。 */
const VIEWS = [botsView, serversView, modelsView, personaView, memoryView, skinView, logsView, envView];

const DEBUG = (() => {
  try {
    return Boolean(window.localStorage.getItem('mcbot.debug'));
  } catch {
    return false;
  }
})();

/** 契约 §七：console.log 保留，但要带 [ui] 前缀，并且别刷屏 */
function log(...args) {
  if (DEBUG) console.log('[ui]', ...args);
}

// ---------------------------------------------------------------------------
// DOM 引用
// ---------------------------------------------------------------------------

const elApp = document.getElementById('app');
const elNav = document.getElementById('nav');
const elContent = document.getElementById('content');
const elToasts = document.getElementById('toasts');
const elStatBots = document.getElementById('stat-bots');
const elStatTokens = document.getElementById('stat-tokens');
const elStatGate = document.getElementById('stat-gate');
const elSaveBar = document.getElementById('save-bar');
const elBrandSub = document.getElementById('brand-sub');
const elEnvQuick = document.getElementById('btn-env-quick');

// ---------------------------------------------------------------------------
// 全局状态
// ---------------------------------------------------------------------------

const state = {
  /** 内存里的配置副本：所有编辑都直接改它，改完调 markDirty() */
  config: null,
  /** 是否真的从主进程拿到过配置（false 时界面处于只读兜底态） */
  configLoaded: false,
  /** BotRuntime[] —— 主进程 1 Hz 推来的全量快照 */
  runtimes: [],
  env: null,
  versions: null,
  viewId: null,
  params: null,
  /** 当前视图实例（render 的返回值） */
  view: null,
  dirty: false,
  saving: false,
  /** 事件缓冲（循环裁剪，上限 MAX_BUFFER） */
  logBuffer: [],
  gateBuffer: [],
  /** 顶栏缓存，避免每帧重建 DOM */
  topCache: { bots: '', tokens: '', gate: '' },
  started: false,
};

// ---------------------------------------------------------------------------
// 兜底配置：主进程彻底读不到配置时，让界面还能显示、还能给出错误
// ---------------------------------------------------------------------------

function fallbackConfig() {
  return {
    version: 1,
    llm: { profiles: [] },
    servers: [],
    bots: [],
    app: { autoStartBots: false, language: 'zh' },
  };
}

// ---------------------------------------------------------------------------
// 提示条 / 顶部状态条
// ---------------------------------------------------------------------------

/**
 * 弹一条中文提示。level: 'ok' | 'info' | 'warn' | 'error'
 * 纯 DOM 实现，不用 alert，不会阻塞。
 */
function toast(msg, level = 'info') {
  const text = String(msg ?? '');
  if (!text) return;
  try {
    console.log(`[ui][${level}] ${text}`);
  } catch {
    /* 忽略：控制台不可用不影响界面 */
  }

  const el = h('div', { class: ['toast', level === 'info' ? '' : level] }, text);
  elToasts.appendChild(el);

  // 最多同时留 5 条，多了把最旧的挤掉
  while (elToasts.children.length > 5) elToasts.removeChild(elToasts.firstChild);

  const life = level === 'error' ? 7000 : 3600;
  setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 200);
  }, life);

  el.addEventListener('click', () => {
    if (el.parentNode) el.parentNode.removeChild(el);
  });
}

/** 顶部状态条：在线 bot 数 / 今日 token / 门禁拦截 */
function renderTopbar() {
  const list = state.runtimes || [];

  const running = list.filter((r) => r.status === 'running' || r.status === 'reconnecting').length;
  const total = list.length;
  const botsText = `${running} / ${total}`;
  if (state.topCache.bots !== botsText) {
    state.topCache.bots = botsText;
    mount(elStatBots, h('span', {}, '在线'), h('b', {}, botsText));
    elStatBots.className = ['topbar-stat', running > 0 ? 'ok' : total > 0 ? 'warn' : ''];
  }

  let todayTokens = 0;
  let allTokens = 0;
  for (const rt of list) {
    const llm = rt.llm || {};
    todayTokens += Number(llm.todayTokens) || 0;
    allTokens += (Number(llm.promptTokens) || 0) + (Number(llm.completionTokens) || 0);
  }
  const tokensText = `${fmtTokens(todayTokens)}|${fmtTokens(allTokens)}`;
  if (state.topCache.tokens !== tokensText) {
    state.topCache.tokens = tokensText;
    mount(
      elStatTokens,
      h('span', {}, '今日 token'),
      h('b', { title: `今日 ${fmtNum(todayTokens)} · 累计 ${fmtNum(allTokens)}` }, fmtTokens(todayTokens))
    );
  }

  let blocked = 0;
  for (const rt of list) blocked += Number((rt.gate && rt.gate.blocked) || 0);
  const gateText = String(blocked);
  if (state.topCache.gate !== gateText) {
    state.topCache.gate = gateText;
    mount(elStatGate, h('span', {}, '门禁拦截'), h('b', {}, gateText));
    elStatGate.className = ['topbar-stat', blocked > 0 ? 'warn' : ''];
  }
}

/** 脏标记 / 保存按钮 */
function renderSaveBar() {
  clear(elSaveBar);

  if (!state.configLoaded) {
    elSaveBar.appendChild(h('span', { class: 'dirty-flag' }, '配置未加载'));
    return;
  }
  if (state.saving) {
    elSaveBar.appendChild(h('span', { class: 'dirty-flag' }, '保存中…'));
    return;
  }
  if (!state.dirty) return;

  elSaveBar.appendChild(h('span', { class: 'dirty-flag' }, '有未保存的修改'));
  elSaveBar.appendChild(
    button('保存', { level: 'primary', small: true, title: 'Ctrl+S', onClick: () => saveConfig() })
  );
  elSaveBar.appendChild(
    button('放弃修改', {
      level: 'ghost',
      small: true,
      onClick: async () => {
        state.dirty = false;
        renderSaveBar();
        await reload({ silent: true });
        toast('已放弃未保存的修改，回到磁盘上的配置', 'info');
      },
    })
  );
}

// ---------------------------------------------------------------------------
// 事件缓冲
// ---------------------------------------------------------------------------

function trimBuffer(arr) {
  if (arr.length > MAX_BUFFER) arr.splice(0, arr.length - MAX_BUFFER);
  return arr;
}

/**
 * 处理一条 McbotEvent。运行态事件会顺手刷新顶栏与当前视图；
 * 日志类事件只进缓冲（由视图下次 update 时自取），避免每帧重建 DOM。
 */
function handleEvent(ev) {
  if (!ev || typeof ev !== 'object') return;

  switch (ev.type) {
    case 'runtime': {
      if (Array.isArray(ev.bots)) state.runtimes = ev.bots;
      renderTopbar();
      refreshView();
      break;
    }

    case 'status': {
      const rt = state.runtimes.find((r) => r.id === ev.botId);
      if (rt) {
        rt.status = ev.status;
        rt.pid = ev.pid === undefined ? rt.pid : ev.pid;
      }
      renderTopbar();
      refreshView();
      break;
    }

    case 'log': {
      state.logBuffer.push({
        ts: ev.ts || Date.now(),
        botId: ev.botId || null,
        source: 'engine',
        level: ev.level || 'info',
        line: String(ev.line ?? ''),
      });
      trimBuffer(state.logBuffer);
      break;
    }

    case 'gate': {
      const row = {
        ts: ev.ts || Date.now(),
        botId: ev.botId || null,
        source: 'gate',
        level: ev.decision === 'BLOCK' ? 'info' : 'info',
        decision: ev.decision,
        reason: ev.reason || '',
        from: ev.from || '',
        channel: ev.channel || 'chat',
        line: `${ev.decision} ${ev.reason || ''} from=${ev.from || '?'} ${ev.text ? `-> ${ev.text}` : ''}`.trim(),
      };
      state.gateBuffer.push(row);
      trimBuffer(state.gateBuffer);
      state.logBuffer.push(row);
      trimBuffer(state.logBuffer);
      break;
    }

    case 'llm': {
      const ok = ev.ok !== false;
      const row = {
        ts: ev.ts || Date.now(),
        botId: ev.botId || null,
        source: 'llm',
        level: ok ? 'info' : 'error',
        model: ev.model || '',
        line: ok
          ? `调用 ${ev.model || '模型'} 完成：prompt ${fmtNum(ev.promptTokens || 0)} + completion ${fmtNum(ev.completionTokens || 0)} tokens，耗时 ${ev.ms || 0}ms`
          : `调用 ${ev.model || '模型'} 失败`,
      };
      state.logBuffer.push(row);
      trimBuffer(state.logBuffer);
      break;
    }

    case 'notice': {
      state.logBuffer.push({
        ts: Date.now(),
        botId: null,
        source: 'notice',
        level: ev.level || 'info',
        line: String(ev.text ?? ''),
      });
      trimBuffer(state.logBuffer);
      if (ev.text) toast(ev.text, ev.level === 'error' ? 'error' : ev.level === 'warn' ? 'warn' : 'info');
      break;
    }

    default:
      log('收到未知事件类型：', ev.type);
  }
}

/** 把运行态变化推给当前视图（视图自己决定要不要重建 DOM）
 *
 *  做 250ms 合并：引擎的事件是突发的（一次对话可能连出十几条 log/gate/llm），
 *  如果每条都触发视图重绘，日志页会白烧 CPU。运行态本身是 1 Hz 快照，
 *  这里顺带还压掉了同一帧里的重复刷新。
 */
let viewTimer = null;
let viewDirty = false;

function refreshView() {
  if (!state.view || typeof state.view.update !== 'function') return;
  viewDirty = true;
  if (viewTimer !== null) return;
  viewTimer = setTimeout(() => {
    viewTimer = null;
    if (!viewDirty) return;
    viewDirty = false;
    try {
      state.view.update();
    } catch (err) {
      console.error('[ui] 视图更新失败：', err);
    }
  }, 250);
}

/** 立即（同步）刷新当前视图，用于切页、手动刷新这种要马上见效的场合 */
function refreshViewNow() {
  if (viewTimer !== null) {
    clearTimeout(viewTimer);
    viewTimer = null;
  }
  viewDirty = false;
  if (state.view && typeof state.view.update === 'function') {
    try {
      state.view.update();
    } catch (err) {
      console.error('[ui] 视图更新失败：', err);
    }
  }
}

// ---------------------------------------------------------------------------
// 视图调度
// ---------------------------------------------------------------------------

function buildNav() {
  clear(elNav);
  VIEWS.forEach((mod) => {
    const item = h(
      'div',
      {
        class: ['nav-item', mod.id === state.viewId ? 'active' : ''],
        title: mod.label,
        on: { click: () => goto(mod.id) },
      },
      h('span', { class: 'nav-icon' }, mod.icon || '·'),
      h('span', {}, mod.label)
    );
    elNav.appendChild(item);
  });

  elNav.appendChild(h('div', { class: 'nav-sep' }));

  const foot = h('div', { class: 'nav-foot' });
  elNav.appendChild(foot);

  // 底部：数据来源提示 + 演示数据开关状态
  const isMock = Boolean(window.__MCBOT_MOCK__);
  foot.appendChild(
    h(
      'div',
      { class: 'field-hint' },
      isMock ? '当前：内置演示数据' : '当前：主进程 IPC'
    )
  );
  foot.appendChild(
    h('div', { class: 'field-hint' }, `事件缓冲上限 ${MAX_BUFFER} 条`)
  );
}

/** 切换视图。params 会传给视图的 render（例如 logs 的 { botId }） */
function goto(viewId, params = null) {
  const target = VIEWS.find((m) => m.id === viewId);
  if (!target) {
    toast(`没有这个页面：${viewId}`, 'error');
    return;
  }

  // 有未保存的修改时提醒一句（不阻断，避免把人的操作卡住）
  if (state.dirty && state.viewId && state.viewId !== viewId) {
    try {
      if (!window.confirm('当前有未保存的修改，切换页面会保留它们（配置还在内存里）。继续？')) return;
    } catch {
      /* confirm 不可用就不拦 */
    }
  }

  state.viewId = viewId;
  state.params = params;

  // 旧视图退场
  if (state.view && typeof state.view.dispose === 'function') {
    try {
      state.view.dispose();
    } catch (err) {
      console.error('[ui] 视图 dispose 抛错：', err);
    }
  }
  state.view = null;

  clear(elContent);
  // 导航高亮：直接按 viewId 重建，最省事也最不容易跟状态脱节
  buildNav();

  try {
    const inst = target.render(elContent, ctx);
    state.view = inst && typeof inst === 'object' ? inst : null;
  } catch (err) {
    console.error('[ui] 视图渲染失败：', err);
    clear(elContent);
    mount(
      elContent,
      h(
        'div',
        { class: 'notice error' },
        h('span', { class: 'notice-title' }, `「${target.label}」页渲染失败`),
        `${errText(err)} —— 这是界面自身的 bug。其它页面仍然可以用，请把这句话连同控制台报错一起反馈。`
      )
    );
  }

  log('切换到视图', viewId, params || '');
}

// ---------------------------------------------------------------------------
// 脏标记与保存
// ---------------------------------------------------------------------------

function markDirty() {
  state.dirty = true;
  renderSaveBar();
}

/**
 * 保存配置。返回 { ok, errors }：
 *   ok === false 时 errors[] 里的每条都会红字提示，并且**不清脏标记**。
 */
async function saveConfig(opts = {}) {
  if (!state.configLoaded) {
    toast('配置还没加载成功，暂时不能保存', 'error');
    return { ok: false, errors: ['配置未加载'] };
  }
  if (state.saving) return { ok: false, errors: [] };

  state.saving = true;
  renderSaveBar();

  let res = null;
  try {
    res = await window.mcbot.saveConfig(state.config);
  } catch (err) {
    state.saving = false;
    renderSaveBar();
    const msg = `保存失败：${errText(err)}`;
    toast(msg, 'error');
    return { ok: false, errors: [msg] };
  }

  state.saving = false;

  if (!res || typeof res !== 'object') {
    renderSaveBar();
    toast('保存失败：主进程没有返回结果', 'error');
    return { ok: false, errors: ['主进程没有返回结果'] };
  }

  const errors = Array.isArray(res.errors) ? res.errors.filter(Boolean) : [];

  if (res.ok === false || errors.length) {
    // 校验没过：脏标记保留，让人接着改
    renderSaveBar();
    if (!opts.silent) {
      toast(`配置没有通过校验，共 ${errors.length || 1} 处问题：`, 'error');
      for (const e of errors.length ? errors : ['主进程拒绝了这次保存，但没给出原因']) {
        toast(String(e), 'error');
      }
    }
    return { ok: false, errors };
  }

  // 成功：清脏标记，并用主进程回填后的配置刷新内存副本
  state.dirty = false;
  try {
    const fresh = await window.mcbot.getConfig();
    if (fresh && typeof fresh === 'object') {
      state.config = fresh;
      ctx.config = fresh;
      // 当前视图可能引用了旧副本里的对象，重挂一次最稳妥
      remountView();
    }
  } catch (err) {
    log('保存后重新读取配置失败（不影响已落盘的结果）：', errText(err));
  }

  renderSaveBar();
  if (!opts.silent) toast('配置已保存', 'ok');
  return { ok: true, errors: [] };
}

/** 重新从主进程拉配置 / 运行态 / 环境，并重挂当前视图 */
async function reload(opts = {}) {
  const cfg = await loadConfig({ silent: opts.silent !== false });
  if (!cfg) return false;

  await Promise.all([
    refreshRuntimes(),
    state.env ? Promise.resolve() : refreshEnv(),
  ]);

  state.dirty = false;
  renderSaveBar();
  renderTopbar();
  remountView();
  return true;
}

function remountView() {
  const id = state.viewId;
  if (!id) return;
  // 直接重挂：清掉视图内部状态，避免它抱着旧的对象引用。
  // 注意这里不能碰 state.dirty（保存成功后它就是 false），只把 params 带上。
  const keepParams = state.params;
  state.viewId = null;
  goto(id, keepParams);
}

// ---------------------------------------------------------------------------
// ctx —— 传给每个视图的上下文
// ---------------------------------------------------------------------------

const ctx = {
  get config() {
    return state.config;
  },
  set config(v) {
    state.config = v;
  },
  get runtimes() {
    return state.runtimes;
  },
  get env() {
    return state.env;
  },
  set env(v) {
    state.env = v;
  },
  get versions() {
    return state.versions;
  },
  set versions(v) {
    state.versions = v;
  },
  get params() {
    return state.params;
  },
  get logBuffer() {
    return state.logBuffer;
  },
  get gateBuffer() {
    return state.gateBuffer;
  },

  markDirty,
  save: saveConfig,
  reload,
  toast,
  goto,
  runtimeById,

  /**
   * 统一调用 window.mcbot：
   *   成功 → 返回结果；抛异常 → 中文提示 + 返回 null。
   * opts.silent = true 时不弹提示（调用方自己决定怎么报错）。
   */
  async call(what, fn, opts = {}) {
    if (typeof fn !== 'function') return null;
    try {
      return await fn();
    } catch (err) {
      console.error(`[ui] ${what} 抛错：`, err);
      if (!opts.silent) toast(`${what}失败：${errText(err)}`, 'error');
      return null;
    }
  },

  /** call 的简写：跑一段操作，成功/失败各给一句提示 */
  async run(what, fn, opts = {}) {
    const res = await ctx.call(what, fn, { silent: true });
    if (res && res.ok === false) {
      toast(`${what}失败：${res.error || '未知原因'}`, 'error');
      return res;
    }
    if (res === null || res === undefined) {
      if (!opts.silentFail) toast(`${what}失败：主进程没有响应`, 'error');
      return res;
    }
    if (opts.done) toast(opts.done, 'ok');
    return res;
  },
};

function runtimeById(id) {
  return (state.runtimes || []).find((r) => r.id === id) || null;
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

async function loadConfig(opts = {}) {
  let cfg = null;
  try {
    cfg = await window.mcbot.getConfig();
  } catch (err) {
    console.error('[ui] getConfig 抛错：', err);
    if (!opts.silent) toast(`读取配置失败：${errText(err)}`, 'error');
  }

  if (cfg && typeof cfg === 'object') {
    state.config = cfg;
    state.configLoaded = true;
    // 结构兜底：视图里到处都在 cfg.servers.find，缺了会直接抛错
    if (!Array.isArray(state.config.servers)) state.config.servers = [];
    if (!Array.isArray(state.config.bots)) state.config.bots = [];
    if (!state.config.llm || typeof state.config.llm !== 'object') state.config.llm = { profiles: [] };
    if (!Array.isArray(state.config.llm.profiles)) state.config.llm.profiles = [];
    if (!state.config.app || typeof state.config.app !== 'object') {
      state.config.app = { autoStartBots: false, language: 'zh' };
    }
    return state.config;
  }

  // 读不到就用兜底配置，界面照常显示（保存会被拒绝并说明原因）
  state.config = state.config || fallbackConfig();
  state.configLoaded = false;
  renderSaveBar();
  return null;
}

async function refreshRuntimes() {
  const list = await ctx.call('读取机器人列表', () => window.mcbot.listBots(), { silent: true });
  if (Array.isArray(list)) {
    state.runtimes = list;
    renderTopbar();
  }
}

async function refreshEnv() {
  const env = await ctx.call('读取环境信息', () => window.mcbot.getEnv(), { silent: true });
  if (env && typeof env === 'object') {
    state.env = env;
    state.versions = state.versions || null;
  }
  const versions = await ctx.call('读取程序版本', () => window.mcbot.getVersions(), { silent: true });
  if (versions && typeof versions === 'object') state.versions = versions;
}

function bindShortcuts() {
  window.addEventListener('keydown', (e) => {
    if (!e.ctrlKey || e.altKey) return;
    if (e.key === 's' || e.key === 'S') {
      e.preventDefault();
      if (state.dirty) saveConfig();
      else toast('没有需要保存的修改', 'info');
      return;
    }
    const n = Number(e.key);
    if (n >= 1 && n <= VIEWS.length) {
      e.preventDefault();
      goto(VIEWS[n - 1].id);
    }
  });
}

function bindGlobalErrors() {
  window.addEventListener('error', (e) => {
    console.error('[ui] 未捕获的错误：', e.error || e.message);
    toast(`界面出了个错：${errText(e.error || e.message)}`, 'error');
  });
  window.addEventListener('unhandledrejection', (e) => {
    console.error('[ui] 未处理的 Promise 拒绝：', e.reason);
    toast(`有异步操作失败了：${errText(e.reason)}`, 'error');
  });
}

async function start() {
  if (state.started) return;
  state.started = true;

  // ① 没有主进程时（浏览器直接打开 index.html）装上演示数据
  try {
    const installed = installMock(window);
    if (installed) {
      console.log('[ui] 未检测到 window.mcbot，已启用内置演示数据（仅用于界面验收，不会真的连服务器）');
      if (elBrandSub) elBrandSub.textContent = '演示数据';
    }
  } catch (err) {
    console.error('[ui] 安装演示数据失败：', err);
  }

  if (!window.mcbot) {
    clear(elContent);
    mount(
      elContent,
      h(
        'div',
        { class: 'notice error' },
        h('span', { class: 'notice-title' }, '没有可用的 window.mcbot'),
        '既没有主进程注入的 preload API，内置演示实现也没装上。界面无法工作 —— 请通过主程序启动，或用浏览器打开 app/renderer/index.html（会自动启用演示数据）。'
      )
    );
    return;
  }

  bindGlobalErrors();
  bindShortcuts();

  if (elEnvQuick) {
    elEnvQuick.addEventListener('click', () => goto('env'));
  }

  // ② 导航（静态的，先画出来，后面 goto 只改高亮）
  buildNav();

  // ③ 配置
  const cfg = await loadConfig();
  if (!cfg) {
    toast('没能从主进程读到配置，界面处于只读兜底状态', 'error');
  }

  // ④ 运行态 + 环境（并行，失败也不阻塞界面）
  await Promise.all([refreshRuntimes(), refreshEnv()]);

  renderTopbar();
  renderSaveBar();

  // ⑤ 第一个视图
  goto(VIEWS[0].id);

  // ⑥ 全局只订阅一次事件
  try {
    const off = window.mcbot.onEvent(handleEvent);
    if (typeof off === 'function') {
      window.addEventListener('beforeunload', () => {
        try {
          off();
        } catch {
          /* 关窗时出错无所谓 */
        }
      });
    }
    log('事件订阅完成');
  } catch (err) {
    console.error('[ui] onEvent 订阅失败：', err);
    toast(`订阅运行事件失败：${errText(err)} —— 界面不会自动刷新，可以手动点「刷新」`, 'error');
  }

  log('界面启动完成', { mock: Boolean(window.__MCBOT_MOCK__), views: VIEWS.length });
}

// 让控制台里能手动戳一戳（调试用，不影响正常流程）
window.mcbotUI = {
  state,
  ctx,
  goto,
  toast,
  save: saveConfig,
  reload,
  get buffers() {
    return { log: state.logBuffer.length, gate: state.gateBuffer.length };
  },
};

start().catch((err) => {
  console.error('[ui] 启动失败：', err);
  try {
    clear(elContent);
    mount(
      elContent,
      h(
        'div',
        { class: 'notice error' },
        h('span', { class: 'notice-title' }, '界面启动失败'),
        `${errText(err)} —— 请把控制台的完整报错一起反馈。`
      )
    );
  } catch {
    /* 已经没法再渲染了 */
  }
});
