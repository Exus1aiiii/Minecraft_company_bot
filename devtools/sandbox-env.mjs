// ============================================================================
// 自检脚本的「沙箱环境」—— 必须在任何 import 之前被求值。
//
// 用法（放在被测脚本的第一行 import，ESM 按声明顺序求值，所以它一定会先跑）：
//
//     import './sandbox-env.mjs';
//     import * as paths from '../app/electron/paths.mjs';
//
// 它做的事：
//   1. 把 process.env.MCBOT_RUNTIME_DIR 指向 runtime\tmp\<名字>\
//      —— paths.mjs 会据此重定向 config / secrets / logs / tmp。
//   2. 把**用户真实配置的一份拷贝**放进沙箱，让测试用的还是用户自己的
//      bot / 服务器 / 模型定义（否则测的就不是真实配置了）。
//
// 为什么值得单独写一个模块：见 paths.mjs 里 RUNTIME_DIR 那段注释。
// 一句话 —— "跑完记得还原"是不可靠的纪律，只有"物理上够不着"才是保证。
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));      // devtools\
const PROJECT_ROOT = path.dirname(HERE);
const REAL_RUNTIME = path.join(PROJECT_ROOT, 'runtime');

const NAME = process.env.MCBOT_SANDBOX_NAME || 'selftest';
const SANDBOX = path.join(REAL_RUNTIME, 'tmp', 'sandbox-' + NAME);

fs.mkdirSync(path.join(SANDBOX, 'logs'), { recursive: true });
fs.mkdirSync(path.join(SANDBOX, 'tmp'), { recursive: true });

// 清空沙箱里的日志。
//
// ★ 为什么必须清：EventHub 是**按目录扫所有 <botId>.jsonl** 的，而不是只读当前
//   测试关心的那一个文件。两个自检脚本共用同一个沙箱目录时，上一个脚本留下的
//   `bot-axiao.jsonl` 会被下一个脚本的 hub 一并读进来 ——
//   `headless-main.mjs` 第 7 节就是因此拿到一条"别人的 gate 事件"而误报失败。
//   测试之间不许通过磁盘串味。
for (const f of fs.readdirSync(path.join(SANDBOX, 'logs'))) {
  if (f.endsWith('.jsonl') || f.endsWith('.log')) {
    fs.rmSync(path.join(SANDBOX, 'logs', f), { force: true });
  }
}

// 拷一份用户真实配置当起点。**每次都重新拷**（而不是"不存在才拷"）——
// 这样两个自检脚本即使共用同一个沙箱目录，各自也都是从用户的真实配置出发的，
// 不会捡到上一个脚本改剩下的东西。
const srcCfg = path.join(REAL_RUNTIME, 'config.json');
const dstCfg = path.join(SANDBOX, 'config.json');
if (fs.existsSync(srcCfg)) fs.copyFileSync(srcCfg, dstCfg);

const srcSec = path.join(REAL_RUNTIME, 'secrets.json');
const dstSec = path.join(SANDBOX, 'secrets.json');
if (fs.existsSync(srcSec)) fs.copyFileSync(srcSec, dstSec);
else fs.rmSync(dstSec, { force: true });

process.env.MCBOT_RUNTIME_DIR = SANDBOX;

export const SANDBOX_DIR = SANDBOX;
export const REAL_CONFIG_FILE = srcCfg;

/**
 * 这个主机名是不是"本机"。
 *
 * ★ 为什么自检脚本需要一个专门的判断：以前脚本里写的是 `cfg.servers[0]` ——
 *   那时用户的配置里只有一台 `srv-local`（127.0.0.1:25565），恰好就是本机服。
 *   后来用户加了自己的线上服（公开版里地址已脱敏），而且**排在数组前面**，
 *   于是 `servers[0]` 一夜之间从"本机测试服"变成了"用户的真服务器"：
 *   `headless-multibot` 把 bot A 指到了线上，测试玩家在本地服里喊话，
 *   A 一条门禁事件都没收到 —— 三处断言变红，而**代码本身一行没错**。
 *
 *   教训：挑服务器要按**意图**挑（"哪台是本机的"），不能按**位置**挑
 *   （"哪台排第一"）。位置是别人（用户的配置）控制的，随时会变。
 */
export function isLoopbackHost(host) {
    const h = String(host || '').trim().toLowerCase();
    return h === 'localhost' || h === '::1' || h === '[::1]' || /^127\./.test(h);
}

/** 按意图挑出"本机那台服务器"；挑不到就返回 null（调用方自己决定怎么办）。 */
export function pickLoopbackServer(servers) {
    return (servers || []).find((s) => isLoopbackHost(s?.host)) || null;
}
