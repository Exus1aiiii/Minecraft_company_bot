// ============================================================================
// 小屋建造器的单元测试。
//
// 为什么值得写：蓝图是"有序方块列表"，而**顺序本身就是正确性**——
// 每一块都必须底下或旁边已经有东西，否则 `skills.placeBlock` 会以
// `nothing to place on` 失败。这个不变式肉眼看不出来（尤其在 5×5 的屋顶上），
// 只能靠程序逐块验。同理，材料数算错会让 bot 盖到一半停下来。
//
// 用法： node tools/test-builder.mjs
// ============================================================================

import { hutPlan, countMaterials, describePlan, checkMaterials, findGroundY, findBuildSite, HUT_PRESETS } from '../runner/builder.mjs';

let pass = 0; let failCount = 0;
const ok = (m) => { pass++; console.log(`  ✓ ${m}`); };
const fail = (m) => { failCount++; console.log(`  ✗ ${m}`); };
const check = (cond, m) => (cond ? ok(m) : fail(m));

const SOLID = (x, y, z) => {
    const key = `${x},${y},${z}`;
    return key;
};

// ── 1. 每一块都必须有支撑（顺序不变式）────────────────────────────────
function verifySupport(plan, name) {
    const ground = new Set(['-1']);              // 虚拟地面：y = -1 一律当实地
    const solid = new Set(ground);
    const placed = new Set();
    let firstBad = null;

    for (const b of plan) {
        const self = `${b.x},${b.y},${b.z}`;
        if (placed.has(self)) { firstBad = `${self} 重复了`; break; }
        const neighbours = [
            `${b.x},${b.y - 1},${b.z}`,      // 下（墙靠这个）
            `${b.x - 1},${b.y},${b.z}`,
            `${b.x + 1},${b.y},${b.z}`,
            `${b.x},${b.y},${b.z - 1}`,
            `${b.x},${b.y},${b.z + 1}`,
        ];
        const supported = b.y === 0 ? true : neighbours.some((n) => solid.has(n));
        if (!supported) { firstBad = `${self} 放的时候底下和四周都还是空的`; break; }
        placed.add(self);
        solid.add(self);
    }
    check(firstBad === null, `${name}：${plan.length} 块全部"放的时候有支撑"${firstBad ? ` —— ${firstBad}` : ''}`);
    return plan.length;
}

console.log('=== 1. 顺序不变式：每块都有支撑 ===');
for (const [key, p] of Object.entries(HUT_PRESETS)) {
    verifySupport(hutPlan({ ...p, block: 'oak_planks' }), key);
}
verifySupport(hutPlan({ w: 7, d: 7, h: 4, block: 'oak_planks' }), '7x7x4');

// ── 2. 几何：墙是空心的，屋顶是实心的，门是通的 ────────────────────────
console.log('=== 2. 几何 ===');
{
    const w = 3, d = 3, h = 2;
    const plan = hutPlan({ w, d, h, block: 'oak_planks' });
    const set = new Set(plan.map((b) => `${b.x},${b.y},${b.z}`));

    check(!set.has('1,0,1') && !set.has('1,1,1'), '屋子中间是空的（人进得去）');

    const doorX = Math.floor((w - 1) / 2);
    check(!set.has(`${doorX},0,0`) && !set.has(`${doorX},1,0`), `南面正中 ${doorX},*,0 两格是门洞`);

    let northSolid = true;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (!set.has(`${x},${y},${d - 1}`)) northSolid = false;
    check(northSolid, '北面是整堵墙 —— 门只开一面，不能打成穿堂');

    let roofFull = true;
    for (let z = 0; z < d; z++) for (let x = 0; x < w; x++) if (!set.has(`${x},${h},${z}`)) roofFull = false;
    check(roofFull, `屋顶 ${w}×${d} 铺满`);

    let wallCount = 0;
    for (const b of plan) if (b.y < h) wallCount++;
    check(wallCount === (w * d - (w - 2) * (d - 2)) * h - 2, `墙的块数 = 周长×高 - 门洞 = ${wallCount}`);
}

