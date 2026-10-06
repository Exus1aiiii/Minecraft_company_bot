/**
 * tools/test-explorer.mjs —— 探险器的单元测试
 *
 * 这个测试要挡住的是"看起来走完了、其实什么都没看见"这类假成功：
 * 走 0 格也算成功、读不到群系就整趟判失败、把脚底下的石头当成"发现"报给玩家。
 *
 * 用法：node tools\test-explorer.mjs
 */

import {
    parseExploreIntent, pickTarget, exploreTo, scanAround, describeTrip,
    snapshotPos, DIST_DEFAULT, DIST_MAX, DIST_MIN, DIRECTIONS, HOP_MAX,
} from '../runner/explorer.mjs';

let pass = 0, fail = 0;
function check(cond, label) {
    if (cond) { pass++; console.log('  ✓ ' + label); }
    else { fail++; console.log('  ✗ ' + label); }
}

/** 假 Vec3：世界层要调 `pos.floored()`，所以假 bot 也必须挑这个食。 */
class Vec3 {
    constructor(x, y, z) { this.x = x; this.y = y; this.z = z; }
    floored() { return new Vec3(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z)); }
}

function block(name) { return { name, boundingBox: 'block' }; }

function fakeBot(x, y, z, blockFn) {
    const bot = {
        entity: { position: new Vec3(x, y, z) },
        interrupt_code: false,
        pathfinder: { stopped: false, stop() { this.stopped = true; } },
        blockAt(pos) {
            // 故意按真实世界层的行为挑食（回归测试：见 docs/08 §7c.4 bug#2）
            if (typeof pos?.floored !== 'function') throw new TypeError('pos.floored is not a function');
            return blockFn(pos.x, pos.y, pos.z);
        },
    };
    return bot;
}

/** 平地：y<=63 是石头，上面是空气 */
const flat = (extra = () => null) => (x, y, z) => extra(x, y, z) || block(y <= 63 ? 'stone' : 'air');

console.log('=== 1. 从中文里读出"往哪走、走多远" ===');
{
    const a = parseExploreIntent('四处走走');
    check(a.distance === DIST_DEFAULT && a.heading === null, `"四处走走" → 默认 ${DIST_DEFAULT} 格、不指定方向`);

    const b = parseExploreIntent('往东走 80 格');
    check(b.distance === 80 && b.heading === '东', `"往东走 80 格" → 80 格、朝东`);

    const c = parseExploreIntent('往东北方向走 30 格');
    check(c.heading === '东北', `"东北" 要赢过 "东"（长词优先）：${c.heading}`);

    check(parseExploreIntent('一直往前走 999 格').distance === DIST_MAX, `超远距离被夹到上限 ${DIST_MAX}`);
    check(parseExploreIntent('走 3 格').distance === DIST_MIN, `太近被夹到下限 ${DIST_MIN}（走 3 格不叫探险）`);
    check(Object.keys(DIRECTIONS).length === 8, '八个方向都在');
}

console.log('\n=== 2. 挑目标点：不许往水里跳 ===');
{
    const dry = fakeBot(0, 64, 0, flat());
    const t = pickTarget(dry, 40, '东', () => 0.5);
    check(t.x === 40 && t.z === 0 && t.heading === '东', `朝东 40 格 → (${t.x}, ${t.z})`);

    // 东边全是水 → 必须换方向
    const wet = fakeBot(0, 64, 0, flat((x, y, z) => (x > 10 && y >= 62 && y <= 64 ? block('water') : null)));
    const t2 = pickTarget(wet, 40, '东', () => 0.5);
    check(t2.heading !== '东' && t2.distance > 0, `东边是水 → 换方向（改成往${t2.heading}）`);

    // 四面八方都是岩浆 → 宁可原地报告，也不跳进去
    const lava = fakeBot(0, 64, 0, flat((x, y, z) => (Math.hypot(x, z) > 10 && y >= 62 && y <= 64 ? block('lava') : null)));
    const t3 = pickTarget(lava, 40, '东', () => 0.5);
    check(t3.distance === 0, '四面都是岩浆 → 距离记 0（上层会说"没地方好去"）');
}

