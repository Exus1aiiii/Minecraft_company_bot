// ============================================================================
// 盖房结果的**独立取证**工具。
//
// 为什么需要它：盖房流程自己在日志里说"盖好了 20/23 块"，但那是**被告的自述**。
// 要证明世界里真的立起了一栋房子，得换一个客户端、从方块层面把那个位置读回来。
// 这个工具用 mineflayer 冒充一个普通玩家连进去，等区块加载完，把屋子范围内每一格
// 的实际方块名打出来 —— 墙在不在、门洞通不通、屋顶铺满没有，一目了然。
//
// 用法：
//   node tools/inspect-build.mjs --x -13 --y 112 --z -4 --w 3 --d 3 --h 2
//   node tools/inspect-build.mjs ... --out runtime/tmp/build-report.json
//
// 注意：mineflayer 只能读到**自己客户端已加载区块**里的方块，所以假玩家必须
// 站在离房子足够近的地方（本工具默认就站在房子旁边）。
// ============================================================================

import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire('D:/mc_company_bot/vendor/mindcraft-develop/package.json');
const mineflayer = require('mineflayer');

function arg(name, fallback) {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const HOST = arg('host', '127.0.0.1');
const PORT = Number(arg('port', '25565'));
const NAME = arg('name', 'Inspector');
const VERSION = arg('version', '1.21.1');
const X = Number(arg('x', '0'));
const Y = Number(arg('y', '64'));
const Z = Number(arg('z', '0'));
const W = Number(arg('w', '3'));
const D = Number(arg('d', '3'));
const H = Number(arg('h', '2'));
const OUT = arg('out', null);

const AIR = new Set(['air', 'cave_air', 'void_air']);

const bot = mineflayer.createBot({
    host: HOST, port: PORT, username: NAME, auth: 'offline', version: VERSION,
    checkTimeoutInterval: 60_000,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const at = (x, y, z) => bot.blockAt(bot.entity.position.constructor
    ? new (bot.entity.position.constructor)(x, y, z) : { x, y, z });

bot.on('error', (err) => { console.log('[INSPECT] error:', err.message); });
bot.on('kicked', (r) => console.log('[INSPECT] kicked:', JSON.stringify(r)));

bot.on('spawn', async () => {
    // 不做任何移动 —— 世界是服务端权威的，硬改客户端坐标只会被拉回去。
    // 房子离出生点只有十来格，早就落在客户端已加载的区块里了。
    await sleep(6000);   // 等区块收完，读太早会全是 null

    const rows = [];
    let solid = 0; let holes = 0; let unknown = 0;
    for (let y = Y; y <= Y + H; y++) {
        const layer = [];
        for (let z = Z; z <= Z + D - 1; z++) {
            for (let x = X; x <= X + W - 1; x++) {
                const b = at(x, y, z);
                const name = b?.name ?? null;
                if (name === null) unknown++;
                else if (AIR.has(name)) holes++;
                else solid++;
                layer.push(name ?? '?');
            }
        }
        rows.push({ y, blocks: layer });
    }

    const doorX = X + Math.floor((W - 1) / 2);
    const doorOpen = [Y, Y + 1].every((y) => {
        const b = at(doorX, y, Z);
        return b && AIR.has(b.name);
    });

    const report = {
        origin: { x: X, y: Y, z: Z }, size: { w: W, d: D, h: H },
        solid, holes, unknown, doorOpen,
        layers: rows,
    };

    console.log(`[INSPECT] 屋子 ${W}×${D}×${H} @ (${X},${Y},${Z})`);
    for (const r of rows) {
        const grid = [];
        for (let z = 0; z < D; z++) grid.push(r.blocks.slice(z * W, z * W + W).map((n) => (AIR.has(n) ? '·' : n === '?' ? '?' : '#')).join(''));
        console.log(`  y=${r.y}  ${grid.join('   ')}   （· 空气 / # 实体方块 / ? 没读到）`);
    }
    console.log(`[INSPECT] 实体方块 ${solid} 格，空气 ${holes} 格，读不到 ${unknown} 格`);
    console.log(`[INSPECT] 门洞 (${doorX}, ${Y}~${Y + 1}, ${Z}) ${doorOpen ? '是通的 ✓' : '被堵住了 ✗'}`);

    if (OUT) {
        fs.writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8');
        console.log(`[INSPECT] 报告已写入 ${OUT}`);
    }

    bot.quit();
    process.exit(0);
});