// ── 3. 材料统计 ────────────────────────────────────────────────────────
console.log('=== 3. 材料统计 ===');
{
    const small = HUT_PRESETS.small;
    const plan = hutPlan({ ...small, block: 'oak_planks' });
    const m = countMaterials(plan);
    check(m.oak_planks === plan.length, `small 全部是 oak_planks：${m.oak_planks} 块`);
    check(m.oak_planks === 23, `small 需要 23 块（3×3 周长 8 × 高 2 = 16，减门洞 2 = 14，屋顶 9）→ 实测 ${m.oak_planks}`);

    const d = describePlan(plan, small.label);
    check(d.includes('23 块橡木木板') && d.includes('3×3'), `中文说明：${d}`);
}

// ── 4. 材料够不够：四种情形 ────────────────────────────────────────────
console.log('=== 4. 材料检查 ===');
const fakeBot = (items) => ({ inventory: { items: () => items } });
{
    const plan = hutPlan({ ...HUT_PRESETS.small, block: 'oak_planks' });

    const enough = checkMaterials(fakeBot([{ name: 'oak_planks', count: 30 }]), plan);
    check(enough.ok === true, '有 30 块木板 → 够');

    const craftable = checkMaterials(fakeBot([{ name: 'oak_log', count: 10 }]), plan);
    check(craftable.ok === false && craftable.canCraft === true && craftable.craftTimes === 6,
        `只有 10 个原木 → 可以自己合成（要合成 6 次，每次出 4 块，共 24 块 ≥ 23）`);

    const notEnough = checkMaterials(fakeBot([{ name: 'oak_log', count: 2 }]), plan);
    check(notEnough.ok === false && !notEnough.canCraft && notEnough.message.includes('23 块橡木木板'),
        `只有 2 个原木 → 说人话：${notEnough.message}`);

    const nothing = checkMaterials(fakeBot([]), plan);
    check(nothing.ok === false && nothing.message.includes('只有 0 块'), '空手 → 也要说清楚要多少');

    const partial = checkMaterials(fakeBot([{ name: 'oak_planks', count: 5 }]), plan);
    check(partial.ok === false && partial.message.includes('只有 5 块') && partial.message.includes('18 块'),
        `有 5 块 → 明确要再给 18 块：${partial.message}`);

    // ★ 不变式：只要 ok=false，message 就绝不允许是空串。
    //   真机现场出现过「盖房材料不足：」这种半截话 —— 根因是 canCraft 分支返回
    //   message:''，而调用方合成没补齐就走了失败分支。这里把它钉成测试。
    const cases = [
        ['够', [{ name: 'oak_planks', count: 30 }]],
        ['可合成', [{ name: 'oak_log', count: 10 }]],
        ['合成也不够', [{ name: 'oak_log', count: 2 }]],
        ['空手', []],
        ['差一点', [{ name: 'oak_planks', count: 5 }]],
        ['另一类木板也能合', [{ name: 'birch_log', count: 8 }]],
    ];
    let emptyMsg = null;
    for (const [label, items] of cases) {
        const r = checkMaterials(fakeBot(items), hutPlan({ ...HUT_PRESETS.small, block: 'oak_planks' }));
        if (!r.ok && !String(r.message || '').trim()) emptyMsg = label;
    }
    check(emptyMsg === null, `ok=false 时话术永远不为空（六种情形都验了${emptyMsg ? `，漏的是「${emptyMsg}」` : ''}）`);
}

// ── 5. 非法尺寸要报错，而不是默默盖个残废房 ────────────────────────────
console.log('=== 5. 非法输入 ===');
{
    let threw = false;
    try { hutPlan({ w: 2, d: 3, h: 2, block: 'oak_planks' }); } catch { threw = true; }
    check(threw, '2×3 的底会抛错（放不下门）');

    threw = false;
    try { hutPlan({ w: 3, d: 3, h: 1, block: 'oak_planks' }); } catch { threw = true; }
    check(threw, '1 格高的墙会抛错（放不下门）');
}

