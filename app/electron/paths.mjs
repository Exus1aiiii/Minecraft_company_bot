// app/electron/paths.mjs
// 全应用唯一的路径解析处。**不要在任何其他地方拼路径，也不要依赖 process.cwd()。**
//
// 两个根必须分清：
//   APP_DIR      = app\        （Electron 自己的代码）
//   PROJECT_ROOT = 仓库根      （vendor\ runner\ runtime\ tools\ 都在这下面）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // app\electron

export const APP_DIR = path.dirname(HERE);                        // app\
export const PROJECT_ROOT = path.dirname(APP_DIR);                // 仓库根

// ★ 这里有**两个** runtime 目录，别把它们搞混 —— 我第一版就混了，代价是
//   自检脚本一开沙箱就找不到 Node 运行时（`env.nodePath` 为空，supervisor
//   直接拒绝启动，报的还是个没头没尾的 `error: undefined`）。
//
//   RUNTIME_HOME = 随应用一起分发的东西：Node 运行时、Java、测试服务端。
//                  它属于"程序"，不是"用户数据"，**不可重定向**。
//   RUNTIME_DIR  = 用户数据：config.json / secrets.json / logs / tmp。
//                  **可以**用 MCBOT_RUNTIME_DIR 整体重定向到沙箱。
//
//   为什么需要重定向：自检脚本必须把配置改成"指向本地假模型"才能起进程，
//   而 supervisor 是从磁盘读配置的。原先的做法是"先备份、跑完还原"，
//   结果我一次 `... | Select-Object -First 20` 截断输出，PowerShell 直接把
//   node 硬杀了 —— finally 和 process.on('exit') 都跑不到，用户的
//   runtime\config.json 里就留下了"三个模型全指向 127.0.0.1:8799 + 多了一个
//   测试 bot"。现在自检把整个用户数据目录指到沙箱，**物理上碰不到**用户的
//   文件，从此不依赖"记得还原"这种纪律。
//
//   顺带也对用户有用：将来做"多套配置 / 便携模式"就是这个挂点。
export const RUNTIME_HOME = path.join(PROJECT_ROOT, 'runtime');
export const RUNTIME_DIR = process.env.MCBOT_RUNTIME_DIR
  ? path.resolve(process.env.MCBOT_RUNTIME_DIR)
  : RUNTIME_HOME;
export const LOG_DIR = path.join(RUNTIME_DIR, 'logs');
export const TMP_DIR = path.join(RUNTIME_DIR, 'tmp');
// 长期记忆：bot 记住的事（主人是谁、家在哪、答应过什么、一起干过什么）。
// 放在用户数据区而不是引擎的 ./bots/<名字>/ 里 —— 引擎那份是"为了省 token 而
// 压缩上下文"用的摘要（硬上限 500 字符、每次重写都要花一次模型调用），
// 而且我们启动时是 load_memory:false，重启就归零。这份是我们自己的，重启不丢。
export const MEMORY_DIR = path.join(RUNTIME_DIR, 'memory');
export const CONFIG_FILE = path.join(RUNTIME_DIR, 'config.json');
export const SECRETS_FILE = path.join(RUNTIME_DIR, 'secrets.json');

export const ENGINE_DIR = path.join(PROJECT_ROOT, 'vendor', 'mindcraft-develop');
export const ENGINE_MAIN = path.join(ENGINE_DIR, 'main.js');
export const ENGINE_MODULES = path.join(ENGINE_DIR, 'node_modules');

export const RUNNER_DIR = path.join(PROJECT_ROOT, 'runner');
export const GATE_FILE = path.join(RUNNER_DIR, 'mcbot-gate.mjs');
export const LAUNCHER_FILE = path.join(RUNNER_DIR, 'engine-launcher.mjs');
export const PATCHES_FILE = path.join(RUNNER_DIR, 'engine-patches.mjs');
export const PERSONAS_DIR = path.join(RUNNER_DIR, 'personas');
export const BOTS_DIR = path.join(RUNNER_DIR, 'bots');
export const PROFILES_DIR = path.join(RUNNER_DIR, 'profiles');