console.log('\n=== 3. 走：GoalXZ 而不是 GoalNear ===');
{
    const bot = fakeBot(0, 64, 0, flat());
    const pf = { goals: { GoalXZ: class { constructor(x, z) { this.x = x; this.z = z; } } } };

    // 正常走完：假 skills 把 bot 挪到终点
    const skills = {
        async goToGoal(b, goal) { b.entity.position = new Vec3(goal.x, 64, goal.z); return true; },
    };
    const r = await exploreTo({ bot }, { x: 40, z: 0, distance: 40 }, { skills, pf });
    check(r.ok && r.moved === 40, `走到 (40,0)，实走 ${r.moved} 格`);
    check(r.from.x === 0 && r.to.x === 40, `起点/终点都记下来了：(${r.from.x}) → (${r.to.x})`);

    // ★ 回归：一次寻路不能拉太远。实测拉 48 格穿过森林，pathfinder 在复杂地形里
    //   反复重算，150 秒只挪了 26 格、几乎原地打转 → 必须切成 ≤HOP_MAX 格的短跳。
    const stops = [];
    const hopSkills = {
        async goToGoal(b, goal) { stops.push(goal.x); b.entity.position = new Vec3(goal.x, 64, goal.z); return true; },
    };
    const r6 = await exploreTo({ bot: fakeBot(0, 64, 0, flat()) }, { x: 48, z: 0, distance: 48 }, { skills: hopSkills, pf });
    check(stops.length === Math.ceil(48 / HOP_MAX), `48 格被切成 ${stops.length} 段短跳（每段 ≤${HOP_MAX} 格）`);
    check(stops[stops.length - 1] === 48, `最后一段正好落在目标点（x=${stops[stops.length - 1]}）`);
    check(r6.ok && r6.moved === 48 && r6.hops === stops.length, `分段走完照样算成功：moved=${r6.moved} hops=${r6.hops}`);

    // 短距离不该被切碎
    const stops2 = [];
    const shortSkills = { async goToGoal(b, goal) { stops2.push(goal.x); b.entity.position = new Vec3(goal.x, 64, goal.z); return true; } };
    const r7 = await exploreTo({ bot: fakeBot(0, 64, 0, flat()) }, { x: 12, z: 0, distance: 12 }, { skills: shortSkills, pf });
    check(stops2.length === 1 && r7.ok, `12 格只走一段，不切碎（hops=${r7.hops}）`);

    // 中途某一段走不通 → 停下，如实报"只挪了 N 格"，不假装到过终点
    let n = 0;
    const halfSkills = {
        async goToGoal(b, goal) {
            if (++n > 1) throw new Error('Pathfinding stopped');
            b.entity.position = new Vec3(goal.x, 64, goal.z);
            return true;
        },
    };
    const r8 = await exploreTo({ bot: fakeBot(0, 64, 0, flat()) }, { x: 48, z: 0, distance: 48 }, { skills: halfSkills, pf });
    check(!r8.ok && r8.reason === 'path' && r8.moved > 0 && r8.moved < 48,
        `第 2 段走不通 → 停下并如实报位移 ${r8.moved} 格（done=${r8.done}/${r8.hops}）`);

    // 走不动：skills 直接抛
    const badSkills = { async goToGoal() { throw new Error('Pathfinding stopped'); } };
    const r2 = await exploreTo({ bot: fakeBot(0, 64, 0, flat()) }, { x: 40, z: 0, distance: 40 }, { skills: badSkills, pf });
    check(!r2.ok && r2.reason === 'path', `路被挡住 → reason=path（${r2.detail}）`);

    // 超时要能回来，不能永远挂着
    const hangSkills = { async goToGoal() { return new Promise(() => {}); } };
    const bot3 = fakeBot(0, 64, 0, flat());
    const r3 = await exploreTo({ bot: bot3 }, { x: 40, z: 0, distance: 40 }, { skills: hangSkills, pf, timeoutMs: 120 });
    check(!r3.ok && r3.reason === 'timeout', `走不完会超时返回（reason=${r3.reason}）`);

    // 玩家喊"停下"必须真的停
    const bot4 = fakeBot(0, 64, 0, flat());
    const stopSkills = { async goToGoal() { await new Promise((r) => setTimeout(r, 4000)); return true; } };
    setTimeout(() => { bot4.interrupt_code = true; }, 150);
    const r4 = await exploreTo({ bot: bot4 }, { x: 90, z: 0, distance: 90 }, { skills: stopSkills, pf, timeoutMs: 8000 });
    check(!r4.ok && r4.reason === 'interrupted' && bot4.pathfinder.stopped,
        '走路途中被叫停 → reason=interrupted 且真的调了 pathfinder.stop()');

    // 目标就是脚下 → 别假装走了一趟
    const r5 = await exploreTo({ bot: fakeBot(5, 64, 5, flat()) }, { x: 5, z: 5, distance: 0 }, { skills, pf });
    check(!r5.ok && r5.reason === 'no-target', '目标点就是脚下 → no-target，不当成功');
}

