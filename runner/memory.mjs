// ============================================================================
// runner/memory.mjs —— 长期陪伴记忆
//
// 引擎自己有一层"记忆"（`src/agent/history.js`），但它是**为了省 token 而压缩
// 上下文**，不是为了陪伴：
//   · `history.memory` 是一段自然语言摘要，**硬上限 500 字符**（超了直接截断）；
//   · 每攒够 `max_messages` 条就调一次大模型去重写它（`promptMemSaving`）——
//     **记忆本身是要花钱的**，而且每次重写都可能把旧事压掉；
//   · 我们启动时是 `load_memory: false`，所以**重启一次记忆就归零**。
//
// 用户要的"陪伴"恰恰是记住：主人是谁、家在哪、答应过什么、一起干过什么。
// 所以这一层由我们自己管：
//   · 存成我们自己的 JSON（`runtime/memory/<botId>.json`），重启不丢；
//   · **说"记住…"就记住**，走规则通路 —— 不花一次大模型调用；
//   · **问"你还记得…吗"就直接答**，同样不花钱；
//   · 走大模型时，只把**跟这句话相关**的几条塞进上下文，不无脑全塞（那是钱）。
//
// 设计上刻意保守：
//   · 自动记的只认**明确的长期信息**（"我家在…""我喜欢…""明天…"），
//     宁可漏记，也不要把闲聊灌进去 —— 记忆一旦变噪音，比没有更糟。
//   · 满了丢最旧的；`promise` 优先保留（欠人的话不能忘）。
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';

export const MEMORY_VERSION = 1;
/** 最多存多少条。满了丢最旧的，但 promise 优先留。 */
export const MAX_ENTRIES = 80;
/** 塞进上下文时的字符上限 —— 这是花钱的地方，必须小。 */
export const DIGEST_MAX = 320;

export const KIND_LABEL = {
    fact: '',
    promise: '[约定] ',
    place: '[地点] ',
    event: '[经历] ',
};

/** 组词时忽略的通用词：它们几乎跟任何一句话都"相关"，留着只会稀释匹配。 */
const STOP_TOKENS = new Set([
    '什么', '怎么', '这个', '那个', '一下', '可以', '我们', '你们', '他们',
    '现在', '今天', '明天', '昨天', '记得', '知道', '还是', '就是', '因为',
    '所以', '如果', '但是', '还有', '没有', '不是', '在吗', '你好', '谢谢',
]);

const PUNCT = /[，。！？、；：,.!?;:~～"'“”‘’（）()\[\]【】\s]+/g;

function norm(s) {
    return String(s ?? '').replace(PUNCT, ' ').trim();
}

/** 去重用的键：忽略标点与大小写，免得同一个意思存成两条。 */
function keyOf(text) {
    return norm(text).replace(/\s+/g, '').toLowerCase();
}

/**
 * 中文没有空格，所以检索用**二元组**：把每段汉字切成相邻两字的组合，
 * 再配一个忽略表。这样"家在哪"能命中"我家在 (-12, 64, 30)"。
 */
export function tokens(s) {
    const src = String(s ?? '').toLowerCase();
    const out = [];
    for (const w of src.match(/[a-z0-9_]{2,}/g) || []) out.push(w);
    for (const run of src.match(/[\u4e00-\u9fa5]+/g) || []) {
        if (run.length === 1) { out.push(run); continue; }
        for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2));
    }
    return out.filter((t) => !STOP_TOKENS.has(t));
}

// ── 纯函数：memory 是一个普通对象，便于单测 ─────────────────────────────────

export function emptyMemory() {
    return { version: MEMORY_VERSION, entries: [] };
}

function trim(mem) {
    if (mem.entries.length <= MAX_ENTRIES) return mem;
    // 约定的优先级最高：先把非 promise 的旧条目丢掉。
    const excess = mem.entries.length - MAX_ENTRIES;
    const doomed = new Set();
    for (const e of mem.entries) {
        if (doomed.size >= excess) break;
        if (e.kind !== 'promise') doomed.add(e.id);
    }
    for (const e of mem.entries) {
        if (doomed.size >= excess) break;
        doomed.add(e.id);
    }
    mem.entries = mem.entries.filter((e) => !doomed.has(e.id));
    return mem;
}

/**
 * 记一条。同义（去掉标点后一样）的更新而不是新增 —— 否则"我喜欢钻石"
 * 说三遍就变成三条记忆，摘要全是重复。
 */
