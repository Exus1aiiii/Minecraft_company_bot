// ============================================================================
// 版本判定（mc-versions）——「这条服务器该填哪个版本」这件事的唯一答案来源
//
// 为什么要有这个文件：
//   在这之前，"1.21.1" 这个字符串散落在至少 8 个地方（启动器默认值、门禁默认值、
//   配置迁移、界面提示文案、几个工具脚本……）。用户想连 1.20.1 的服务器时，
//   没有任何地方能告诉他"这个版本行不行、为什么不行、那该填什么"，只能等引擎
//   抛一句英文的 `unsupported protocol version: xxx`。
//
//   更糟的是：**协议库认识某个版本 ≠ 我们手里有那个版本的数据**。
//   minecraft-protocol 的 supportedVersions 覆盖 1.7 … 26.1，而 minecraft-data
//   只在其中一部分版本上有方块/物品/配方数据。填了一个"协议库认识、但没有数据"
//   的版本（比如 1.21.6），引擎会在**连接之前**就死在
//   `TypeError: Cannot read properties of null (reading 'version')` 上 ——
//   报错指向 ping.js，和用户填的版本号看起来毫无关系。
//
// 所以这里只做三件事：
//   1. normalizeVersion()：把用户可能写出的形态（' 1.20.1 '、'v1.20.1'、'auto'、
//      '自动'、''）收敛成一个规范值；认不出来的原样返回，**绝不猜**。
//   2. judgeVersion()：给出一句人话 + 一句该怎么办。四种结局分明：
//         · 有数据、而且我们核对过   → ok
//         · 有数据、但我们没核对过   → ok，但如实说"没验过"
//         · 协议库认识、但没有数据   → 不行（这是最容易踩的一种）
//         · 协议库根本不认识         → 不行，并猜他想填哪个
//   3. describeVersionOptions()：给界面用的候选表（带协议号、验没验过）。
//
// 版本表本身**不在这里抄第二份**：哪些版本是协议库认识的、哪些有数据，全部来自
// engine-patches.mjs 的 describeProtocolStack()（那是 V-3 守卫用的同一份事实）。
// 这里只是额外去 minecraft-data 里读一次每个版本的协议号，供界面显示。
// ============================================================================

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describeProtocolStack } from './engine-patches.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_DIR = path.resolve(__dirname, '..', 'vendor', 'mindcraft-develop');

// 与 engine-patches.mjs 同一个锚点：保证读到的是引擎实际使用的那一份依赖。
const engineRequire = createRequire(path.join(ENGINE_DIR, 'package.json'));

/** 没有特别要求时用哪一版。挑它的理由：我们真的连过 1.21.1 的服务器。 */
export const DEFAULT_VERSION = '1.21.1';

/**
 * 逐条核对过数据的版本（`tools\test-versions.mjs` 会对这些版本断言：
 * 我们按名字用到的方块/物品都在、配方都在且产物一致、烧炼与挖掘规则成立）。
 * 加版本进这个数组的前提是那套自检真的绿了。
 */
export const DATA_VERIFIED_VERSIONS = ['1.20.1', '1.21.1'];

/**
 * 我们**真的连上过**的版本（有真机或本机服的实际登录记录）。
 * 这个数组故意比上面短：数据核对过 ≠ 在真服务器上跑通过。
 * 界面上这两件事要分开说，用户才知道"第一次连 1.20.1"该留意什么。
 */
export const REAL_SERVER_VERSIONS = ['1.21.1'];

/** 用户可能拿来表示"你帮我挑"的写法。 */
const AUTO_WORDS = new Set(['', 'auto', '自动', '随便', '默认', '任意', 'any', 'latest', '最新']);

/**
 * 收敛用户输入的版本号。认不出来就原样返回（判断留给 judgeVersion）。
 * @param {unknown} raw
 * @returns {string} 'auto' 或版本号原文（去空白、去前缀 v、小写）
 */
