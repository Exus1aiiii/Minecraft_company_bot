// ============================================================================
// MCBOT 测试玩家 —— 用 mineflayer 冒充一个真人玩家连进测试服，按脚本往公屏
// 或私聊发消息，用来验证"限定称谓"唤醒规则。
//
// 它为什么必须存在：验收标准 A2/A5 要求"带称谓 -> bot 响应；不带称谓 ->
// 零 token 短路；另一个玩家说同样的话 -> bot 不响应"。这三条只能用一个
// 真的会说话的第二个客户端来测。
//
// 用法：
//   node tools/test-player.mjs --name Steve --say "你好" --say "小豆你好" --gap 4000
//   node tools/test-player.mjs --name Alex  --whisper "小豆在吗"
//   node tools/test-player.mjs --name Steve --script scripts/wake-test.json
//
// 需要 vendor 里的 mineflayer，所以用 createRequire 锚到引擎的 package.json。
// ============================================================================

import { createRequire } from 'node:module';

const require = createRequire('D:/mc_company_bot/vendor/mindcraft-develop/package.json');
const mineflayer = require('mineflayer');

function argAll(name) {
    const out = [];
    process.argv.forEach((a, i) => { if (a === `--${name}` && process.argv[i + 1]) out.push(process.argv[i + 1]); });
    return out;
}
function arg(name, fallback) {
    const v = argAll(name);
    return v.length ? v[v.length - 1] : fallback;
}

const HOST = arg('host', '127.0.0.1');
const PORT = Number(arg('port', '25565'));
const NAME = arg('name', 'Steve');
const VERSION = arg('version', '1.21.1');
const GAP = Number(arg('gap', '4000'));
const SAYS = argAll('say');
const WHISPERS = argAll('whisper');
const TO = arg('to', null);

const bot = mineflayer.createBot({
    host: HOST,
    port: PORT,
    username: NAME,
    auth: 'offline',
    version: VERSION,
    // 关掉自动版本探测：测试服锁死 1.21.1，避免 ping 阶段的多余往返
    checkTimeoutInterval: 60_000,
});

bot.on('login', () => console.log(`[TEST-PLAYER:${NAME}] logged in`));
bot.on('spawn', async () => {
    console.log(`[TEST-PLAYER:${NAME}] spawned at ${JSON.stringify(bot.entity.position)}`);
    await run();
});
bot.on('kicked', (reason) => console.log(`[TEST-PLAYER:${NAME}] kicked:`, JSON.stringify(reason)));
bot.on('error', (err) => console.log(`[TEST-PLAYER:${NAME}] error:`, err.message));
bot.on('end', (reason) => console.log(`[TEST-PLAYER:${NAME}] end:`, reason));

// 把公屏上所有消息打出来 —— bot 说了什么、有没有说话，这里一目了然。
bot.on('message', (jsonMsg, position) => {
    const text = jsonMsg.toString();
    if (position === 'game_info') return; // 跳过 actionbar
    console.log(`[TEST-PLAYER:${NAME}] <${position}> ${text}`);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
    const plan = [];
    for (const s of SAYS) plan.push({ kind: 'chat', text: s });
    for (const w of WHISPERS) plan.push({ kind: 'whisper', text: w });

    if (plan.length === 0) {
        console.log(`[TEST-PLAYER:${NAME}] 没有 --say/--whisper，进入倾听模式（Ctrl+C 退出）。`);
        return;
    }

    await sleep(1500);
    for (const step of plan) {
        if (step.kind === 'chat') {
            console.log(`[TEST-PLAYER:${NAME}] >>> chat: ${step.text}`);
            bot.chat(step.text);
        } else {
            const target = TO || 'Xiaodou';
            console.log(`[TEST-PLAYER:${NAME}] >>> whisper -> ${target}: ${step.text}`);
            bot.chat(`/msg ${target} ${step.text}`);
        }
        await sleep(GAP);
    }

    console.log(`[TEST-PLAYER:${NAME}] 脚本发完，保持在线 ${Math.round(GAP / 1000)}s 以便观察回复……`);
    await sleep(GAP);
    console.log(`[TEST-PLAYER:${NAME}] done, quitting.`);
    bot.quit();
    process.exit(0);
}
