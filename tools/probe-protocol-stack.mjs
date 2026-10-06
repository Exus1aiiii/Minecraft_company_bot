// ============================================================================
// MCBOT 协议栈体检 —— 连接失败时第一个该跑的东西。
//
// 它回答："本机这套 minecraft-data / minecraft-protocol / mineflayer 组合，
// 到底支不支持我想连的那个版本？" 上游 lockfile 被 gitignore，所以每次全新
// 安装这套组合都可能漂移，这个脚本就是防漂移的仪表盘。
//
// 用法: node tools/probe-protocol-stack.mjs [目标版本=1.21.1]
// ============================================================================

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_DIR = path.resolve(__dirname, '..', 'vendor', 'mindcraft-develop');
const require = createRequire(path.join(ENGINE_DIR, 'package.json'));

const target = process.argv[2] || '1.21.1';

const mc = require('minecraft-protocol');
const mcd = require('minecraft-data');
const versionMod = require('minecraft-protocol/src/version.js');
const mcdPkg = require('minecraft-data/package.json');
const mcpPkg = require('minecraft-protocol/package.json');
const mfPkg = require('mineflayer/package.json');

console.log('================ MCBOT 协议栈体检 ================');
console.log(`引擎目录            : ${ENGINE_DIR}`);
console.log(`目标连接版本        : ${target}`);
console.log('');
console.log('--- 实测安装版本 ---');
console.log(`mineflayer          : ${mfPkg.version}   (声明 minecraft-data ${mfPkg.dependencies['minecraft-data']}, minecraft-protocol ${mfPkg.dependencies['minecraft-protocol']})`);
console.log(`minecraft-protocol  : ${mcpPkg.version}   (声明 minecraft-data ${mcpPkg.dependencies['minecraft-data']})`);
console.log(`minecraft-data      : ${mcdPkg.version}`);
console.log('');

console.log('--- 版本常量 ---');
console.log(`minecraft-protocol defaultVersion = ${versionMod.defaultVersion}`);
console.log(`supportedVersions                 = ${JSON.stringify(mc.supportedVersions)}`);
console.log('');

const known = mc.supportedVersions.filter((v) => !!mcd(v));
const unknown = mc.supportedVersions.filter((v) => !mcd(v));
console.log('--- 交集检查（minecraft-protocol 支持 ∩ minecraft-data 有数据）---');
console.log(`两边都有数据 : ${JSON.stringify(known)}`);
console.log(`只有 protocol 支持、data 缺失 : ${JSON.stringify(unknown)}`);
console.log('');

let ok = true;
const fail = (msg) => { ok = false; console.error('  ✗ ' + msg); };
const pass = (msg) => console.log('  ✓ ' + msg);

console.log('--- 判据 ---');

// 判据 1：defaultVersion 必须在 minecraft-data 里有数据。
// 没有的话 createClient.js:30 会在 autoVersion 有机会纠正之前就抛
// "unsupported protocol version: X" —— 这正是引擎报错的原因。
const fallbackData = mcd(versionMod.defaultVersion);
if (!fallbackData) {
    fail(`defaultVersion "${versionMod.defaultVersion}" 在 minecraft-data@${mcdPkg.version} 里没有数据。`);
    console.log(`     → 后果: createClient.js:28-30 会在 autoVersion 纠正版本之前抛 unsupported protocol version。`);
    console.log(`     → 任何不显式指定 version 的连接都会失败（包括引擎的自动探测路径）。`);
    if (known.length) {
        console.log(`     → 建议把 defaultVersion 兜底到 "${known[known.length - 1]}"（我们认识的最高版本）。`);
    }
} else {
    pass(`defaultVersion "${versionMod.defaultVersion}" 有数据（protocol ${fallbackData.version.version}）。`);
}

// 判据 2：目标版本两端都要有。
if (!mcd(target)) {
    fail(`目标版本 ${target} 在 minecraft-data@${mcdPkg.version} 里没有数据。`);
} else {
    pass(`目标版本 ${target} 数据存在（protocol ${mcd(target).version.version}）。`);
}
if (!mc.supportedVersions.includes(target)) {
    fail(`目标版本 ${target} 不在 minecraft-protocol supportedVersions 里。`);
} else {
    pass(`目标版本 ${target} 在 supportedVersions 里。`);
}

// 判据 3：依赖声明是否被 overrides 压到最低要求之下。
const semverFloor = (range) => (range || '').replace(/^[\^~>=<\s]+/, '').split(/\s+/)[0];
const installed = mcdPkg.version;
for (const [name, pkg] of [['mineflayer', mfPkg], ['minecraft-protocol', mcpPkg]]) {
    const floor = semverFloor(pkg.dependencies['minecraft-data']);
    if (floor && floor !== installed) {
        const below = installed.localeCompare(floor, undefined, { numeric: true }) < 0;
        if (below) {
            fail(`${name}@${pkg.version} 要求 minecraft-data ${pkg.dependencies['minecraft-data']}，实装的是更低的 ${installed}。`);
        } else {
            pass(`${name} 的 minecraft-data 要求 ${pkg.dependencies['minecraft-data']} 被 ${installed} 满足。`);
        }
    }
}

// 判据 4：1.21.6 的 checksum 字段类型（上游 patch 处理的就是它）。
for (const v of [target, '1.21.6']) {
    try {
        const p = require(`minecraft-data/minecraft-data/data/pc/${v}/protocol.json`);
        const found = JSON.stringify(p).match(/"name":"checksum"[^}]*}/);
        console.log(`  · ${v} checksum 字段: ${found ? found[0] : '(未找到)'}`);
    } catch {
        console.log(`  · ${v} protocol.json 读不到（该版本无数据）`);
    }
}

console.log('');
console.log(ok ? '结论: 通过 —— 这套组合可用。' : '结论: 不通过 —— 见上面的 ✗。');
process.exit(ok ? 0 : 1);