console.log('\n=== 4. 看见什么：只报"值得说的"，不报石头泥土 ===');
{
    const world = flat((x, y, z) => {
        if (y === 64 && x === 6 && z === 0) return block('oak_log');
        if (y === 63 && x === -3 && z === 2) return block('iron_ore');
        if (y === 64 && x === 1 && z === 1) return block('poppy');
        return null;
    });
    const bot = fakeBot(0, 64, 0, world);
    const s = scanAround(bot, 10, 4);
    const labels = s.found.map((f) => f.label);
    check(labels.includes('树'), `扫到树：${JSON.stringify(s.found.slice(0, 4))}`);
    check(labels.includes('铁矿'), '扫到铁矿');
    check(!labels.includes('石头'), '石头不算"发现"（否则每次汇报都是"看见了石头×3000"）');
    check(s.counts.stone > 0 && s.counts.air === undefined, '空气不进统计，石头进统计');

    // 读不到群系绝不能把整趟判成失败
    const noBiome = fakeBot(0, 64, 0, world);
    const s2 = scanAround(noBiome, 4, 2);
    check(s2.biome === null && Array.isArray(s2.found), '读不到生物群系 → biome=null，但结果照常返回');

    // 假 bot 不挑食的话，第 3 节那些 bug 就测不出来
    let threw = false;
    const picky = fakeBot(0, 64, 0, world);
    try { picky.blockAt({ x: 0, y: 64, z: 0 }); } catch (e) { threw = e instanceof TypeError; }
    check(threw, '回归：给 blockAt 传普通对象必须抛 pos.floored is not a function');
}

console.log('\n=== 5. 说人话：走完必须报出"走了多远、到了哪、看见了什么" ===');
{
    const before = { found: [{ label: '石头', n: 1 }], biome: null };
    const after = { found: [{ label: '树', n: 12 }, { label: '水', n: 4 }], biome: 'plains' };
    const trip = {
        ok: true, reason: '', headingLabel: '东',
        from: { x: 0, y: 64, z: 0 }, to: { x: 41, y: 66, z: -3 }, moved: 41,
    };
    const line = describeTrip(trip, before, after);
    check(line.includes('41 格'), `报出走了多远：${line}`);
    check(line.includes('(41, 66, -3)'), '报出到了哪');
    check(line.includes('plains'), '报出生物群系');
    check(line.includes('树'), '报出看见了什么');
    check(!line.includes('水'), '水不当成"发现"（脚边一条河不算探险收获）');

    const to = describeTrip({ ok: false, reason: 'timeout', from: trip.from, to: trip.to, moved: 20 }, before, { found: [], biome: null });
    check(to.includes('太远') || to.includes('没到'), `超时也要说清楚：${to}`);

    const stopped = describeTrip({ ok: false, reason: 'interrupted', from: trip.from, to: trip.to, moved: 8 }, before, { found: [], biome: null });
    check(stopped.includes('停'), `被叫停也要说清楚：${stopped}`);

    const nothing = describeTrip({ ok: true, reason: '', from: trip.from, to: trip.to, moved: 30 }, before, { found: [], biome: null });
    check(nothing.includes('没看见什么'), `真没看见就说没看见，不许编：${nothing}`);
}

console.log(`\n结果：${fail === 0 ? '✓ 全部通过' : '✗ ' + fail + ' 个问题'}（共 ${pass + fail} 项检查）`);
process.exit(fail === 0 ? 0 : 1);
