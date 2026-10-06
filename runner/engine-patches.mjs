// ============================================================================
// MCBOT 引擎硬化补丁集（engine patches）
//
// 由 mcbot-gate.mjs 在注入时调用，运行在**引擎进程与每个 agent 子进程内部**，
// 早于任何网络连接发生。这里放的都是"不改动 vendor 源码，但必须在引擎跑起来
// 之前生效"的修正。
//
// ---------------------------------------------------------------------------
// V-3：协议兜底版本守卫（protocol default version guard）
// ---------------------------------------------------------------------------
// 故障现象（2026-10-05 首次 spike 实测）：
//     unsupported protocol version: 26.1
//         at createClient (minecraft-protocol/src/createClient.js:30)
//         at createBot   (mineflayer/lib/loader.js:103)
//         at initBot     (mindcraft/src/utils/mcdata.js:68)
//     以及 TypeError: Cannot read properties of null (reading 'version')
//         at ping (minecraft-protocol/src/ping.js:26)
//
// 根因链：
//   1. minecraft-data@3.97.0 最高只到 1.21.8，而 minecraft-protocol@1.68.0
//      的 version.js 里 defaultVersion = '26.1'，两边不相交。
//   2. ping.js:24 与 createClient.js:28 都是
//          const optVersion = options.version || require('./version').defaultVersion
//          const mcData = require('minecraft-data')(optVersion)
//          if (!mcData) throw new Error(`unsupported protocol version: ${optVersion}`)
//      —— 兜底版本的校验发生在 autoVersion() 有机会纠正版本【之前】。
//   3. 为什么走不到 options.version？因为 mcdata.js:11 是
//          let mc_version = settings.minecraft_version;
//      模块级快照，在 import 时定值。而 agent 子进程要等 serverProxy.connect()
//      的 MindServer 握手才拿到真正的 settings —— 那一刻 mcdata.js 早就 import
//      完了，mc_version 永远是 undefined，于是 mcdata.js:64 执行
//          if (!mc_version || mc_version === "auto") { delete options.version; }
//      子进程【永远】走自动探测。
//   ⇒ 结论：只要 defaultVersion 在 minecraft-data 里没有数据，任何一次连接都必死。
//
// 修法：在引擎进程里把 minecraft-protocol/src/version.js 的 defaultVersion
// 改成"minecraft-data 确实有数据"的版本。autoVersion.js 实测会把
// options.version / options.protocolVersion / client.version 全部纠正成服务端
// 真实版本，所以这个兜底值只需满足两个条件：
//   (a) 在 minecraft-data 里有数据（骗过上面那道 null 检查）；
//   (b) 尽可能接近真实目标版本（因为 options.majorVersion 不会被 autoVersion
//       改写，而 majorVersion 会流进 mineflayer 的 dataPaths 选择）。
// 因此优先用配置里的具体版本，配置是 "auto" 或认不出来时才退到"认识的最高版"。
//
// 为什么改属性而不是打补丁：createClient.js:28 / ping.js:24 都是**调用时**读取
// require('./version').defaultVersion，CJS 模块对象在 require 缓存里是同一个，
// 改属性即可全进程生效，且完全不动 node_modules 里的文件（npm install 冲不掉）。
// ============================================================================

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_DIR = path.resolve(__dirname, '..', 'vendor', 'mindcraft-develop');

// 锚定在引擎的 package.json 上解析，保证拿到的是引擎实际使用的那一份依赖。
const engineRequire = createRequire(path.join(ENGINE_DIR, 'package.json'));

/**
 * 只读地描述当前协议栈状况，不做任何修改。启动器用它做启动前自检。
 * @returns {{defaultVersion: string, known: string[], unknown: string[], chosen: string,
 *            target: string, versions: object} | null} null 表示依赖不完整
 */
export function describeProtocolStack() {
    let mc;
    let versionMod;
    let minecraftData;
    let pkgs;
    try {
        mc = engineRequire('minecraft-protocol');
        versionMod = engineRequire('minecraft-protocol/src/version.js');
        minecraftData = engineRequire('minecraft-data');
        pkgs = {
            mineflayer: engineRequire('mineflayer/package.json').version,
            'minecraft-protocol': engineRequire('minecraft-protocol/package.json').version,
            'minecraft-data': engineRequire('minecraft-data/package.json').version,
        };
    } catch (err) {
        return { error: err.message };
    }

    const target = (process.env.MCBOT_MC_VERSION || '').trim();
    const supported = versionMod.supportedVersions || mc.supportedVersions || [];
    const known = supported.filter((v) => !!minecraftData(v));
    const unknown = supported.filter((v) => !minecraftData(v));
    const chosen = pickFallback(target, known, minecraftData);

    return {
        defaultVersion: versionMod.defaultVersion,
        supported,
        known,
        unknown,
        chosen,
        target,
        versions: pkgs,
    };
}

function pickFallback(target, known, minecraftData) {
    if (target && target !== 'auto' && minecraftData(target)) return target;
    return known.length ? known[known.length - 1] : '';
}

/**
 * V-3：把 defaultVersion 兜底到 minecraft-data 认识的版本。幂等。
 * @returns {{changed: boolean, from: string, to: string, reason: string}}
 */
export function applyProtocolVersionGuard(log = console.log) {
    const info = describeProtocolStack();
    if (info.error) {
        log(`[MCBOT-PATCH] 协议栈自检失败，跳过 V-3：${info.error}`);
        return { changed: false, from: '', to: '', reason: 'unresolvable' };
    }

    if (!info.chosen) {
        log('[MCBOT-PATCH] 严重：minecraft-protocol 与 minecraft-data 没有任何交集版本，无法兜底。');
        return { changed: false, from: info.defaultVersion, to: '', reason: 'no-intersection' };
    }

    if (info.chosen === info.defaultVersion) {
        log(
            `[MCBOT-PATCH] V-3 无需修改：defaultVersion=${info.defaultVersion} 已有数据` +
            `（target=${info.target || '(未设)'}）`
        );
        return { changed: false, from: info.defaultVersion, to: info.defaultVersion, reason: 'already-ok' };
    }

    const versionMod = engineRequire('minecraft-protocol/src/version.js');
    versionMod.defaultVersion = info.chosen;

    log(
        `[MCBOT-PATCH] V-3 已应用：defaultVersion ${info.defaultVersion} -> ${info.chosen}` +
        `（target=${info.target || '(未设)'}）` +
        `\n[MCBOT-PATCH]   minecraft-protocol 无数据的版本：${JSON.stringify(info.unknown)}` +
        `\n[MCBOT-PATCH]   两边都有数据的最高版本：${info.chosen}`
    );
    return { changed: true, from: info.defaultVersion, to: info.chosen, reason: 'patched' };
}

/**
 * 应用全部硬化补丁。注入入口调用它。
 */
export function applyEnginePatches(log = console.log) {
    const results = {};
    results.protocolVersionGuard = applyProtocolVersionGuard(log);
    return results;
}
