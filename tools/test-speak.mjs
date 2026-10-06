/**
 * 引擎回执翻译（`runner/engine-speak.mjs`）单元测试。
 *
 * 这个模块的测试有个特别之处：**被测的不是我们的逻辑，是我们抄得对不对**。
 * `RULES` 里每条正则都是照着 `skills.js` 里真实存在的 `log(bot, ...)` 抄的，
 * 抄错一个空格，真机上就是一句英文原样发给玩家 —— 而单测如果也是照着
 * 同一份记忆写的，就会"自证正确"。所以第 1 节的输入**全部是从引擎源码里复制出来的
 * 原字符串**（含真实变量填进去后的样子），第 2 节再反过来校验
 * "我们声称覆盖的那些模板，在 `skills.js` 里确实存在"。
 *
 * 用法：node tools\test-speak.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { translateEngineReply, nameOf } from '../runner/engine-speak.mjs';
import { BLOCK_WORDS } from '../runner/vocab.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SKILLS = path.join(ROOT, 'vendor', 'mindcraft-develop', 'src', 'agent', 'library', 'skills.js');

let pass = 0; const fails = [];
const ok = (cond, label, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fails.push(label); console.log(`  ✗ ${label}${extra ? '  → ' + extra : ''}`); } };
const eq = (a, b, label) => ok(JSON.stringify(a) === JSON.stringify(b), label, `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
const has = (text, needle, label) => ok(String(text).includes(needle), label, `「${text}」里没有「${needle}」`);
const notEn = (text, label) => ok(!/[A-Za-z]{3,}\s+[A-Za-z]{3,}/.test(String(text)), label, `还留着英文：${text}`);
const sec = (t) => console.log(`\n=== ${t} ===`);

// ═════════════════════════════════════════════ 1. 真机原句
sec('1. 真实回执（含真机实测抓到的那一条）');
{
    // ★ 这一条是 2026-xx-xx 真机跑「小豆 挖点铁矿石」时，聊天框里发出来的原文
    const live = 'Action output:\nFailed to collect iron_ore: Timeout: Took to long to decide path to goal!.\nCollected 11 iron_ore.';
    const zh = translateEngineReply(live);
    has(zh, nameOf('iron_ore'), '真机原句：方块名用的就是词典里那个叫法');
    has(zh, '11', '真机原句：挖到的数量一个不改');
    ok(!zh.includes('iron_ore'), '真机原句：不再出现 iron_ore');
    ok(!zh.includes('Action output'), '真机原句：前缀去掉了');
    notEn(zh, '真机原句：整句不再是英文');

    // 引擎逐行累加，多行是常态
    const multi = 'Action output:\nFound iron_ore at (-4, 108, 2). Navigating...\nPathfinding stopped: Cannot break stone with current tools.';
    const zh2 = translateEngineReply(multi);
    has(zh2, `找到${nameOf('iron_ore')}了`, '多行：第一行翻了');
    has(zh2, '-4, 108, 2', '多行：坐标照抄');
    has(zh2, '石头', '多行：第二行的方块名翻了');
    has(zh2, '挖不动', '多行：说清了为什么停下');
}

// ═════════════════════════════════════════════ 2. 覆盖的模板在引擎里真的存在
sec('2. 我们翻译的每条，引擎里都有对应的 log()');
{
    const src = fs.readFileSync(SKILLS, 'utf8');
    // 逐条把模板还原成引擎里的样子（把 ${x} 换成通配），检验模板确实存在
    const templates = [
        // 注意：真机看到的那句 `Failed to collect iron_ore: Timeout: Took to long to
        // decide path to goal!.` 在源码里是**两条** log 拼起来的 ——
        // `Failed to collect ${blockType}: ${err}.` + 那句 err 自带的话。
        // 所以这里只能列源码里真实存在的那一条。
        'Failed to collect ${blockType}: ${err}.',
        'Failed to collect ${blockType}: Inventory full, no place to deposit.',
        'Failed to collect ${blockType}: ${err}.',
        'Collected ${collected} ${blockType}.',
        'No more ${blockType} nearby to collect.',
        'No ${blockType} nearby to collect.',
        "Don't have right tools to harvest ${blockType}.",
        "Don't have right tools to break ${block.name}.",
        "Don't have bucket to harvest ${blockType}.",
        'Invalid number of blocks to collect: ${num}.',
        'Picked up ${pickedUp} items.',
        'Found ${blockType} at ${block.position}. Navigating...',
        'Could not find any ${blockType} in ${range} blocks.',
        'Found ${entityType} ${distance} blocks away.',
        'Pathfinding stopped: Cannot break ${targetBlock.name} with current tools.',
        'You have reached at ${x}, ${y}, ${z}.',
        'Unable to reach ${x}, ${y}, ${z}, you are ${Math.round(distance)} blocks away.',
        'You have reached ${username}.',
        'You are already at ${username}.',
        'Moved away from ${pos.floored()} to ${new_pos.floored()}.',
        'Moved ${distance} away from enemies.',
        'You are now actively following player ${username}.',
        'Successfully crafted ${itemName}, you now have ${world.getInventoryCounts(bot)[itemName]} ${itemName}.',
        'Not enough ${craftLimit.limitingResource} to craft ${num}, crafted ${craftLimit.num}. You now have ${world.getInventoryCounts(bot)[itemName]} ${itemName}.',
        'Crafting ${itemName} requires a crafting table.',
        'You do not have the resources to craft a ${itemName}. It requires:',
        '${itemName} is either not an item, or it does not have a crafting recipe!',
        'Successfully smelted ${itemName}, got ${total} ${mc.getItemName(smelted_item.type)}.',
        'Only smelted ${total} ${mc.getItemName(smelted_item.type)}.',
        'Failed to smelt ${itemName}.',
        "Cannot smelt ${itemName}. Hint: make sure you are smelting the 'raw' item.",
        'There is no furnace nearby and you have no furnace.',
        'You have no fuel to smelt ${itemName}, you need coal, charcoal, or wood.',
        'Using ${fuel.name} as fuel.',
        'Added ${put_fuel} ${mc.getItemName(fuel.type)} to furnace fuel.',
        'You do not have enough ${itemName} to smelt.',
        'You do not have any ${itemName} to equip.',
        'Equipped ${itemName}.',
        'Could not equip ${toolName}.',
        'Unequipped hand.',
        'Successfully killed ${entity.name}.',
        'Successfully defended self.',
        'No enemies nearby to defend self from.',
        'Placed ${blockType} at ${target_dest}.',
        'Failed to place ${blockType} at ${target_dest}.',
        "Don't have any ${item_name} to place.",
        'Could not find a chest nearby.',
        'Successfully put ${to_put} ${itemName} in the chest.',
        'Successfully took ${totalTaken} ${itemName} from the chest.',
        'The chest is empty.',
        'You do not have any ${name} to eat.',
        'Consumed ${item.name}.',
        'Going to the surface at y=${y+1}.',
        'Dug down ${distance} blocks.',
    ];
    let missing = 0;
    for (const t of templates) {
        if (!src.includes(t)) { missing++; console.log(`  ! 引擎里找不到这个模板：${t}`); }
    }
    eq(missing, 0, `${templates.length} 条模板全部在 skills.js 里对得上`);
}

// ═════════════════════════════════════════════ 3. 逐条翻译
sec('3. 逐条翻译');
{
    const cases = [
        ['Collected 3 oak_log.', ['挖到了 3 个', '橡木']],
        ['No iron_ore nearby to collect.', ['附近没有', nameOf('iron_ore')]],
        ['No more coal_ore nearby to collect.', ['都挖完了']],
        ["Don't have right tools to harvest diamond_ore.", ['没有能挖', nameOf('diamond_ore'), '工具']],
        ['Invalid number of blocks to collect: -5.', ['这个数量我挖不了']],
        ['Picked up 7 items.', ['7']],
        ['Found coal_ore at (-4, 108, 2). Navigating...', ['找到', nameOf('coal_ore'), '(-4, 108, 2)', '过去']],
        ['Could not find any iron_ore in 64 blocks.', ['64', nameOf('iron_ore')]],
        ['Pathfinding stopped: Cannot break stone with current tools.', ['石头', '挖不动']],
        ['You have reached at 10, 64, 30.', ['10, 64, 30']],
        ['You are now actively following player Steve.', ['Steve']],
        ['Moved 30 away from enemies.', ['30']],
        ['Successfully crafted wooden_pickaxe, you now have 1 wooden_pickaxe.', ['木镐', '1 个']],
        ['Not enough oak_planks to craft 2, crafted 1. You now have 1 wooden_pickaxe.', [nameOf('oak_planks'), '1 个木镐']],
        ['Crafting stone_pickaxe requires a crafting table.', ['石镐', '工作台']],
        ['You do not have the resources to craft a iron_pickaxe. It requires: iron_ingot: 3, stick: 2.', ['铁镐', '材料不够']],
        ['Successfully smelted raw_iron, got 3 iron_ingot.', ['烧好了', '3 个', '铁锭']],
        ['Only smelted 1 iron_ingot.', ['只烧出来 1 个']],
        ["Cannot smelt iron_ore. Hint: make sure you are smelting the 'raw' item.", ['原']],
        ['There is no furnace nearby and you have no furnace.', ['熔炉']],
        ['You have no fuel to smelt raw_iron, you need coal, charcoal, or wood.', ['燃料']],
        ['Using coal as fuel.', ['煤炭']],
        ['Equipped stone_pickaxe.', ['石镐']],
        ['You do not have any wooden_pickaxe to equip.', ['没有', '木镐']],
        ['No enemies nearby to defend self from.', ['附近没有敌人']],
        ['Going to the surface at y=63.', ['y=63']],
    ];
    for (const [en, needles] of cases) {
        const zh = translateEngineReply(en);
        const bad = needles.filter((n) => !zh.includes(n));
        ok(bad.length === 0, `${en.slice(0, 52)}${en.length > 52 ? '…' : ''}`, bad.length ? `「${zh}」缺 ${JSON.stringify(bad)}` : '');
    }
}

// ═════════════════════════════════════════════ 4. 认不出绝不能编
sec('4. 认不出的原样返回，绝不编');
{
    const unknown = [
        'Something exploded in a way we never planned for.',
        'Segmentation fault (core dumped)',
        'Random english sentence about nothing.',
    ];
    for (const s of unknown) {
        eq(translateEngineReply(s), s, `认不出的原样带出去：${s.slice(0, 34)}…`);
    }
    // 认不出 + 认得出混在一起，各归各的
    const mix = 'Something weird happened.\nCollected 2 stone.';
    const zh = translateEngineReply(mix);
    has(zh, 'Something weird happened.', '混排：认不出的那句保留原文');
    has(zh, '挖到了 2 个石头', '混排：认得出的那句翻掉');
    // 空输入不能炸
    eq(translateEngineReply(''), '', '空字符串返回空');
    eq(translateEngineReply(null), '', 'null 返回空');
    eq(translateEngineReply('Action output:'), '', '只有前缀也返回空');
}

// ═════════════════════════════════════════════ 5. 数字一个不改
sec('5. 数字一个不改');
{
    const nums = ['Collected 0 stone.', 'Collected 999 diamond_ore.', 'Could not find any gold_ore in 512 blocks.'];
    const want = ['0', '999', '512'];
    nums.forEach((en, i) => has(translateEngineReply(en), want[i], `数字 ${want[i]} 原样保留`));
    has(translateEngineReply('Unable to reach 1, 2, 3, you are 17 blocks away.'), '17', '距离 17 原样保留');
    has(translateEngineReply('Moved away from (0, 0, 0) to (-32, 116, -11).'), '-32, 116, -11', '负坐标原样保留');
}

// ═════════════════════════════════════════════ 6. nameOf
sec('6. 名字表');
{
    eq(nameOf('wooden_pickaxe'), '木镐', '合成品名走配方表的 label');
    eq(nameOf('iron_ingot'), '铁锭', '烧炼产物走 SMELT_FROM 的 label');
    eq(nameOf('oak_log'), '橡木', '词典里没有的走 EXTRA_CN');
    eq(nameOf('deepslate_iron_ore'), `深板岩${nameOf('iron_ore')}`, '深板岩变种 = 深板岩 + 内层名字');
    eq(nameOf('birch_planks'), '白桦木板', '木制品家族：白桦木板（不是 "birch 木板"）');
    // 词典/EXTRA_CN 里已经写好的名字优先 —— 它们和玩家说的词是一套
    eq(nameOf('spruce_log'), '云杉', '词典里有的按词典说法（不是"云杉原木"）');
    eq(nameOf('bamboo_planks'), '竹子木板', '词典里没有的才走家族规则');
    eq(nameOf('some_modded_thing'), 'some_modded_thing', '完全不认识的 id 原样返回');
    eq(nameOf(''), '', '空 id 返回空');

    // ★ 真正该守的不变式：**翻译时用的名字，就是玩家自己说那个词时我们认的名字**。
    // 两张表各写各的，迟早会出现"玩家说挖煤、bot 回 coal_ore"这种事。
    const mismatched = [];
    for (const entry of BLOCK_WORDS) {
        if (nameOf(entry.block) !== entry.label) {
            mismatched.push(`${entry.block}: 词典=${entry.label} 翻译=${nameOf(entry.block)}`);
        }
    }
    eq(mismatched, [], `词典里 ${BLOCK_WORDS.length} 条方块名，翻译层和意图层说法完全一致`);

    // 常见方块一个都不许退化成裸英文 id
    const bare = [];
    for (const id of ['stone', 'cobblestone', 'iron_ore', 'coal_ore', 'diamond_ore',
        'sand', 'dirt', 'oak_log', 'oak_planks', 'crafting_table', 'furnace', 'iron_ingot']) {
        if (nameOf(id) === id) bare.push(id);
    }
    eq(bare, [], '常见方块/物品不会退化成裸英文 id');
}

// ═════════════════════════════════════════════ 7. 杂项
sec('7. 杂项');
{
    // 同样的句子连着两遍只说一遍（引擎有时会重复 log）
    const dup = 'Collected 1 stone.\nCollected 1 stone.';
    eq(translateEngineReply(dup), '挖到了 1 个石头。', '重复的句子只说一遍');
    // 两件不同的事都要说出来
    const two = 'Collected 1 stone.\nCollected 2 oak_log.';
    const zh = translateEngineReply(two);
    has(zh, '石头', '两件事：第一件');
    has(zh, '橡木', '两件事：第二件');
    // 首尾空行、多余空格
    eq(translateEngineReply('\n\n  Collected 4 sand.  \n\n'), '挖到了 4 个沙子。', '首尾空行和多余空格被清掉');
    // 大小写不敏感（引擎有的地方首字母大写不一致）
    eq(translateEngineReply('collected 4 sand.'), '挖到了 4 个沙子。', '大小写不敏感');
    // 没有句号的也认（引擎偶尔漏掉句号）
    has(translateEngineReply('Collected 4 sand'), '4 个沙子', '末尾缺句号也认');
}

// ───────────────────────────────────────────── 结果
console.log(`\n${'─'.repeat(60)}`);
if (fails.length === 0) {
    console.log(`✓ 全部通过（共 ${pass} 项检查）`);
    process.exit(0);
} else {
    console.log(`✗ ${fails.length} 项失败（共 ${pass + fails.length} 项）：`);
    for (const f of fails) console.log(`   - ${f}`);
    process.exit(1);
}
