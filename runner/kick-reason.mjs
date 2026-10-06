// runner/kick-reason.mjs
// 把"服务器为什么把我们踢了"翻译成一句人话。
//
// ★ 为什么需要这个文件（用户 m11391 报的真事）：
//   用户看到的现象是"bot 受伤后立刻退出游戏、过一会儿又自己进来"，怀疑是门禁拦的。
//   查日志的结论是：**不是门禁**（门只决定一条聊天消息要不要送去大模型，它没有任何
//   断开连接的代码），而是服务器把 bot 踢了 → 引擎的 LoginGuard 收到断线就
//   `process.exit(1)` → 我们的应用按退避策略把它重新拉起来 → 看起来像"自己重进"。
//
//   真正的问题在于**原因被丢了**：引擎 vendor/mindcraft-develop/src/agent/connection_handler.js
//   的 parseKickReason() 用关键词表匹配原因，匹配不上就走 fallback：
//       fallback = obj.translate || obj.text || (obj.value?.translate) || raw
//   而 1.21.1 的 kick 原因是 protodef 解出来的嵌套结构
//       {type:'compound', value:{translate:{type:'string', value:'multiplayer.disconnect.xxx'}}}
//   —— `obj.value.translate` 是个**对象**，往模板字符串里一塞就成了 `[object Object]`。
//   于是引擎日志里只有 `[LoginGuard] Disconnected: [object Object]`，
//   面板上也说不出原因。这个模块把那串结构拆平，并按官方的 translate key 给中文说法。
//
// 原则（与 self-report / engine-speak 一致）：**认不出就如实说认不出，绝不编原因**。

/**
 * 官方（vanilla）的踢人原因 key → 中文说法。
 * 只收真见过的、语义明确的；不确定的一律不收 —— 认不出时下面的 describeKick()
 * 会把 key 原样摆出来，那也比编一句"服务器觉得你在作弊"诚实。
 */
export const KICK_REASONS = {
    'multiplayer.disconnect.invalid_player_movement': '服务器认为我们的位置数据不对（被击退、掉下去的那一瞬间最容易触发）',
    'multiplayer.disconnect.duplicate_login': '这个名字已经在服务器上了（同一个名字登了两次）',
    'multiplayer.disconnect.kicked': '被服务器管理员踢出去了',
    'multiplayer.disconnect.flying': '服务器认为我们在飞（不允许飞行）',
    'multiplayer.disconnect.spam': '发消息太快，被当成刷屏',
    'multiplayer.disconnect.idling': '挂机太久',
    'multiplayer.disconnect.timeout': '太久没有向服务器回应（网卡了）',
    'disconnect.timeout': '太久没有向服务器回应（网卡了）',
    'multiplayer.disconnect.server_shutdown': '服务器关闭了',
    'multiplayer.disconnect.server_full': '服务器满了',
    'multiplayer.disconnect.not_whitelisted': '我们不在这个服务器的白名单里',
    'multiplayer.disconnect.banned': '这个号/IP 被服务器封了',
    'multiplayer.disconnect.illegal_characters': '名字里有服务器不接受的字符',
    'multiplayer.disconnect.chat_validation_failed': '聊天内容没通过服务器校验',
    'multiplayer.disconnect.generic': '服务器没有给出具体原因',
};

