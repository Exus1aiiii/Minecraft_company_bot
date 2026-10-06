// devtools/electron.mjs
// 一个「假的 electron 模块」，只在无头自检里通过 loader 顶替真正的 electron。
//
// 理由：这个执行环境起不来 Chromium（启动即 0xC0000005），所以窗口没法验证；
// 但主进程里除了「开窗口」以外的全部逻辑（配置读写、密钥托管、进程守护、IPC、
// 事件翻译）都是纯 Node 代码，完全可以用这个假模块驱动起来跑一遍。
//
// 这里只实现 app/electron/*.mjs 真正用到的那几个 API。

import fs from 'node:fs';
import path from 'node:path';

export const calls = { openExternal: [], openPath: [], dialogs: 0 };

// ---- app ------------------------------------------------------------------
const pathOverrides = new Map();
export const app = {
  isPackaged: false,
  getPath(name) {
    if (pathOverrides.has(name)) return pathOverrides.get(name);
    return path.join(process.cwd(), 'runtime', 'electron-userdata', name);
  },
  setPath(name, value) {
    pathOverrides.set(name, value);
  },
  getName: () => 'mc-company-bot',
  getVersion: () => '0.1.0-headless',
  whenReady: async () => {},
  on() {},
  once() {},
  quit() {
    throw new Error('__HEADLESS_APP_QUIT__');
  },
  exit(code = 0) {
    throw new Error('__HEADLESS_APP_EXIT__:' + code);
  },
  setAppUserModelId() {},
  requestSingleInstanceLock: () => true,
  setName() {},
  disableHardwareAcceleration() {},
  commandLine: { appendSwitch() {}, appendArgument() {} },
};

// ---- BrowserWindow --------------------------------------------------------
export const webContentsStub = {
  send() {},
  on() {},
  once() {},
  setWindowOpenHandler() {},
  capturePage: async () => ({ toPNG: () => Buffer.alloc(0) }),
  openDevTools() {},
  session: { webRequest: { onHeadersReceived() {} } },
};

export class BrowserWindow {
  constructor(opts = {}) {
    this.opts = opts;
    this.webContents = { ...webContentsStub };
    BrowserWindow.instances.push(this);
  }
  static instances = [];
  static getAllWindows() {
    return BrowserWindow.instances;
  }
  loadFile() {
    return Promise.resolve();
  }
  loadURL() {
    return Promise.resolve();
  }
  on() {}
  once() {}
  show() {}
  focus() {}
  isMinimized() {
    return false;
  }
  restore() {}
  isDestroyed() {
    return false;
  }
  destroy() {}
}

// ---- Menu / shell / dialog ------------------------------------------------
export const Menu = {
  setApplicationMenu() {},
  buildFromTemplate: () => ({}),
};

export const shell = {
  openExternal(url) {
    calls.openExternal.push(url);
    return Promise.resolve();
  },
  openPath(p) {
    calls.openPath.push(p);
    return Promise.resolve('');
  },
  showItemInFolder() {},
};

export const dialog = {
  async showOpenDialog(_win, opts = {}) {
    calls.dialogs += 1;
    const file = process.env.MCBOT_HEADLESS_DIALOG_FILE || '';
    if (!file) return { canceled: true, filePaths: [] };
    return { canceled: false, filePaths: [file] };
  },
  async showSaveDialog() {
    return { canceled: true, filePath: undefined };
  },
  async showMessageBox() {
    return { response: 0 };
  },
  async showErrorBox(_t, m) {
    console.error('[electron-stub] showErrorBox:', m);
  },
};

// ---- ipcMain --------------------------------------------------------------
const handlers = new Map();
export const ipcMain = {
  handle(channel, fn) {
    if (handlers.has(channel)) throw new Error('重复注册 IPC handler: ' + channel);
    handlers.set(channel, fn);
  },
  removeHandler(channel) {
    handlers.delete(channel);
  },
  on() {},
  /** 无头自检用：直接按 channel 调主进程的 handler */
  async invoke(channel, ...args) {
    const fn = handlers.get(channel);
    if (!fn) throw new Error('没有注册 IPC handler: ' + channel);
    return fn({ sender: { id: 1 } }, ...args);
  },
  channels() {
    return [...handlers.keys()];
  },
};

export const ipcRenderer = { on() {}, send() {}, invoke: async () => undefined };

// ---- safeStorage ----------------------------------------------------------
// 默认模拟「系统加密不可用」，逼出 store.mjs 的明文降级分支（顺便验证它没写崩）。
// 设 MCBOT_HEADLESS_SAFE_STORAGE=1 可模拟「可用」。
const ENC_ON = process.env.MCBOT_HEADLESS_SAFE_STORAGE === '1';
export const safeStorage = {
  isEncryptionAvailable: () => ENC_ON,
  encryptString(s) {
    if (!ENC_ON) throw new Error('encryption unavailable');
    return Buffer.from('FAKE-ENC:' + s, 'utf8');
  },
  decryptString(buf) {
    if (!ENC_ON) throw new Error('encryption unavailable');
    const s = Buffer.from(buf).toString('utf8');
    if (!s.startsWith('FAKE-ENC:')) throw new Error('bad ciphertext');
    return s.slice('FAKE-ENC:'.length);
  },
  getSelectedStorageBackend: () => (ENC_ON ? 'dpapi' : 'unknown'),
};

export default {
  app,
  BrowserWindow,
  Menu,
  shell,
  dialog,
  ipcMain,
  ipcRenderer,
  safeStorage,
};

// 让 stub 自己别把 fs/path 当未使用变量（保持可读性）
void fs;