export const TOOLS_DIR = path.join(PROJECT_ROOT, 'tools');
export const APP_ASSETS_DIR = path.join(APP_DIR, 'assets');
export const RENDERER_DIR = path.join(APP_DIR, 'renderer');

// ─────────────────────────────────────────────────────────────────────────────
// Node 运行时：引擎**必须**跑在 Node 22 上（依赖要求 >=22，且 README 警告 v24+）
// ─────────────────────────────────────────────────────────────────────────────

const NODE_MAJOR_MIN = 22;
const NODE_MAJOR_MAX = 23; // 排他上界：24 会踩原生依赖与行为差异

/** 扫描 runtime\ 下所有 node-v<major>.<...>-win-x64\node.exe，挑一个合适的。
 *  版本号直接从目录名解析，不额外起进程去问 —— 少一个失败点。 */
export function findNodeRuntime() {
  const candidates = [];
  try {
    for (const name of fs.readdirSync(RUNTIME_HOME)) {
      const m = /^node-v(\d+)\.(\d+)\.(\d+)-win-x64$/.exec(name);
      if (!m) continue;
      const exe = path.join(RUNTIME_HOME, name, 'node.exe');
      if (fs.existsSync(exe)) {
        candidates.push({ dir: path.join(RUNTIME_HOME, name), exe, major: Number(m[1]), full: `${m[1]}.${m[2]}.${m[3]}` });
      }
    }
  } catch { /* runtime 不存在 */ }

  // 优先：major 落在 [22,23) 且版本号最高的那个
  const usable = candidates
    .filter(c => c.major >= NODE_MAJOR_MIN && c.major < NODE_MAJOR_MAX)
    .sort((a, b) => b.major - a.major || a.full.localeCompare(b.full));
  if (usable.length) return { ...usable[0], ok: true, reason: '' };

  // 退而求其次：任何存在的 node，但要如实报告风险
  if (candidates.length) {
    const c = candidates.sort((a, b) => b.major - a.major)[0];
    return { ...c, ok: false, reason: `运行时 Node v${c.full} 不在受支持的 22.x 区间，引擎可能启动失败` };
  }
  return { exe: null, dir: null, major: 0, full: null, ok: false, reason: 'runtime\\ 下找不到 node-v22*-win-x64\\node.exe' };
}

/** Java（仅皮肤/协议代理等可选功能需要；本体不需要）。
 *  标记文件在 RUNTIME_HOME（随应用分发），不是用户数据目录。 */
export function findJava() {
  const marker = path.join(RUNTIME_HOME, 'java-home.txt');
  try {
    const home = fs.readFileSync(marker, 'utf8').trim();
    const exe = path.join(home, 'bin', 'java.exe');
    if (home && fs.existsSync(exe)) return { home, exe, ok: true };
  } catch { /* 没有标记文件 */ }
  return { home: null, exe: null, ok: false };
}

export function ensureDirs() {
  for (const d of [RUNTIME_DIR, LOG_DIR, TMP_DIR, MEMORY_DIR, BOTS_DIR, PROFILES_DIR]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch { /* 已存在 */ }
  }
}

export function logFileFor(botId) {
  const safe = String(botId).replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(LOG_DIR, `${safe}.jsonl`);
}

export function memoryFileFor(botId) {
  const safe = String(botId).replace(/[^a-zA-Z0-9._-]/g, '_').replace(/\.{2,}/g, '_');
  return path.join(MEMORY_DIR, `${safe}.json`);
}

export const PATHS = {
  APP_DIR, PROJECT_ROOT, RUNTIME_HOME, RUNTIME_DIR, LOG_DIR, TMP_DIR, MEMORY_DIR,
  CONFIG_FILE, SECRETS_FILE,
  ENGINE_DIR, ENGINE_MAIN, RUNNER_DIR, GATE_FILE, LAUNCHER_FILE, PERSONAS_DIR,
  BOTS_DIR, PROFILES_DIR, TOOLS_DIR, APP_ASSETS_DIR, RENDERER_DIR,
};
