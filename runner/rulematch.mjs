/**
 * runner/rulematch.mjs —— 话头匹配。
 *
 * 这是整个"零 token 通路"的入口：一句话先在这里过一遍，命中了就直接发引擎命令，
 * 一个字都不发给大模型。所以它**判错一次就要么白花钱、要么做错事**，
 * 值得单独拿出来测。
 *
 * ★ 为什么不能只写 `text.includes(p)`：
 *   中文会在动词和宾语之间塞字 ——
 *     「报坐标」 → 「报**一下**坐标」
 *     「看背包」 → 「看**下**背包」
 *     「盖房子」 → 「盖**一座大**房子」
 *   一塞字，包含匹配就落空，然后**悄悄退回大模型**：用户白花几千 token、
 *   多等两秒，而界面上那条规则明明开着。这种"看起来配好了其实没生效"
 *   是最难查的一类 bug —— 它不报错，只是安静地变贵。
 *
 * ★ 所以话头里可以写 `*`，表示"这里允许塞最多 MAX_FILLER 个字"：
 *     `报*坐标`  覆盖  报坐标 / 报一下坐标 / 报个坐标 / 报一下我的坐标
 *
 * ★ 三条边界，故意划得很紧：
 *   1. `*` 两边的字必须**按顺序**出现，不会退化成"只要都出现过就算"。
 *      （`报*坐标` 不会匹配「坐标报一下」）
 *   2. 一段最多塞 MAX_FILLER 个字。塞太多就不是同一句话了 ——
 *      「砍*树」不应该匹配「砍完这棵树我们去吃饭吧」。
 *   3. 不带 `*` 的话头走原来的 `includes`，行为**一个字都没变**。
 *      想精确匹配就照旧写死。
 *
 * ★ `*` 是正则里的量词，所以拼正则前必须先转义两边的字面量 ——
 *   否则玩家自己写的话头里一个 `(` 就能让整个匹配炸掉。
 */

/** `*` 处最多允许塞几个字。调大 = 更宽容也更容易误触发。 */
export const MAX_FILLER = 4;

const RE_SPECIAL = /[.*+?^${}()|[\]\\]/g;

/** 单个话头是否命中。`*` 是通配，其余字符按字面处理。 */
export function patternHits(text, pattern) {
    if (!pattern || typeof text !== 'string') return false;
    if (text.includes(pattern)) return true;
    if (!pattern.includes('*')) return false;
    const body = pattern
        .split('*')
        .map((s) => s.replace(RE_SPECIAL, '\\$&'))
        .join(`.{0,${MAX_FILLER}}`);
    return new RegExp(body, 'i').test(text);
}

/**
 * 按顺序找第一条命中的规则。**先匹配到的赢** ——
 * 所以规则表里靠前的规则会遮住靠后的，加规则时要留意顺序。
 */
export function matchRule(rules, text) {
    for (const r of rules || []) {
        if (!r || r.enabled === false) continue;
        for (const p of r.patterns || []) {
            if (patternHits(text, p)) return r;
        }
    }
    return null;
}

/** 找出文本里所有命中的规则（用来排查"到底哪条抢到了"）。 */
export function explainMatch(rules, text) {
    const hits = [];
    for (const r of rules || []) {
        if (!r || r.enabled === false) continue;
        for (const p of r.patterns || []) {
            if (patternHits(text, p)) hits.push({ id: r.id, pattern: p, wildcard: p.includes('*') });
        }
    }
    return hits;
}
