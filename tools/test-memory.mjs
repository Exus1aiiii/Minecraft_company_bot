/**
 * tools/test-memory.mjs —— 长期记忆的单元测试
 *
 * 这一层最容易出的错不是崩溃，而是**记忆变成噪音**：
 * 什么闲聊都往里塞、同义句存成十条、"你都记得什么"把八十条全倒出来。
 * 所以测试的重点是"不记什么"和"记得准不准"。
 *
 * 用法：node tools\test-memory.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import {
    emptyMemory, remember, forget, recall, digest, tokens,
    parseRememberIntent, parseRecallIntent, extractFacts,
    Memory, loadMemory, saveMemory, memoryFileFor,
    MAX_ENTRIES, DIGEST_MAX,
} from '../runner/memory.mjs';

let pass = 0, fail = 0;
function check(cond, label) {
    if (cond) { pass++; console.log('  ✓ ' + label); }
    else { fail++; console.log('  ✗ ' + label); }
}

console.log('=== 1. 记住与忘掉 ===');
{
    const m = emptyMemory();
    const a = remember(m, { text: '我喜欢钻石' });
    check(a.ok && m.entries.length === 1, '记下第一条');

    const again = remember(m, { text: '我喜欢钻石。' });
    check(again.ok && again.dup === true && m.entries.length === 1,
        '同一个意思再说一遍 → 更新而不是新增（否则"我喜欢钻石"说三遍就是三条记忆）');

    const short = remember(m, { text: '嗯' });
    check(!short.ok && short.reason === 'too-short', '太短的（"嗯"）不记');

    remember(m, { text: '我家在 (-12, 64, 30)', kind: 'place' });
    remember(m, { text: '答应 Steve 明天去挖矿', kind: 'promise' });
    check(m.entries.length === 3, `三种都记下了（${m.entries.length} 条）`);

    const n = forget(m, '我家在 (-12, 64, 30)');
    check(n === 1 && m.entries.length === 2, '按内容忘掉一条');
    check(forget(m, 'all') === 2 && m.entries.length === 0, '忘掉全部');
}

console.log('\n=== 2. 满了丢最旧的，但"约定"优先留 ===');
{
    const m = emptyMemory();
    remember(m, { text: '答应 Steve 明天去挖矿', kind: 'promise', ts: 1 });
    for (let i = 0; i < MAX_ENTRIES + 20; i++) {
        remember(m, { text: `第 ${i} 条闲聊记录`, kind: 'fact', ts: 1000 + i });
    }
    check(m.entries.length === MAX_ENTRIES, `条数被压在 ${MAX_ENTRIES}（实际 ${m.entries.length}）`);
    check(m.entries.some((e) => e.kind === 'promise'),
        '欠人的约定不会被挤掉（它优先级最高）');
    check(!m.entries.some((e) => e.text === '第 0 条闲聊记录'),
        '最旧的闲聊被丢掉了');
}

console.log('\n=== 3. 检索：中文没有空格，靠二元组 ===');
{
    const m = emptyMemory();
    remember(m, { text: '我家在 (-12, 64, 30)', kind: 'place', ts: 100 });
    remember(m, { text: 'Steve 喜欢下矿洞', ts: 200 });
    remember(m, { text: '我讨厌苦力怕', ts: 300 });

    const r1 = recall(m, '我家在哪', 3);
    check(r1.length > 0 && r1[0].text.includes('我家在'), `"我家在哪" 命中地点（${r1[0]?.text}）`);

    const r2 = recall(m, '苦力怕', 3);
    check(r2.length === 1 && r2[0].text.includes('苦力怕'), '"苦力怕" 只命中那一条');

    const r3 = recall(m, '', 2);
    check(r3.length === 2 && r3[0].ts === 300, '没给关键词 → 给最近的几条（"你都记得什么"）');

    const r4 = recall(m, '完全不相干的一句话', 3);
    check(r4.length === 0, '不相干的 → 一条都不给（宁可说不记得，也别乱答）');

    // 通用词不该把什么都匹配上
    const common = recall(m, '这是什么', 5);
    check(common.length === 0, `"这是什么" 不匹配任何条目（实际 ${common.length} 条）`);
}

console.log('\n=== 4. 摘要：这是花钱的地方，必须有上限 ===');
{
    const m = emptyMemory();
    remember(m, { text: '答应 Steve 明天去挖矿', kind: 'promise', from: 'Steve' });
    remember(m, { text: '我家在 (-12, 64, 30)', kind: 'place' });
    remember(m, { text: 'Steve 说过：我喜欢钻石', from: 'Steve' });

    const d = digest(m.entries);
    check(d.includes('[约定]'), '约定有标记');
    check(d.includes('[地点]'), '地点有标记');
    check(d.split('\n').length === 3, `三条各一行（${d.split('\n').length} 行）`);
    check(!d.includes('Steve 说过：Steve'), '不重复写说话人');

    const many = emptyMemory();
    for (let i = 0; i < 60; i++) remember(many, { text: `这是第 ${i} 条很长的记忆内容用来把摘要撑爆`, ts: i });
    const big = digest(many.entries);
    check(big.length <= DIGEST_MAX + 40, `长摘要被截断（${big.length} 字符，上限 ${DIGEST_MAX}）`);
    check(big.includes('还有更多'), '截断了就明说还有更多，不假装这就是全部');
}

console.log('\n=== 5. 从中文里认出"要记住 / 在问记忆" ===');
{
    const yes = [
        ['记住我喜欢钻石', '我喜欢钻石'],
        ['记一下 我家在 (-12, 64, 30)', '我家在 (-12, 64, 30)'],
        ['记下来：Steve 怕苦力怕', 'Steve 怕苦力怕'],
        ['别忘了明天要挖矿', '明天要挖矿'],
        ['帮我记住我的床在楼上', '我的床在楼上'],
    ];
    for (const [input, want] of yes) {
        const r = parseRememberIntent(input);
        check(r && r.text === want, `「${input}」→ 记「${want}」（实得 ${JSON.stringify(r?.text)}）`);
    }

    const no = ['记住了吗', '记住', '你还记得我吗', '今天天气不错', '帮我砍点木头'];
    for (const input of no) {
        check(parseRememberIntent(input) === null, `「${input}」不该被当成"要记住"`);
    }

    const q1 = parseRecallIntent('你还记得我家在哪吗');
    check(q1 && q1.query === '我家在哪', `「你还记得我家在哪吗」→ 查「我家在哪」（实得 ${JSON.stringify(q1?.query)}）`);
    const q2 = parseRecallIntent('你记得什么');
    check(q2 && q2.query === '', '"你记得什么" → 空查询（那就把最近几件说出来）');
    check(parseRecallIntent('我说过什么')?.query === '', '"我说过什么" 也算问记忆');
    check(parseRecallIntent('记住我喜欢钻石') === null, '"记住…" 不能被当成"在问记忆"');
    check(parseRecallIntent('今天天气不错') === null, '闲聊不是问记忆');
}

console.log('\n=== 6. 自动捞取：只认很明确的长期信息 ===');
{
    const yes = [
        '我家在 (-12, 64, 30)',
        '我喜欢钻石矿',
        '以后别在晚上出门',
        '明天一起去挖矿吧',
        '我一般晚上八点上线',
    ];
    for (const s of yes) {
        check(extractFacts('Steve', s).length === 1, `自动记住「${s}」`);
    }
    const no = [
        '今天天气不错',
        '小豆你在吗',
        '哈哈哈',
        '这个僵尸好烦',
        '救命我被打了',
    ];
    for (const s of no) {
        check(extractFacts('Steve', s).length === 0, `不记闲聊「${s}」`);
    }
    check(extractFacts('Steve', '我家在' + '很长'.repeat(50)).length === 0, '过长的句子不自动记（八成不是一句能记的话）');

    // —— 一句里说两件事：必须切成两条，不能揉成一句囫囵话 ——
    // 真机实测原样复现：Steve 说「我家在 (-12, 64, 30)，以后别在晚上出门」，
    // 切句之前存成了一条「我家在 -12 64 30 以后别在晚上出门」，读回来莫名其妙。
    const two = extractFacts('Steve', '我家在 (-12, 64, 30)，以后别在晚上出门');
    check(two.length === 2, `一句两件事切成两条（得到 ${two.length} 条）`);
    check(two[0]?.text.includes('-12') && !two[0]?.text.includes('晚上'), '第一条只讲家在哪');
    check(two[1]?.text.includes('晚上') && !two[1]?.text.includes('-12'), '第二条只讲晚上别出门');

    // —— 一条消息最多记两句：说到第五件事也只取前两条，别把一段话拆成一堆 ——
    const many = extractFacts('Steve', '我喜欢钻石，我喜欢苹果，我喜欢木头，我喜欢石头，我喜欢泥土');
    check(many.length === 2, `一条消息最多记两句（得到 ${many.length} 条）`);

    // —— 两个分句说的是同一件事：去重后只留一条 ——
    const same = extractFacts('Steve', '我喜欢钻石，我喜欢钻石');
    check(same.length === 1, `同一句重复两遍只记一条（得到 ${same.length} 条）`);

    // —— 切句用的是中文标点，别把逗号当句子内部的东西漏掉 ——
    check(extractFacts('Steve', '我家在雪原；我喜欢下矿洞').length === 2, '分号也能切句');
    check(extractFacts('Steve', '明天一起去挖矿吧！我喜欢钻石').length === 2, '感叹号也能切句');

    // —— 🔴 坐标里的逗号不是切句符：真机实测把它剁成了「我家在 -12」，y 和 z 全丢了 ——
    const near = extractFacts('Steve', '我的家在 (-12, 64, 30)');
    check(near.length === 1, `坐标句只记一条（得到 ${near.length} 条）`);
    check(/-12\s+64\s+30/.test(near[0]?.text ?? ''), `坐标三个数一个都不能少：「${near[0]?.text}」`);
    check(near[0]?.kind === 'place', `带坐标的算"地点"而不是"事实"（kind=${near[0]?.kind}）`);
    check(extractFacts('Steve', '我的家在（-12，64，30）')[0]?.kind === 'place', '全角括号和全角逗号也认');
    check(extractFacts('Steve', '我的家在 (-12, 64)')[0]?.kind === 'fact', '只有两个数字不算坐标，当普通事实记');
    check(extractFacts('Steve', '我的家在 (-12, 64, 30)，以后别在晚上出门').length === 2, '坐标和下一件事一起说时仍切成两条');
}

console.log('\n=== 7. 落盘：重启不丢，坏文件不炸 ===');
{
    const dir = path.join(process.cwd(), 'runtime', 'tmp', `memtest-${process.pid}`);
    fs.rmSync(dir, { recursive: true, force: true });
    const file = path.join(dir, 'nested', 'bot-x.json');

    const mem = new Memory(file);
    check(mem.size === 0, '文件不存在 → 空记忆，不报错');
    mem.remember({ text: '我喜欢钻石', from: 'Steve' });
    mem.remember({ text: '答应 Steve 明天去挖矿', kind: 'promise' });
    check(mem.size === 2, `记了两条（${mem.size}）`);

    const again = new Memory(file);
    check(again.size === 2, '重新打开还在（重启不丢）');
    check(again.recall('钻石', 2)[0]?.text === '我喜欢钻石', '重新打开后检索照常');

    fs.writeFileSync(file, '{ 这不是 JSON', 'utf8');
    check(new Memory(file).size === 0, '文件坏了 → 退回空记忆，不抛异常');

    check(memoryFileFor('bot-x', dir).endsWith('bot-x.json'), 'memoryFileFor 用显式目录');
    const evil = memoryFileFor('../../etc/passwd', dir);
    check(path.dirname(evil) === dir && !evil.includes('..'),
        `memoryFileFor 洗掉路径分隔符，防止越界写文件（${path.basename(evil)}）`);

    check(saveMemory(file, emptyMemory()) === true, 'saveMemory 能重建被写坏的文件');
    check(loadMemory(file).entries.length === 0, '重建后读得回来');

    fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n结果：${fail === 0 ? '✓ 全部通过' : '✗ 有失败'}（共 ${pass + fail} 项检查）`);
process.exit(fail === 0 ? 0 : 1);
