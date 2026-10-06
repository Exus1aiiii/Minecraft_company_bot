// ============================================================================
// 服务器探测：用引擎实际的协议栈去 ping 目标服务器。
//
// 这是"连接失败"排查链条上的第二环：
//   tools/probe-protocol-stack.mjs   —— 依赖组合本身是否自洽（离线可跑）
//   tools/probe-server-ping.mjs      —— 修好兜底版本后，能不能真的 ping 通（<-- 本文件）
//   runner/engine-launcher.mjs       —— 真拉起引擎
//
// 它会先在进程内应用 V-3 守卫（和注入到引擎里的完全是同一段代码），
// 再走 minecraft-protocol 的 ping —— 也就是 mcserver.js:21 的 serverInfo()
// 实际走的那条路径。
//
// 用法: node tools/probe-server-ping.mjs [host] [port] [目标版本]
// ============================================================================

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyEnginePatches, describeProtocolStack } from '../runner/engine-patches.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_DIR = path.resolve(__dirname, '..', 'vendor', 'mindcraft-develop');

const host = process.argv[2] || '127.0.0.1';
const port = Number(process.argv[3] || 25565);
const target = process.argv[4] || '1.21.1';

process.env.MCBOT_MC_VERSION = target;

console.log('================ MCBOT 服务器探测 ================');
console.log(`目标: ${host}:${port}  期望版本: ${target}`);
console.log('');

const before = describeProtocolStack();
console.log(`--- 修补前 ---`);
console.log(`defaultVersion = ${before.defaultVersion}`);
console.log('');

console.log('--- 应用 V-3 守卫 ---');
applyEnginePatches();
console.log('');

const engineRequire = createRequire(path.join(ENGINE_DIR, 'package.json'));
const mc = engineRequire('minecraft-protocol');

console.log(`--- 现在 ping（mcserver.js:21 走的同一条路） ---`);
mc.ping({ host, port }, (err, response) => {
    if (err) {
        console.error('✗ ping 失败:', err.message);
        console.error('  → 若报 "Cannot read properties of null (reading \'version\')"，说明 V-3 没生效。');
        console.error('  → 其他错误（ECONNREFUSED / ETIMEDOUT）说明服务端没起来或地址端口不对。');
        process.exit(1);
    }
    const v = response?.version || {};
    console.log('✓ ping 成功');
    console.log(`  服务端报告版本 : ${v.name}   protocol=${v.protocol}`);
    console.log(`  MOTD           : ${JSON.stringify(response?.description)}`);
    console.log(`  在线玩家       : ${response?.players?.online}/${response?.players?.max}`);
    console.log('');
    console.log(`结论: 协议栈可用。引擎的 serverInfo()/getServer() 现在能通过。`);
    process.exit(0);
});

// ping 挂了但底层 socket 卡住时别无限等。
setTimeout(() => {
    console.error('✗ 超时：10 秒内没有 ping 响应。');
    console.error('  → 检查服务端是否在监听，以及 sandbox 是否放行该端口。');
    process.exit(1);
}, 10000);
