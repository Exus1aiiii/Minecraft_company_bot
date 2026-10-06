// app/electron/main.mjs
// Electron 主进程入口。
//
// 用法：
//   npm start             正常启动
//   npm run dev           带开发者工具
//   npm run shot          截图到 runtime\shots\（用于回归验证界面没崩）
//   electron . --shot=D:\path.png --shot-delay=4000

import { app, BrowserWindow, Menu, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 路径只从 paths.mjs 来 —— 不要在别处另起一份。这里原先自己拼了一个
// `path.join(PROJECT_ROOT, 'runtime')`，于是 MCBOT_RUNTIME_DIR 的重定向对它无效，
// 「整个应用只有一个路径来源」的约定被破了（就是这种重复定义让"沙箱隔离"漏了洞）。
import { RUNTIME_DIR } from './paths.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, '..');
const RENDERER_DIR = path.join(APP_DIR, 'renderer');

const argv = process.argv.slice(1);
const DEV = argv.includes('--dev');
const shotArg = argv.find((a) => a === '--shot' || a.startsWith('--shot='));
const delayArg = argv.find((a) => a.startsWith('--shot-delay='));
const SHOT_PATH = shotArg
  ? (shotArg.includes('=') ? shotArg.split('=').slice(1).join('=') : path.join(RUNTIME_DIR, 'shots', `app-${Date.now()}.png`))
  : null;
const SHOT_DELAY = delayArg ? Number(delayArg.split('=')[1]) || 3000 : 3000;

// 把 Electron 自己的数据目录也收进项目里：一是保持"整个项目可搬走"，
// 二是沙箱环境下 %APPDATA% 可能不可写。
app.setPath('userData', path.join(RUNTIME_DIR, 'electron-userdata'));
app.setPath('sessionData', path.join(RUNTIME_DIR, 'electron-userdata'));
fs.mkdirSync(path.join(RUNTIME_DIR, 'electron-userdata'), { recursive: true });

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    backgroundColor: '#1d1d21',
    autoHideMenuBar: true,
    title: 'MC 陪伴机器人',
    webPreferences: {
      preload: path.join(APP_DIR, 'preload', 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // ESM preload（.mjs）要求关掉沙箱；渲染进程本身仍然碰不到 Node。
      sandbox: false,
      spellcheck: false,
    },
  });

  Menu.setApplicationMenu(null);

  win.once('ready-to-show', () => {
    win.show();
    if (DEV) win.webContents.openDevTools({ mode: 'detach' });
  });

  // 外部链接一律交给系统浏览器，绝不在应用内开新窗口。
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
    }
  });

  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[MCBOT-MAIN] 渲染进程崩溃：', details);
  });
  win.webContents.on('preload-error', (_e, preloadPath, error) => {
    console.error('[MCBOT-MAIN] preload 加载失败：', preloadPath, error);
  });

  win.loadFile(path.join(RENDERER_DIR, 'index.html'));

  if (SHOT_PATH) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          fs.mkdirSync(path.dirname(SHOT_PATH), { recursive: true });
          const img = await win.webContents.capturePage();
          fs.writeFileSync(SHOT_PATH, img.toPNG());
          console.log(`[MCBOT-MAIN] 截图已保存：${SHOT_PATH}`);
        } catch (e) {
          console.error('[MCBOT-MAIN] 截图失败：', e?.message || e);
        } finally {
          app.quit();
        }
      }, SHOT_DELAY);
    });
  }

  win.on('closed', () => { win = null; });
}

// 单实例：第二次启动就把已有窗口拉到前面，避免两个界面同时操作同一个引擎。
if (!app.requestSingleInstanceLock() && !SHOT_PATH) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(async () => {
    // IPC 在这里注册：此时 safeStorage 已经可用（app ready 之后才可靠）
    const { registerIpc } = await import('./ipc.mjs');
    try {
      registerIpc();
    } catch (e) {
      console.error('[MCBOT-MAIN] IPC 注册失败：', e);
    }
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  // ★ 退出前把 bot 全部停掉。否则用户一关界面，引擎进程还在后台跑着，
  //   既烧 token 又占着服务器名额，还会让下一次启动撞上 MindServer 端口占用。
  let quitting = false;
  app.on('before-quit', async (e) => {
    if (quitting) return;
    quitting = true;
    e.preventDefault();
    try {
      const { supervisor } = await import('./supervisor.mjs');
      const running = supervisor.list().filter((b) => b.status !== 'stopped');
      if (running.length) {
        console.log(`[MCBOT-MAIN] 正在停止 ${running.length} 个机器人…`);
        await supervisor.stopAll();
      }
      const { hub } = await import('./events.mjs');
      hub.stop();
    } catch (err) {
      console.error('[MCBOT-MAIN] 退出清理失败：', err?.message || err);
    }
    app.exit(0);
  });
}
