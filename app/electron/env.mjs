// app/electron/env.mjs
// 环境自检：把所有"能不能跑起来"的前提条件集中检查一遍，用**人话**报告问题。
// 这个模块的存在意义是：用户遇到问题时，界面"环境"页能直接告诉他缺什么、怎么补。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROJECT_ROOT, RUNTIME_DIR, ENGINE_DIR, ENGINE_MAIN, ENGINE_MODULES,
  GATE_FILE, LAUNCHER_FILE, PERSONAS_DIR, findNodeRuntime, findJava,
} from './paths.mjs';
// 协议兜底版本怎么判：直接问引擎自己的判据（runner/engine-patches.mjs 的 V-3）。
// 曾经这里读 minecraft-protocol/src/version.js + 手拼 minecraft-data 的目录来判，
// 结果是**永远误报**：① V-3 只改引擎进程内存里的版本对象、不写盘，所以磁盘上
// defaultVersion 永远是 '26.1'；② minecraft-data 的真实布局比想象的深一层
// （node_modules/minecraft-data/minecraft-data/data/pc/<版本>），手拼的路径根本不存在。
// 现在改成复用引擎自己的检查，装好就是装好，坏了才报。
import { describeProtocolStack } from '../../runner/engine-patches.mjs';

function pkgVersion(pkg) {
  try {
    const t = fs.readFileSync(path.join(ENGINE_MODULES, pkg, 'package.json'), 'utf8');
    return JSON.parse(t).version || null;
  } catch { return null; }
}

/** 协议栈状况：{defaultVersion, chosen, target, known, versions} 或 {error} */
function protocolStack() {
  try {
    const info = describeProtocolStack();
    return info && typeof info === 'object' ? info : { error: 'describeProtocolStack() 没有返回结果' };
  } catch (err) {
    return { error: err?.message || String(err) };
  }
}

function personaIds() {
  try {
    return fs.readdirSync(PERSONAS_DIR).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5));
  } catch { return []; }
}

export function getEnv() {
  const node = findNodeRuntime();
  const java = findJava();
  const problems = [];

  const engineOk = fs.existsSync(ENGINE_MAIN) && fs.existsSync(ENGINE_MODULES);
  const gateOk = fs.existsSync(GATE_FILE);
  const launcherOk = fs.existsSync(LAUNCHER_FILE);
  const personas = personaIds();

  const versions = {
    mineflayer: pkgVersion('mineflayer'),
    minecraftProtocol: pkgVersion('minecraft-protocol'),
    minecraftData: pkgVersion('minecraft-data'),
  };
  const proto = protocolStack();
  const defaultVersion = proto.defaultVersion || null;
  const fallbackOk = !!(proto.chosen && !proto.error);

  // ── 逐条给结论 ──
  if (!node.exe) {
    problems.push('找不到引擎运行时。请在 runtime\\ 下放一份 node-v22.x-win-x64（引擎依赖要求 Node ≥ 22，系统自带的 v24 不能用）。');
  } else if (!node.ok) {
    problems.push(node.reason);
  }

  if (!engineOk) {
    problems.push(`找不到引擎或它的依赖：${ENGINE_DIR}。请先在 vendor\\mindcraft-develop 下执行 npm install。`);
  }
  if (!gateOk) problems.push(`找不到聊天门模块：${GATE_FILE}`);
  if (!launcherOk) problems.push(`找不到启动器：${LAUNCHER_FILE}`);
  if (!personas.length) problems.push(`人格面具目录为空：${PERSONAS_DIR}（界面里的人格预设会显示不出来）`);

  if (engineOk && proto.error) {
    problems.push(`协议栈自检失败：${proto.error} —— 引擎依赖可能没装全，请在 vendor\\mindcraft-develop 下执行 npm ci（见 docs\\05 第五节）。`);
  } else if (engineOk && !proto.chosen) {
    // 两边的版本完全不相交：任何一次连接都必死，这是真问题。
    problems.push(`协议兜底版本 ${defaultVersion || '(未知)'} 在 minecraft-data ${versions.minecraftData} 里没有数据，且找不到任何双方都认识的版本 —— 连接会失败（见 docs\\05 第五节）。`);
  }

  if (!java.ok) {
    // 不是硬问题：只有 ViaProxy / 自建服务端才需要 Java
    problems.push('未检测到 Java（仅"自建服务端 / 跨版本代理"需要，连接现成服务器不需要）。');
  }

  return {
    ok: problems.length === 0,
    projectRoot: PROJECT_ROOT,
    runtimeDir: RUNTIME_DIR,
    nodePath: node.exe,
    nodeDir: node.dir,
    nodeVersion: node.full ? `v${node.full}` : null,
    nodeSupported: node.ok,
    engineDir: ENGINE_DIR,
    engineOk,
    gateOk,
    launcherOk,
    personas,
    javaPath: java.exe,
    versions,
    protocol: {
      defaultVersion,
      fallbackHasData: fallbackOk,
      chosen: proto.chosen || null,
      target: proto.target || '',
      guardWillFix: !!(proto.chosen && defaultVersion && proto.chosen !== defaultVersion),
    },
    problems,
  };
}

/** 一次"能不能真的连上"的深检查，由 IPC 按需触发（会起子进程，别在启动时跑） */
export function getToolPath(name) {
  return path.join(PROJECT_ROOT, 'tools', name);
}

export const ENV_MODULE_PATH = fileURLToPath(import.meta.url);