/** 字符串可能是 JSON 也可能就是一句人话。 */
function parseMaybeJson(value) {
    if (typeof value !== 'string') return value;
    const s = value.trim();
    if (!s) return s;
    const looksJson = (s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'));
    const looksQuoted = s.startsWith('"') && s.endsWith('"') && s.length > 1;
    if (!looksJson && !looksQuoted) return s;
    try { return JSON.parse(s); } catch { return s; }
}

/**
 * 从 `translate` 字段里抠出官方的 key。
 * ★ 这里必须专门处理：真实的 kick 原因是
 *     {type:'compound', value:{translate:{type:'string', value:'multiplayer.disconnect.xxx'}}}
 *   —— `translate` 的值是 **protodef 节点**（不是字符串）。第一版把它当成普通文字节点
 *   走 literal 分支，于是 key 提取不到、中文说法也用不上，整条链白写
 *   （tools\test-kick-reason.mjs 当场抓到 9 条红）。
 *   注意只对 `translate` 字段这么解；别处的 {type:'string'} 仍是文字。
 */
function keyOfTranslateField(node) {
    const v = parseMaybeJson(node);
    if (typeof v === 'string') return v || null;
    if (v && typeof v === 'object') {
        if (typeof v.value === 'string' && (v.type === 'string' || v.type === 'translate')) return v.value || null;
        if (typeof v.value === 'string' && v.type === undefined) return v.value || null;
    }
    return null;
}

/**
 * 把 mineflayer 给过来的 reason（字符串 / protodef 解出的嵌套对象 / 数组）拆成
 * `{ translate, args, literal }`：
 *   · translate —— 官方的 key（如 multiplayer.disconnect.invalid_player_movement）
 *   · args      —— translate 的占位参数（`with` 里的东西）
 *   · literal   —— 服务器直接给的原文（英文），认不出 key 时至少能把它摆出来
 * 注意：`{type:'string', value:'x'}` 这种 protodef 节点要按 literal 处理，
 * 否则那串结构会被整个丢掉（旧的 fallback 就是栽在这里）。
 */
export function flattenChat(value, depth = 0) {
    const out = { translate: null, args: [], literal: '' };
    if (value === null || value === undefined || depth > 6) return out;
    const v = parseMaybeJson(value);

    if (typeof v === 'string') { out.literal = v; return out; }
    if (typeof v === 'number' || typeof v === 'boolean') { out.literal = String(v); return out; }

    if (Array.isArray(v)) {
        for (const item of v) {
            const sub = flattenChat(item, depth + 1);
            if (!out.translate && sub.translate) out.translate = sub.translate;
            if (!out.args.length && sub.args.length) out.args = sub.args;
            out.literal += sub.literal;
        }
        return out;
    }

    // protodef 解出来的节点：{type:'compound'|'translate'|'string', value:...}
    if (v.type === 'compound' && 'value' in v) {
        const sub = flattenChat(v.value, depth + 1);
        if (sub.translate) out.translate = sub.translate;
        return { translate: sub.translate, args: sub.args, literal: sub.literal };
    }
    if (v.type === 'translate' && typeof v.value === 'string') { out.translate = v.value; }
    if (v.type === 'string' && typeof v.value === 'string') { out.literal = v.value; }

    if (typeof v.translate === 'string') out.translate = v.translate;
    else if (v.translate !== undefined && v.translate !== null) {
        const key = keyOfTranslateField(v.translate);
        if (key) out.translate = key;
        else {
            const sub = flattenChat(v.translate, depth + 1);
            if (sub.translate) out.translate = sub.translate;
            else out.literal += sub.literal;
        }
    }
    if (Array.isArray(v.with)) {
        out.args = v.with.map((a) => {
            const f = flattenChat(a, depth + 1);
            return f.literal || f.translate || '';
        }).filter(Boolean);
    }
    if (typeof v.text === 'string') out.literal += v.text;
    if (Array.isArray(v.extra)) {
        for (const e of v.extra) out.literal += flattenChat(e, depth + 1).literal;
    }
    return out;
}

/** 稳定的原文副本，用于日志与排查（认不出原因时全靠它）。 */
export function rawOf(reason) {
    if (typeof reason === 'string') return reason;
    try { return JSON.stringify(reason ?? null) ?? String(reason); } catch { return String(reason); }
}

/**
 * @returns {{raw:string,key:string|null,args:string[],literal:string,cn:string|null,known:boolean}}
 */
export function decodeKick(reason) {
    const raw = rawOf(reason);
    const { translate, args, literal } = flattenChat(reason);
    const cn = translate ? (KICK_REASONS[translate] || null) : null;
    return { raw, key: translate, args, literal, cn, known: !!cn };
}

/**
 * 给界面 / 日志用的一句话。**永远不返回空、永远不返回 `[object Object]`。**
 */
export function describeKick(reason) {
    const { raw, key, args, literal, cn } = decodeKick(reason);
    if (cn) return args.length ? `${cn}（${args.join(' ')}）` : cn;
    if (key) return `服务器给的原始原因：${key}`;
    const lit = String(literal || '').trim();
    if (lit) return `服务器说：${lit}`;
    if (raw && raw !== 'null' && raw.trim()) return `服务器断开连接，但没有说原因（原始内容：${raw.slice(0, 120)}）`;
    return '和服务器断开了，服务器没有说原因';
}