export function remember(mem, { text, kind = 'fact', tags = null, from = null, ts = null }) {
    const clean = norm(text);
    if (clean.length < 2) return { ok: false, reason: 'too-short' };
    if (!KIND_LABEL[kind]) kind = 'fact';
    const key = keyOf(clean);
    const at = ts ?? Date.now();

    const hit = mem.entries.find((e) => keyOf(e.text) === key);
    if (hit) {
        hit.ts = at;
        hit.from = from ?? hit.from;
        if (tags) hit.tags = [...new Set([...(hit.tags || []), ...tags])];
        return { ok: true, dup: true, entry: hit };
    }

    const entry = {
        id: `${at.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        ts: at,
        kind,
        text: clean,
        tags: tags ?? tokens(clean),
        from,
    };
    mem.entries.push(entry);
    trim(mem);
    return { ok: true, dup: false, entry };
}

/** 忘掉：给 id、给一段文字、或给 'all'。返回删掉的条数。 */
export function forget(mem, what) {
    if (what === 'all') {
        const n = mem.entries.length;
        mem.entries = [];
        return n;
    }
    const key = keyOf(what || '');
    if (!key) return 0;
    const before = mem.entries.length;
    mem.entries = mem.entries.filter((e) => e.id !== what && keyOf(e.text) !== key);
    return before - mem.entries.length;
}

/**
 * 找相关的几条。query 为空 → 给最近的几条（"你都记得什么"）。
 * 打分就是"命中了几个检索词"，平分时新的排前面。
 */
export function recall(mem, query, limit = 6) {
    const all = [...mem.entries].sort((a, b) => b.ts - a.ts);
    const q = tokens(query);
    if (q.length === 0) return all.slice(0, limit);

    const scored = [];
    for (const e of all) {
        const hay = new Set([...(e.tags || []), ...tokens(e.text), ...(e.from ? tokens(e.from) : [])]);
        let score = 0;
        for (const t of q) if (hay.has(t)) score += t.length >= 2 ? 2 : 1;
        // 直接包含原句是最强的信号（"我说的那句原话"）
        if (norm(e.text).includes(norm(query)) && norm(query).length >= 2) score += 6;
        if (score > 0) scored.push({ e, score });
    }
    scored.sort((a, b) => b.score - a.score || b.e.ts - a.e.ts);
    return scored.slice(0, limit).map((s) => s.e);
}

/** 压成一小段中文，塞进提示词用。 */
export function digest(entries, maxChars = DIGEST_MAX) {
    const out = [];
    let used = 0;
    for (const e of entries) {
        const label = KIND_LABEL[e.kind] || '';
        const who = e.from && !e.text.startsWith(e.from) ? `${e.from} 说过：` : '';
        const line = `• ${label}${who}${e.text}`;
        if (used + line.length + 1 > maxChars) break;
        out.push(line);
        used += line.length + 1;
    }
    if (out.length < entries.length) out.push('• …（还有更多，问我具体的）');
    return out.join('\n');
}

// ── 从中文里认出"要记住 / 在问记忆" ─────────────────────────────────────────

const REMEMBER_RES = [
    /^记(?:住|一下|下来|好了)[:：,，]?\s*(.+)$/,
    /^(?:别忘了|别忘记|不要忘记|帮我记(?:住|一下|下来)?)[:：,，]?\s*(.+)$/,
    /^(?:你)?记着[:：,，]?\s*(.+)$/,
];

/**
 * "记住我喜欢钻石" → {text:'我喜欢钻石'}
 * 认不出就返回 null（交给大模型），**绝不猜**。
 */
export function parseRememberIntent(text) {
    const t = String(text ?? '').trim();
    for (const re of REMEMBER_RES) {
        const m = re.exec(t);
        if (m && m[1]) {
            const body = m[1].replace(/^[的了]\s*/, '').trim();
            if (body.length >= 2) return { text: body };
        }
    }
    return null;
}

const RECALL_RES = [
    // ★ "你记得什么/啥" 这类**必须先匹配**：否则下面那条通配会把"什么"
    //   当成要查的关键词，跑去检索"什么"两个字。
    /^你?(?:还)?记得\s*(?:什么|啥|多少|哪些)/,
    /^我说过(?:什么|啥)/,
    /^你(?:都)?知道(?:什么|啥)/,
    /(?:说说|讲讲)你记得/,
    /你(?:还)?记得(.+?)(?:吗|么|嘛|不)?[?？]?$/,
    /^(?:你)?记得(?:什么|啥|多少)/,
];

/** "你还记得我家在哪吗" → {query:'我家在哪'}；"你记得什么" → {query:''} */
export function parseRecallIntent(text) {
    const t = String(text ?? '').trim();
    for (const re of RECALL_RES) {
        const m = re.exec(t);
        if (m) {
            const q = (m[1] || '').replace(/[?？。！!]+$/, '').trim();
            return { query: q };
        }
    }
    return null;
}

/**
 * 闲聊里自动捞"长期信息"。**故意只认很明确的措辞** ——
 * 宁可漏记，也不要把"今天天气不错"存成记忆。
 *
 * 按标点切成短句再逐句判断：玩家常常一口气说两件事
 * （"我家在 (-12,64,30)，以后别在晚上出门"），合成一条读回来是一句囫囵话。
 *
 * 🔴 但切句之前**必须先把坐标护起来**：坐标三元组里的逗号也是逗号，
 * 直接切会把 `(-12, 64, 30)` 剁成 `我家在 (-12` / `64` / `30)`，
 * 于是"我家在哪"记回来只剩一个 x。这个 bug 是单元测试没抓到、真机上看出来的
 * （日志里赫然一行 `顺手记住：我家在 -12`）。
 */
const COORD_TRIPLE = /[（(]\s*-?\d{1,5}\s*[，,]\s*-?\d{1,5}\s*[，,]\s*-?\d{1,5}\s*[)）]/g;
// 单独留一个不带 g 的副本用于判断：带 g 的正则 .test() 会记住 lastIndex，
// 同一个正则既切分又判断，迟早会在某次调用上给出错误答案。
const HAS_COORD = /[（(]\s*-?\d{1,5}\s*[，,]\s*-?\d{1,5}\s*[，,]\s*-?\d{1,5}\s*[)）]/;
const FACT_MARKERS = /(?:我(?:的)?(?:家|基地|房子|床|箱子|仓库)|我(?:喜欢|讨厌|想要|需要|一般|通常|习惯|住在)|以后|下次|明天|后天|说好|约好|答应)/;

/** 把坐标三元组换成占位符，切完句再换回来。 */
function splitClauses(message) {
    const coords = [];
    const masked = String(message ?? '').replace(COORD_TRIPLE, (m) => {
        coords.push(m.replace(/\s+/g, ' '));
        return `\u0000${coords.length - 1}\u0000`;   // \u0000 不可能出现在玩家输入里
    });
    return masked.split(/[，,。；;！!？?\n]/).map((s) =>
        s.replace(/\u0000(\d+)\u0000/g, (_, i) => coords[Number(i)] ?? ''));
}

export function extractFacts(username, message) {
    const out = [];
    for (const clause of splitClauses(message)) {
        const t = norm(clause);
        if (t.length < 4 || t.length > 60) continue;
        if (!FACT_MARKERS.test(t)) continue;
        if (out.some((f) => keyOf(f.text) === keyOf(t))) continue;
        // 带坐标的三元组算"地点"，界面上会用不同的标签显示
        const kind = HAS_COORD.test(clause) ? 'place' : 'fact';
        out.push({ text: t, kind, from: username || null, tags: tokens(t) });
        if (out.length >= 2) break;   // 一条消息最多记两句，别把一段话拆成一堆
    }
    return out;
}

// ── 落盘 ────────────────────────────────────────────────────────────────────

/**
 * 记忆文件放哪。优先用启动器显式给的目录；没给就从事件文件推
 * （`runtime/logs/<botId>.jsonl` → `runtime/memory/<botId>.json`）。
 */
export function memoryFileFor(botId, dir = null) {
    const safe = String(botId || 'unknown')
        .replace(/[^a-zA-Z0-9_.-]/g, '_')
        .replace(/\.{2,}/g, '_');   // 连 `..` 也要洗掉：`join` 之后它仍可能是一段路径
    if (dir) return path.join(dir, `${safe}.json`);
    const events = process.env.MCBOT_EVENTS_FILE;
    if (events) return path.join(path.dirname(events), '..', 'memory', `${safe}.json`);
    return path.join(process.cwd(), 'runtime', 'memory', `${safe}.json`);
}

export function loadMemory(file) {
    try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!raw || !Array.isArray(raw.entries)) return emptyMemory();
        raw.version = MEMORY_VERSION;
        return raw;
    } catch {
        return emptyMemory();
    }
}

export function saveMemory(file, mem) {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(mem, null, 2), 'utf8');
        fs.renameSync(tmp, file);
        return true;
    } catch (err) {
        console.error('[mcbot-memory] 写入失败：', err?.message || err);
        return false;
    }
}

/** 门禁侧用的便捷包装：读一次、改完自动落盘。 */
export class Memory {
    constructor(file) {
        this.file = file;
        this.data = loadMemory(file);
    }

    remember(item) {
        const r = remember(this.data, item);
        if (r.ok) this.flush();
        return r;
    }

    forget(what) {
        const n = forget(this.data, what);
        if (n) this.flush();
        return n;
    }

    recall(query, limit) { return recall(this.data, query, limit); }

    all() { return [...this.data.entries].sort((a, b) => b.ts - a.ts); }

    digest(entries, max) { return digest(entries ?? this.all(), max); }

    get size() { return this.data.entries.length; }

    flush() { return saveMemory(this.file, this.data); }
}