export function normalizeVersion(raw) {
    const s = String(raw ?? '').trim();
    if (AUTO_WORDS.has(s.toLowerCase())) return 'auto';
    return s.replace(/^v/i, '').trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// 版本表（缓存一次）
// ---------------------------------------------------------------------------

let cache = null;

function stack() {
    if (cache) return cache;
    const info = describeProtocolStack();
    let mcData = null;
    if (!info.error) {
        try { mcData = engineRequire('minecraft-data'); } catch { mcData = null; }
    }
    const protocols = {};
    if (mcData) {
        for (const v of info.known || []) {
            const d = mcData(v);
            protocols[v] = d?.version?.version ?? null;
        }
    }
    cache = { info, mcData, protocols };
    return cache;
}

// ---------------------------------------------------------------------------
// 判定
// ---------------------------------------------------------------------------

const MAX_SUGGESTIONS = 3;

/**
 * 给一个用户填的版本号，回一句人话 + 一句"接下来怎么办"。
 *
 * @param {unknown} raw 用户填的原文（可能是 ''/'auto'/错拼/真版本号）
 * @returns {{
 *   ok: boolean, raw: string, version: string, mode: 'auto'|'explicit'|'unknown',
 *   withData: boolean, inProtocol: boolean, protocol: number|null,
 *   tested: boolean, realServer: boolean, reason: string, hint: string,
 *   suggestions: string[]
 * }}
 */
export function judgeVersion(raw) {
    const s = stack();
    const rawText = String(raw ?? '').trim();
    const base = {
        raw: rawText,
        version: '',
        mode: 'unknown',
        withData: false,
        inProtocol: false,
        protocol: null,
        tested: false,
        realServer: false,
        reason: '',
        hint: '',
        suggestions: [],
    };

    if (s.info.error) {
        return {
            ...base,
            ok: false,
            reason: `读不到版本表：${s.info.error}`,
            hint: '引擎依赖可能还没装齐 —— 先跑 node tools\\bootstrap.mjs',
        };
    }

    const known = s.info.known || [];          // 有数据的版本（升序）
    const supported = s.info.supported || [];  // 协议库认识的版本（升序）
    const proto = (v) => s.protocols[v] ?? null;
    const target = normalizeVersion(raw);

    // ── auto：让引擎自己挑 ──
    if (target === 'auto') {
        const chosen = known.includes(DEFAULT_VERSION) ? DEFAULT_VERSION : s.info.chosen;
        const fallbackNote = chosen === DEFAULT_VERSION
            ? ''
            : `（本机依赖里没有 ${DEFAULT_VERSION} 的数据，退到 ${chosen}）`;
        return {
            ...base,
            ok: true,
            version: chosen,
            mode: 'auto',
            withData: true,
            inProtocol: true,
            protocol: proto(chosen),
            tested: DATA_VERIFIED_VERSIONS.includes(chosen),
            realServer: REAL_SERVER_VERSIONS.includes(chosen),
            reason: `自动：用 ${chosen}（协议 ${proto(chosen) ?? '?'}）${fallbackNote}`,
            hint: '「自动」不会去猜服务器的版本 —— 引擎在连接时按服务端回包自己纠正，'
                + '所以连不上时问题多半在地址/端口，不用改这里。',
        };
    }

    const withData = known.includes(target);
    const inProtocol = supported.includes(target);
    const tested = DATA_VERIFIED_VERSIONS.includes(target);
    const realServer = REAL_SERVER_VERSIONS.includes(target);

    // ── 有数据：能用 ──
    if (withData) {
        const notes = [`${target} 可以（协议 ${proto(target) ?? '?'}）`];
        if (tested && !realServer) {
            notes.push(`它的方块/配方我们逐条核对过，但**没有真的连过 ${target} 服务器**`
                + '（本机的服务端只有 1.21.1，新版本下不下来）。第一次连上去请留意日志。');
        } else if (!tested) {
            notes.push(`依赖里有 ${target} 的数据，但我们的核对清单只覆盖 `
                + `${DATA_VERIFIED_VERSIONS.join(' / ')} —— 这个算"应该能用、没核对过"。`);
        }
        const hintParts = [];
        if (target === '1.20') hintParts.push('1.20 和 1.20.1 是同一个协议号，填哪个都行。');
        if (target !== DEFAULT_VERSION) {
            hintParts.push(`服务端如果实际是别的版本，随便填一个只会白试 —— 拿不准就填 auto。`);
        }
        return {
            ...base,
            ok: true,
            version: target,
            mode: 'explicit',
            withData: true,
            inProtocol: true,
            protocol: proto(target),
            tested,
            realServer,
            reason: notes[0],
            hint: [notes.slice(1).join(' '), ...hintParts].filter(Boolean).join(' '),
        };
    }

    // ── 协议库认识，但我们没有这一版的数据（最容易踩的一种）──
    if (inProtocol) {
        const usable = known.slice(-4);
        return {
            ...base,
            ok: false,
            mode: 'explicit',
            inProtocol: true,
            reason: `协议库认识 ${target}，但我们手里的方块/配方数据没有这一版。`,
            hint: `引擎会在**还没有开始连接**的时候就报错（而且报的是别的地方），`
                + `所以别填它：改成 auto，或填有数据的 ${usable.join(' / ')}。`,
            suggestions: usable.slice().reverse(),
        };
    }

    // ── 完全不认识：多半是拼错了 ──
    const suggestions = suggestVersions(target, known);
    return {
        ...base,
        ok: false,
        mode: 'explicit',
        reason: suggestions.length
            ? `「${rawText}」不是已知的版本号`
            : `协议库不认识「${rawText}」这个版本号`,
        hint: suggestions.length
            ? `你是不是想填 ${suggestions[0]}？`
            : `可用的版本（有数据的）：${known.join(' / ')}；不想挑就填 auto。`,
        suggestions,
    };
}

// ---------------------------------------------------------------------------
// 猜用户想填哪个（编辑距离 + 前缀加权）
// ---------------------------------------------------------------------------

function editDistance(a, b) {
    const m = a.length;
    const n = b.length;
    if (!m) return n;
    if (!n) return m;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
        const cur = [i];
        for (let j = 1; j <= n; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        }
        prev = cur;
    }
    return prev[n];
}