// ── 6. 找地面：必须喂 Vec3 给 mineflayer ───────────────────────────────
//
// 这条是**真机踩出来的回归测试**：findGroundY 原本传普通 {x,y,z} 给 bot.blockAt()，
// 引擎里直接抛 `TypeError: pos.floored is not a function`
// （prismarine-world/src/worldsync.js:102）—— 单元测试的假 bot 不挑参数，
// 所以当时 18 项全绿也照不出来。这里的假 bot **故意按真实世界层的行为挑食**：
// 只接受带 floored() 的对象，否则原样抛出同样的 TypeError。
console.log('=== 6. 找地面（Vec3 回归）===');
{
    class FakeVec3 {
        constructor(x, y, z) { this.x = x; this.y = y; this.z = z; }
        floored() { return this; }
    }
    const block = (name) => ({ name });
    // 一片 5 格厚的石头，y=63 是地表，上面是空气
    const world = (x, y, z) => block(y <= 63 ? 'stone' : 'air');
    const worldBot = {
        entity: { position: new FakeVec3(0, 64, 0) },
        blockAt(pos) {
            if (typeof pos?.floored !== 'function') throw new TypeError('pos.floored is not a function');
            return world(pos.x, pos.y, pos.z);
        },
    };

    let got = null;
    let err = null;
    try { got = findGroundY(worldBot, 4, 4, 66); } catch (e) { err = e; }
    check(err === null, `喂 Vec3 不抛错${err ? ` —— 实际抛了 ${err.message}` : ''}`);
    check(got === 64, `站在 y=64 的地表上往下找 → 第一层可放墙的是 y=64（实测 ${got}）`);

    // 悬空：往下 12 格全是空气 → 必须返回 null，让上层说"下面是空的"
    const voidBot = {
        entity: { position: new FakeVec3(0, 64, 0) },
        blockAt(pos) {
            if (typeof pos?.floored !== 'function') throw new TypeError('pos.floored is not a function');
            return block('air');
        },
    };
    check(findGroundY(voidBot, 0, 0, 64) === null, '悬空处 → 返回 null（上层据此说"下面是空的"）');

    // 假 bot 没有 entity（单元测试老用法）→ 退回普通对象，也不能抛
    const plainBot = { blockAt: (p) => block(p.y <= 10 ? 'stone' : 'air') };
    check(findGroundY(plainBot, 0, 0, 12) === 11, '没有 entity 的假 bot 退回普通对象也能用');

    // 选址：一片平地 → 找得到；场地全是高低不平 → 老实返回 null
    const flatBot = {
        entity: { position: new FakeVec3(0, 64, 0) },
        blockAt(pos) {
            if (typeof pos?.floored !== 'function') throw new TypeError('pos.floored is not a function');
            return block(pos.y <= 63 ? 'stone' : 'air');
        },
    };
    const site = findBuildSite(flatBot, 0, 0, 66, 3, 3);
    check(site !== null && site.y === 64, `平地上找得到场地：${JSON.stringify(site)}`);
    check(site !== null && (site.x !== 0 || site.z !== 0), '不会盖在玩家脚下（候选点先试旁边的）');

    // 未加载区块：blockAt 一律 null —— 真机上"下面是空的"就是这么来的
    const unloadedBot = {
        entity: { position: new FakeVec3(0, 64, 0) },
        blockAt(pos) {
            if (typeof pos?.floored !== 'function') throw new TypeError('pos.floored is not a function');
            return null;
        },
    };
    check(findBuildSite(unloadedBot, 0, 0, 66, 3, 3) === null, '区块没加载（blockAt 全是 null）→ 返回 null 而不是崩');

    // 锯齿地形：地面高度随 x 每隔 1 格就变，房子四角永远差 2 格以上 → 必须返回 null。
    // 注意高度差要 ≥2：新版的选址允许"四角差 1 格"的退让方案，
    // 差 1 格是会被接受并用最高那层当地基的（下面单独测）。
    const jaggedBot = {
        entity: { position: new FakeVec3(0, 64, 0) },
        blockAt(pos) {
            if (typeof pos?.floored !== 'function') throw new TypeError('pos.floored is not a function');
            const h = 62 + (((pos.x % 3) + 3) % 3) * 2;
            return block(pos.y <= h ? 'stone' : 'air');
        },
    };
    check(findBuildSite(jaggedBot, 0, 0, 80, 3, 3) === null, '到处高低不平（差 ≥2 格）→ 返回 null（上层说"你带我找块平的"）');

    // 差 1 格的缓坡：应该退让接受，并取**最高**那层当地基，而不是放弃
    const slopeBot = {
        entity: { position: new FakeVec3(0, 64, 0) },
        blockAt(pos) {
            if (typeof pos?.floored !== 'function') throw new TypeError('pos.floored is not a function');
            const h = 63 + (((pos.x % 2) + 2) % 2);   // x 偶 → 63，x 奇 → 64
            return block(pos.y <= h ? 'stone' : 'air');
        },
    };
    const slope = findBuildSite(slopeBot, 0, 0, 70, 3, 3);
    check(slope !== null && slope.y >= 64 && slope.y <= 65,
        `差 1 格的缓坡 → 接受，地基取最高那层（不悬空）：${JSON.stringify(slope)}`);

    // ── 整块地基都要空：这是真机第二次踩出来的 ────────────────────────────
    // 现场：上一栋房子还在 (-13,112,-4)，新一轮选址挑了 (-12,112,-5)，
    // 两块地重叠 2×2 格。四角齐平（旧房子外墙顶上也是平的），但中间杵着旧墙，
    // placeBlock 连着 5 次报"放不上去（周围没有支撑面或工具不对）"，最后只有 18/23。
    // 所以现在要求 footprint 的**每一列**都满足"地面在这层或下一层 + 上面 h+1 格全空"。
    const withObstacleBot = (obstacleAt) => ({
        entity: { position: new FakeVec3(0, 64, 0) },
        blockAt(pos) {
            if (typeof pos?.floored !== 'function') throw new TypeError('pos.floored is not a function');
            if (obstacleAt(pos.x, pos.y, pos.z)) return block('oak_planks');
            return block(pos.y <= 63 ? 'stone' : 'air');
        },
    });

    // 玩家正东 3 格处立着一根 1 格高的桩子 —— 四角齐平的假象它照不出来，
    // 但只要有别处更好的平地，就该挑别处
    const onePillar = withObstacleBot((x, y, z) => y === 64 && x === 3 && z === 0);
    const s1 = findBuildSite(onePillar, 0, 0, 66, 3, 3, 2);
    check(s1 !== null && !(s1.x <= 3 && 3 <= s1.x + 2 && s1.z <= 0 && 0 <= s1.z + 2),
        `地基中间有 1 格高的障碍物 → 优先换一块干净的地（选中 ${JSON.stringify(s1)}）`);

    // 两格高的障碍物（树/墙）就真的盖不了：不管地基取哪一层，那一列都顶着头
    const forestBot = withObstacleBot((x, y, z) => y >= 64 && ((x * 7 + z * 13) % 3 === 0));
    check(findBuildSite(forestBot, 0, 0, 66, 3, 3, 2) === null,
        '到处都是两格高的障碍物 → 返回 null 而不是硬盖（老逻辑会挑中一块四角齐平但中间有树的地）');

    // 墙高要参与检查：头顶有天花板时，矮房子盖得下、高房子盖不下
    const ceilingBot = withObstacleBot((x, y, z) => y === 68);
    check(findBuildSite(ceilingBot, 0, 0, 66, 3, 3, 2) !== null, '2 格高的墙：天花板在 y=68，够高 → 盖得下');
    check(findBuildSite(ceilingBot, 0, 0, 66, 3, 3, 4) === null, '4 格高的墙：同一块地被 y=68 的天花板挡住 → 返回 null');
}

console.log(`\n结果：${failCount === 0 ? '✓ 全部通过' : `✗ ${failCount} 个问题`}（共 ${pass + failCount} 项检查）`);
process.exit(failCount === 0 ? 0 : 1);
