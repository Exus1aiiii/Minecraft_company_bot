// app/preload/preload.mjs
// 渲染进程唯一能碰到主进程的通道。这里是**白名单**：只有下面这些方法存在，
// 渲染进程拿不到 require / fs / ipcRenderer 本体。
//
// 事件通道 `mcbot:event` 推送的形状（与 renderer/mock.js 完全一致）：
//   { type:'runtime', bots:[...] }
//   { type:'status',  botId, status, pid }
//   { type:'log',     botId, ts, level, line }
//   { type:'gate',    botId, ts, decision, reason, from, channel, text }
//   { type:'llm',     botId, ts, model, ms, promptTokens, completionTokens, ok }

import { contextBridge, ipcRenderer } from 'electron';

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('mcbot', {
  // ── 环境 ──
  getEnv: () => invoke('env:get'),
  getVersions: () => invoke('app:versions'),

  // ── 配置 ──
  getConfig: () => invoke('config:get'),
  saveConfig: (cfg) => invoke('config:save', cfg),

  // ── 密钥 ──
  setSecret: (profileId, key) => invoke('secret:set', profileId, key),
  clearSecret: (profileId) => invoke('secret:clear', profileId),
  testLLM: (profileId, keyOverride) => invoke('llm:test', profileId, keyOverride),

  // ── 服务器 ──
  probeServer: (server) => invoke('server:probe', server),
  // MC 版本：`mcVersionCatalog()` 拿候选表，`judgeMcVersion(raw)` 判用户填的这一串行不行。
  // 注意别和上面的 getVersions() 搞混 —— 那个是 Electron/Node 自己的版本号。
  mcVersionCatalog: () => invoke('versions:catalog'),
  judgeMcVersion: (raw) => invoke('versions:judge', raw),

  // ── bot 生命周期 ──
  listBots: () => invoke('bots:list'),
  startBot: (botId) => invoke('bot:start', botId),
  stopBot: (botId) => invoke('bot:stop', botId),
  restartBot: (botId) => invoke('bot:restart', botId),
  stopAll: () => invoke('bot:stopAll'),

  // ── 观测 ──
  readLog: (botId, opts) => invoke('log:read', botId, opts),
  clearStats: (botId) => invoke('stats:clear', botId),

  // ── 皮肤 ──
  pickSkinFile: () => invoke('skin:pick'),
  readSkinFile: (p) => invoke('skin:read', p),

  // ── 人格 ──
  getPersonas: () => invoke('personas:list'),
  listPersonas: () => invoke('personas:list'),

  // ── 长期记忆（bot 记住的事）──
  getMemory: (botId) => invoke('memory:get', botId),
  addMemory: (botId, text) => invoke('memory:add', botId, text),
  forgetMemory: (botId, what) => invoke('memory:forget', botId, what),
  clearMemory: (botId) => invoke('memory:clear', botId),

  // ── 杂项 ──
  openExternal: (url) => invoke('app:openExternal', url),
  pickDirectory: () => invoke('app:pickDirectory'),

  // ── 事件订阅（返回取消订阅函数）──
  onEvent: (handler) => {
    if (typeof handler !== 'function') return () => {};
    const wrapped = (_event, payload) => {
      try { handler(payload); } catch (err) { console.error('[preload] 事件处理出错：', err); }
    };
    ipcRenderer.on('mcbot:event', wrapped);
    return () => ipcRenderer.removeListener('mcbot:event', wrapped);
  },
});