/**
 * 从版本池里挑几个"最像"的。
 * 打分刻意简单：编辑距离为主，前缀相同（`1.20` vs `1.20.11`）再减一分，
 * 同分时偏向更新的版本。宁可少给建议，也不要给一个离谱的。
 */
export function suggestVersions(input, pool = null) {
    const s = stack();
    const list = (pool || s.info.known || []).slice();
    const needle = normalizeVersion(input);
    if (!needle || needle === 'auto' || !list.length) return [];
    const prefix = needle.split('.').slice(0, 2).join('.');
    const scored = list.map((v) => {
        let score = editDistance(needle, v);
        if ((prefix && v.startsWith(prefix + '.')) || v === prefix) score -= 1;
        if (v.startsWith(needle)) score -= 0.5;
        return { v, score };
    }).sort((a, b) => (a.score - b.score) || (b.v.localeCompare(a.v, undefined, { numeric: true })));

    const best = scored[0];
    // 差太远就别猜了（例如用户填的是 "foo"）：宁可直说"不认识"
    if (!best || best.score > Math.max(2, Math.ceil(needle.length / 3))) return [];
    const limit = best.score + 1;
    return scored.filter((x) => x.score <= limit).slice(0, MAX_SUGGESTIONS).map((x) => x.v);
}

// ---------------------------------------------------------------------------
// 给界面用的候选表
// ---------------------------------------------------------------------------

/**
 * 候选版本表 + 我们验到什么程度。界面用它在版本输入框下面写一句实话。
 * @returns {{ok:boolean, default:string, dataVerified:string[], realServer:string[],
 *            options:{version:string, protocol:number|null, tested:boolean,
 *                     realServer:boolean, note:string}[], error?:string}}
 */
export function describeVersionOptions() {
    const s = stack();
    if (s.info.error) {
        return {
            ok: false,
            error: s.info.error,
            default: DEFAULT_VERSION,
            dataVerified: DATA_VERIFIED_VERSIONS.slice(),
            realServer: REAL_SERVER_VERSIONS.slice(),
            options: [],
        };
    }
    const options = (s.info.known || []).slice().reverse().map((v) => {
        const tested = DATA_VERIFIED_VERSIONS.includes(v);
        const realServer = REAL_SERVER_VERSIONS.includes(v);
        return {
            version: v,
            protocol: s.protocols[v] ?? null,
            tested,
            realServer,
            note: versionNote(v),
        };
    });
    return {
        ok: true,
        default: DEFAULT_VERSION,
        dataVerified: DATA_VERIFIED_VERSIONS.slice(),
        realServer: REAL_SERVER_VERSIONS.slice(),
        options,
    };
}

/** 一个版本的一句话标签（给下拉/提示用）。 */
export function versionNote(v) {
    const s = stack();
    const p = s.protocols[v] ?? null;
    const proto = p === null ? '' : `协议 ${p}`;
    if (REAL_SERVER_VERSIONS.includes(v)) return `${v}（${proto}，我们真连过）`;
    if (DATA_VERIFIED_VERSIONS.includes(v)) return `${v}（${proto}，数据核对过）`;
    return `${v}（${proto}，没核对过）`;
}
