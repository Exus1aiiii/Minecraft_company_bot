// app/electron/store.mjs
// AppConfig 的读写与校验，以及密钥托管。
//
// ★ 安全不变量：**明文密钥永远不出主进程**。回传给渲染进程的只有 hasKey 与掩码 keyHint。

import fs from 'node:fs';
import path from 'node:path';
import { safeStorage } from 'electron';
import { CONFIG_FILE, SECRETS_FILE, ensureDirs } from './paths.mjs';

// ─────────────────────────────────────────────────────────────────────────────
// 大模型服务商预设（UI 上"一键填入"用；用户可随意改）
// ─────────────────────────────────────────────────────────────────────────────

export const PROVIDER_PRESETS = [
  {
    id: 'deepseek', label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat',
    hint: '国产，性价比高，中文好，适合长期陪伴对话',
  },
  {
    id: 'qwen', label: '通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus',
    hint: '阿里云百炼的 OpenAI 兼容端点',
  },
  {
    id: 'ollama', label: 'Ollama（本地）',
    baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b',
    hint: '完全本地推理，不花钱、不出网，但需要本机装好 Ollama',
  },
  {
    id: 'custom', label: '自定义',
    baseUrl: '', model: '',
    hint: '任何 OpenAI 兼容的 /chat/completions 端点都可以',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// 出厂主人名单：一个"看起来像真配置"的占位符
// ─────────────────────────────────────────────────────────────────────────────
//
// ★ 这是首跑最容易踩的坑，值得写清楚：
//   门禁（runner/mcbot-gate.mjs）对**名字不在主人名单里的人完全静默** —— 一句话都不回。
//   出厂 bot 的 owners 是 ['Steve']，它**非空**，所以：
//     · validateConfig 的"必须指定至少一个主人"不会响（见下面 store.mjs 的校验）
//     · bots 页那条"没有配 owner"的警告也不会响
//     · 而用户的真实游戏 ID 几乎不叫 Steve
//   → 结果：用户双击启动、进服务器喊「小豆 你好」，得到的是**永久沉默**，
//     界面上也没有任何异常。用户只会觉得"这软件坏了"。
//
//   所以除了警告，还需要一个**能判断"配没配过"的显式标记**：ownersConfigured。
//   判断规则（见 normalizeConfig）：
//     · 配置里写了布尔（true/false）        → 信它，包括显式 false
//     · 否则，只要当前名单不等于出厂名单 → 视为已配置（老配置升级上来的情况）
//     · 恰好等于 ['Steve'] 且没有标记      → 视为**没配过**，界面要提示

export const FACTORY_OWNERS = ['Steve'];

// ★ 比较用的那份必须也小写化。第一版这里写的是拿 FACTORY_OWNERS 原文去比 list，
//   而 list 已经 toLowerCase 过了 —— `'steve' === 'Steve'` 恒为 false，
//   于是"出厂名单"永远判不出来，首跑提示永远不出现，而且不报任何错。
//   被 devtools/test-firstrun.mjs 第 1 节抓住的。
const FACTORY_OWNERS_LC = FACTORY_OWNERS.map(n => n.toLowerCase());

/** 这份主人名单是不是"从来没人动过"的出厂占位符？大小写不敏感、忽略空项。 */
export function isFactoryOwners(owners) {
  const list = arr(owners).map(x => String(x).trim().toLowerCase()).filter(Boolean);
  if (list.length !== FACTORY_OWNERS_LC.length) return false;
  return FACTORY_OWNERS_LC.every((n, i) => list[i] === n);
}

/**
 * 内置的固定意图规则：命中话头就直接发引擎命令，**一次大模型调用都不发生**。
 * 后四条（collect/seek/explore）是 v2 加的"帮忙搜集原材料 / 一起探险"，
 * 它们需要从话里现认参数（采什么、采多少）—— 认不出就退回大模型，
 * 所以话头可以写得宽一点，不会因为误匹配而做错事。
 *
 * ★★ 话头里可以写 `*`，表示"这里允许塞最多 4 个字"（规则见 runner/rulematch.mjs）。
 *    中文会在动词和宾语之间塞字：「报坐标」→「报**一下**坐标」、
 *    「看背包」→「看**下**背包」、「盖房子」→「盖**一座大**房子」。
 *    只写「报坐标」的话，真机上一句「报一下坐标」就**悄悄退回大模型** ——
 *    用户白花 5109 token，而界面上这条规则明明开着。这种 bug 不报错，只是变贵。
 *    不写 `*` 的照旧精确包含匹配 —— 不确定该不该放宽时，宁可不放宽。
 */
const DEFAULT_RULES = [
  { id: 'follow', enabled: true, patterns: ['跟着我', '跟紧我', '跟我来', '跟上我', '跟我走', '跟着*我', '跟*走'], action: 'followPlayer' },
  { id: 'stop', enabled: true, patterns: ['停下', '别动', '站住', '停一下', '停*下', '别*动'], action: 'stop' },
  { id: 'come', enabled: true, patterns: ['过来', '来我这', '来我身边', '过*来', '来我*边'], action: 'goToPlayer' },
  { id: 'inventory', enabled: true, patterns: ['你背包里有什么', '看看背包', '看*背包', '背包里有*'], action: 'inventory' },
  { id: 'where', enabled: true, patterns: ['你在哪', '报坐标', '报*坐标', '坐标', '你在*哪'], action: 'stats' },
  // ── v2：采集原料 ──
  {
    id: 'collect', enabled: true, action: 'collectBlocks',
    patterns: ['砍点', '砍些', '砍树', '砍棵', '挖点', '挖些', '挖个', '采点', '采些', '收集', '帮我弄点', '帮我搞点', '弄点', '搞点', '去砍', '去挖', '去采',
      '砍*个', '砍*棵', '挖*个', '挖*块', '采*个'],
  },
  // ── v2：找某种方块（探险时用）──
  {
    id: 'seek', enabled: true, action: 'searchForBlock', range: 64,
    // 「附近有铁矿吗」这种说法最自然，但原来只认「附近有没有」——
    // 于是真机上它退回大模型、白花 token，而界面上这条规则明明开着。
    patterns: ['找找', '找一下', '附近有没有', '附近有', '有没有', '哪有', '哪里有', '哪儿有', '带我去找',
      '附近*有', '哪儿*有', '去找*矿'],
  },
  // ── v2：四处走走。诚实说，这只是"朝一个方向走 30 格"，不是真正的探索 ──
  {
    id: 'explore', enabled: true, action: 'explore', distance: 30,
    patterns: ['四处走走', '随便逛逛', '去探险', '探索一下', '到处看看', '带我转转',
      '四处*走', '随便*逛', '到处*走', '带我*转', '去*探险'],
  },
  // ── v2：盖房子。引擎没有任何建造命令，这段流程完全长在我们这层 ──
  {
    id: 'build', enabled: true, action: 'buildHouse', size: 'small',
    patterns: ['盖个房子', '盖房子', '盖间房', '盖座房', '建个房子', '建房子', '搭个房子', '搭房子',
      '造个房子', '造房子', '盖个小屋', '盖个木屋', '盖座小屋', '帮我盖', '给我盖', '盖个大',
      '盖*房子', '建*房子', '搭*房子', '造*房子', '盖*小屋', '盖*木屋', '盖*房'],
  },
  // ── v3：长期陪伴记忆。这两条是"陪伴"与"工具"的分界线，而且零 token ──
  // 话头故意写宽：认不出要记什么/在问什么时会退回大模型（FALLBACK），
  // 不会乱答。
  {
    id: 'remember', enabled: true, action: 'remember',
    patterns: ['记住', '记一下', '记下来', '记着', '别忘了', '别忘记', '帮我记'],
  },
  {
    id: 'recall', enabled: true, action: 'recall',
    patterns: ['你还记得', '你记得', '还记得吗', '我说过什么', '你知道什么', '记得什么'],
  },
  {
    // 做工具 / 工作台 / 熔炉。引擎的 !craftRecipe 只会做一步，而"做把石镐"要
    // 先做木镐去挖圆石 —— 这条链跑在我们的门禁里（runner/workshop.mjs），零 token。
    id: 'craft', enabled: true, action: 'craft',
    patterns: [
      '做把镐', '做把镐子', '做把木镐', '做把石镐', '做把铁镐',
      '做个镐', '做个镐子', '造把镐', '弄把镐',
      '做把斧', '做把斧头', '做把剑', '做把刀', '做把铲', '做把锹', '做把锄',
      '做个工作台', '做张工作台', '造个工作台', '做个台子',
      '做个熔炉', '造个熔炉', '做个炉子',
      '做个箱子', '做个储物箱',
      '做点火把', '做几个火把', '做把工具', '帮我做', '给我做', '帮我造',
      // 烧炼：「烧」是另一套动词，走的是同一条本地流程（熔炉 + skills.smeltItem）
      '烧点铁', '烧铁', '烧点金', '烧点铜', '烧玻璃', '烧点玻璃', '烧点木炭', '烧炭', '炼铁', '炼金',
    ],
  },
];

/** 深拷一份默认规则（避免多处共享同一个数组/对象）。 */
function cloneDefaultRules() {
  return DEFAULT_RULES.map(r => ({ ...r, patterns: [...r.patterns] }));
}

let idSeq = 0;
function newId(prefix) {
  idSeq += 1;
  return `${prefix}-${Date.now().toString(36)}${idSeq.toString(36)}`;
}

export function defaultConfig() {
  return {
    version: 1,
    llm: {
      profiles: PROVIDER_PRESETS.filter(p => p.id !== 'custom').map(p => ({
        id: p.id,
        label: p.label,
        baseUrl: p.baseUrl,
        model: p.model,
        temperature: 0.7,
        maxTokens: 800,
        timeoutMs: 60000,
      })),
    },
    servers: [
      {
        id: 'srv-local',
        label: '本地测试服（原版 1.21.1）',
        host: '127.0.0.1',
        port: 25565,
        version: '1.21.1',
        auth: 'offline',
      },
    ],
    bots: [
      {
        id: 'bot-xiaodou',
        name: 'Xiaodou',
        displayName: '小豆',
        serverId: 'srv-local',
        llmProfileId: 'deepseek',
        enabled: false,
        wakeNames: ['小豆', 'xiaodou', '豆豆'],
        owners: FACTORY_OWNERS.slice(),
        ownersConfigured: false,
        rateLimitMs: 3000,
        dailyTokenBudget: 200000,
        personaId: 'companion-gentle',
        personaOverrides: {},
        skin: { model: 'slim', path: '', enabled: false },
        rules: cloneDefaultRules(),
      },
    ],
    app: { autoStartBots: false, language: 'zh' },
  };
}

export function makeBot(name, displayName, serverId, llmProfileId) {
  return {
    id: newId('bot'),
    name, displayName, serverId, llmProfileId,
    enabled: false,
    wakeNames: [displayName, name, name.toLowerCase()].filter((v, i, a) => v && a.indexOf(v) === i),
    owners: [],
    ownersConfigured: false,
    rateLimitMs: 3000,
    dailyTokenBudget: 200000,
    personaId: 'companion-gentle',
    personaOverrides: {},
    skin: { model: 'slim', path: '', enabled: false },
    rules: cloneDefaultRules(),
  };
}

export function makeServer(label, host, port, version = '1.21.1', auth = 'offline') {
  return { id: newId('srv'), label, host, port: Number(port) || 25565, version, auth };
}

export function makeLlmProfile(label, baseUrl, model) {
  return { id: newId('llm'), label, baseUrl, model, temperature: 0.7, maxTokens: 800, timeoutMs: 60000 };
}

// ─────────────────────────────────────────────────────────────────────────────
// 归一化：容忍旧版本配置、缺字段、类型不对 —— 目标是"永远能打开界面"
// ─────────────────────────────────────────────────────────────────────────────

const str = (v, d = '') => (typeof v === 'string' ? v : d);
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const arr = (v) => (Array.isArray(v) ? v : []);

export function normalizeConfig(raw) {
  const base = defaultConfig();
  const src = (raw && typeof raw === 'object') ? raw : {};

  const llmProfiles = arr(src.llm?.profiles).map(p => ({
    id: str(p.id) || newId('llm'),
    label: str(p.label, '未命名模型'),
    baseUrl: str(p.baseUrl).replace(/\/+$/, ''),
    model: str(p.model),
    temperature: num(p.temperature, 0.7),
    maxTokens: num(p.maxTokens, 800),
    timeoutMs: num(p.timeoutMs, 60000),
  }));

  const servers = arr(src.servers).map(s => ({
    id: str(s.id) || newId('srv'),
    label: str(s.label, '未命名服务器'),
    host: str(s.host, '127.0.0.1'),
    port: num(s.port, 25565),
    version: str(s.version, '1.21.1') || '1.21.1',
    auth: s.auth === 'microsoft' ? 'microsoft' : 'offline',
  }));

  const bots = arr(src.bots).map(b => {
    const owners = arr(b.owners).map(x => str(x)).filter(Boolean);
    return {
      id: str(b.id) || newId('bot'),
      name: str(b.name),
      displayName: str(b.displayName) || str(b.name),
      serverId: str(b.serverId),
      llmProfileId: str(b.llmProfileId),
      enabled: b.enabled === true,
      wakeNames: arr(b.wakeNames).map(x => str(x)).filter(Boolean),
      owners,
      // ★ 显式标记优先；没有标记就按"名单是否还是出厂值"推断（老配置的升级路径）。
      //   两个都是"没配过"的情况：出厂默认 ['Steve']、或者刚新建还没填（[]）。
      // ★ 三档，顺序不能反：
      //   1. 配置里显式写了布尔 → 信它。**包括显式 false** ——
      //      用户把名字填成了 Steve（或手动改回未认领），那是他的意图，不该被推断覆盖。
      //      第一版把这条写成 `b.ownersConfigured === true || …`，显式 false 被无视了。
      //   2. 没写过 → 用名单推断：非空且不等于出厂值 = 老配置升级上来的，算已配置。
      //   3. 其余（出厂 ['Steve']、空名单、新建的 bot）＝ 没配过，界面要提示。
      ownersConfigured: typeof b.ownersConfigured === 'boolean'
        ? b.ownersConfigured
        : (owners.length > 0 && !isFactoryOwners(owners)),
      rateLimitMs: num(b.rateLimitMs, 3000),
      dailyTokenBudget: num(b.dailyTokenBudget, 200000),
      personaId: str(b.personaId, 'companion-gentle'),
      personaOverrides: (b.personaOverrides && typeof b.personaOverrides === 'object') ? b.personaOverrides : {},
      skin: {
        model: b.skin?.model === 'classic' ? 'classic' : 'slim',
        path: str(b.skin?.path),
        enabled: b.skin?.enabled === true,
      },
      rules: arr(b.rules).length
        ? arr(b.rules).map(r => ({
            id: str(r.id) || newId('rule'),
            enabled: r.enabled !== false,
            patterns: arr(r.patterns).map(x => str(x)).filter(Boolean),
            action: str(r.action, 'none'),
          }))
        : cloneDefaultRules(),
    };
  });

  return {
    version: num(src.version, 1),
    llm: { profiles: llmProfiles.length ? llmProfiles : base.llm.profiles },
    servers: servers.length ? servers : base.servers,
    bots,
    app: {
      autoStartBots: src.app?.autoStartBots === true,
      language: str(src.app?.language, 'zh'),
    },
  };
}

const NAME_RE = /^[a-zA-Z0-9_]{3,16}$/;

/** 返回人类可读的错误数组；空数组 = 通过。**不抛异常**，因为界面要把错误显示出来。 */
export function validateConfig(cfg) {
  const errors = [];

  const llmIds = new Set();
  for (const p of cfg.llm.profiles) {
    if (!p.label.trim()) errors.push(`模型「${p.id}」缺少名称`);
    if (!p.baseUrl.trim()) errors.push(`模型「${p.label || p.id}」缺少 Base URL`);
    else if (!/^https?:\/\//i.test(p.baseUrl)) errors.push(`模型「${p.label || p.id}」的 Base URL 必须以 http:// 或 https:// 开头`);
    if (!p.model.trim()) errors.push(`模型「${p.label || p.id}」缺少模型名`);
    if (llmIds.has(p.id)) errors.push(`模型 id 重复：${p.id}`);
    llmIds.add(p.id);
  }

  const serverIds = new Set();
  for (const s of cfg.servers) {
    if (!s.label.trim()) errors.push(`服务器「${s.id}」缺少名称`);
    if (!s.host.trim()) errors.push(`服务器「${s.label || s.id}」缺少地址`);
    if (!(s.port > 0 && s.port < 65536)) errors.push(`服务器「${s.label || s.id}」的端口 ${s.port} 不合法`);
    if (serverIds.has(s.id)) errors.push(`服务器 id 重复：${s.id}`);
    serverIds.add(s.id);
  }

  const botIds = new Set();
  const botNames = new Map();
  for (const b of cfg.bots) {
    const who = b.displayName || b.name || b.id;
    if (!NAME_RE.test(b.name)) {
      errors.push(`机器人「${who}」的 MC 账号名不合法 —— 只能是 3~16 位字母、数字或下划线（引擎硬性要求，中文只能用作唤醒称谓）`);
    }
    const lower = b.name.toLowerCase();
    if (botNames.has(lower)) errors.push(`MC 账号名「${b.name}」与「${botNames.get(lower)}」重复，同一服务器上不能有两个同名账号`);
    else botNames.set(lower, who);

    if (!b.wakeNames.length) errors.push(`机器人「${who}」至少需要一个唤醒称谓，否则它在公屏上永远不会被叫到`);
    if (!b.owners.length) errors.push(`机器人「${who}」必须指定至少一个主人（owner），否则它会拒绝所有人的指令`);
    if (!serverIds.has(b.serverId)) errors.push(`机器人「${who}」指向的服务器不存在（${b.serverId || '空'}）`);
    if (!llmIds.has(b.llmProfileId)) errors.push(`机器人「${who}」指向的模型不存在（${b.llmProfileId || '空'}）`);
    if (botIds.has(b.id)) errors.push(`机器人 id 重复：${b.id}`);
    botIds.add(b.id);
  }

  return errors;
}

// ─────────────────────────────────────────────────────────────────────────────
// 密钥托管
// ─────────────────────────────────────────────────────────────────────────────

function readSecretsRaw() {
  try {
    const t = fs.readFileSync(SECRETS_FILE, 'utf8');
    const o = JSON.parse(t);
    return (o && typeof o === 'object') ? o : {};
  } catch { return {}; }
}

function writeSecretsRaw(o) {
  ensureDirs();
  const tmp = SECRETS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(o, null, 2), 'utf8');
  fs.renameSync(tmp, SECRETS_FILE);
}

function encAvailable() {
  try { return safeStorage.isEncryptionAvailable(); } catch { return false; }
}

export function maskKey(key) {
  const k = String(key || '');
  if (k.length < 10) return k ? '****' : '';
  return `${k.slice(0, 3)}…${k.slice(-4)}`;
}

/**
 * 这把密钥看着像"占位符 / 自检用的假密钥"吗？
 *
 * ★ 为什么需要这个判定：`runtime\secrets.json` 里曾经留着一条**早期自检写进去的**
 *   `sk-multibot-fake`。界面上它显示成「已保存（sk-…fake）」，和真密钥长得一模一样 ——
 *   于是"我明明填过密钥了，怎么还是不通"这种最难查的故障就有了（真发生过）。
 *   宁可多提示一句"这看着像测试密钥"，也不要让人对着一个假 Key 猜半天。
 *
 *   判定刻意保守：只认**明确是假的**那几种形态，真密钥不会被误伤。
 *   （真密钥的形态是 `sk-` + 一长串随机字符，不会出现 test / fake / dummy 这类词。）
 */
export function looksLikePlaceholderKey(key) {
  const k = String(key || '').trim();
  if (!k) return false;
  if (/^sk-(test|fake|headless|multibot|dummy|spike|example|xxx|abc123)/i.test(k)) return true;
  if (/changeme|your[-_ ]?api[-_ ]?key|placeholder/i.test(k)) return true;
  // 中间整段就是 test / fake / dummy 这类词（例如 sk-headless-test-1234567890）
  if (/(^|[-_])(test|fake|dummy|example)([-_]|$)/i.test(k)) return true;
  return false;
}

export function setSecret(profileId, key) {
  if (!profileId) return { ok: false, error: '缺少模型 id' };
  const k = String(key || '').trim();
  const all = readSecretsRaw();
  if (!k) { delete all[profileId]; writeSecretsRaw(all); return { ok: true }; }

  if (encAvailable()) {
    all[profileId] = { enc: true, v: safeStorage.encryptString(k).toString('base64') };
  } else {
    // 极端情况：系统不支持 DPAPI（罕见）。宁可存明文也要能用，但明确标记出来让界面警告。
    all[profileId] = { enc: false, v: Buffer.from(k, 'utf8').toString('base64') };
  }
  writeSecretsRaw(all);
  return { ok: true };
}

export function getSecret(profileId) {
  const rec = readSecretsRaw()[profileId];
  if (!rec || !rec.v) return null;
  try {
    if (rec.enc) {
      if (!encAvailable()) return null;
      return safeStorage.decryptString(Buffer.from(rec.v, 'base64'));
    }
    return Buffer.from(rec.v, 'base64').toString('utf8');
  } catch { return null; }
}

export function clearSecret(profileId) {
  const all = readSecretsRaw();
  delete all[profileId];
  writeSecretsRaw(all);
  return { ok: true };
}

/** 给界面看的密钥状态：只有"有没有"和掩码，没有明文 */
export function secretStates() {
  const all = readSecretsRaw();
  const out = { __encryptionAvailable: encAvailable(), __plaintextFallback: false };
  for (const [id, rec] of Object.entries(all)) {
    if (rec && rec.enc === false) out.__plaintextFallback = true;
    const plain = getSecret(id);
    out[id] = { present: !!plain, hint: maskKey(plain), fake: looksLikePlaceholderKey(plain) };
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 配置读写
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 配置迁移：把**新版本才有的内置规则**补进老配置，并刷新**没被用户动过**的规则话头。
 *
 * 为什么需要它：`normalizeConfig` 只在 `rules` 整个字段缺失时才灌默认规则，
 * 而老用户的配置里已经有 follow/stop/come 那五条 —— 于是 v2 新加的
 * "采集原料 / 找方块 / 四处走走" 永远进不了他们的界面，用户会觉得"功能没做出来"。
 *
 * 迁移原则：**只增不改**。按 id 补齐缺失的内置规则，绝不删除用户自己加的规则。
 *
 * ⚠️ 但"只增不改"有个副作用：**光加规则不够，改了话头也送不到老用户那儿**。
 * 比如 `seek` 原来只认「附近有没有」，用户在真机上说的是「附近有铁矿吗」——
 * 这句话认不出就退回大模型，白花 token，而界面上那条规则明明开着。
 * 所以这里多了一步：`PREV_DEFAULT_PATTERNS` 记着**历史上每一版内置话头长什么样**，
 * 只有当用户当前的 patterns 和**某一版**旧默认**一模一样**（= 没自己改过）才刷成新的；
 * 用户动过的话头一个字都不碰 —— 他的改动比我们的新默认值重要。
 *
 * ★ 值是**数组的数组**（记得住多版历史），不是单个数组。
 *   只记"上一版"的话，一个跨了两个版本没开过应用的用户就永远刷不到新话头。
 */
const PREV_DEFAULT_PATTERNS = {
  follow: [['跟着我', '跟紧我', '跟我来', '跟上我']],
  stop: [['停下', '别动', '站住', '停一下']],
  come: [['过来', '来我这', '来我身边']],
  inventory: [['你背包里有什么', '看看背包']],
  where: [['你在哪', '报坐标']],
  collect: [['砍点', '砍些', '砍树', '砍棵', '挖点', '挖些', '挖个', '采点', '采些', '收集',
    '帮我弄点', '帮我搞点', '弄点', '搞点', '去砍', '去挖', '去采']],
  seek: [
    ['找找', '找一下', '附近有没有', '哪有', '哪里有', '带我去找'],                                  // v1
    ['找找', '找一下', '附近有没有', '附近有', '有没有', '哪有', '哪里有', '哪儿有', '带我去找'],      // v2
  ],
  explore: [['四处走走', '随便逛逛', '去探险', '探索一下', '到处看看', '带我转转']],
  build: [['盖个房子', '盖房子', '盖间房', '盖座房', '建个房子', '建房子', '搭个房子', '搭房子',
    '造个房子', '造房子', '盖个小屋', '盖个木屋', '盖座小屋', '帮我盖', '给我盖', '盖个大']],
};

export function migrateConfig(cfg) {
  if (!cfg || !Array.isArray(cfg.bots)) return cfg;
  for (const bot of cfg.bots) {
    if (!Array.isArray(bot.rules)) { bot.rules = cloneDefaultRules(); continue; }
    const have = new Set(bot.rules.map(r => r && r.id).filter(Boolean));
    for (const def of cloneDefaultRules()) {
      if (have.has(def.id)) continue;
      bot.rules.push(def);
    }
    // 刷新"没被用户动过"的内置话头
    for (const def of cloneDefaultRules()) {
      const prevList = PREV_DEFAULT_PATTERNS[def.id];
      if (!prevList) continue;
      const cur = bot.rules.find(r => r && r.id === def.id);
      if (!cur || !Array.isArray(cur.patterns)) continue;
      const curKey = JSON.stringify(cur.patterns);
      if (!prevList.some((prev) => JSON.stringify(prev) === curKey)) continue;  // 用户改过 → 不碰
      cur.patterns = def.patterns.slice();
    }
  }
  return cfg;
}

export function loadConfigRaw() {
  try {
    const t = fs.readFileSync(CONFIG_FILE, 'utf8');
    return migrateConfig(JSON.parse(t));
  } catch { return defaultConfig(); }
}

/** 落盘用：不含 hasKey/keyHint 这类回填字段 */
export function stripDerived(cfg) {
  const c = JSON.parse(JSON.stringify(cfg));
  for (const p of c.llm?.profiles ?? []) { delete p.hasKey; delete p.keyHint; }
  return c;
}

export function saveConfigRaw(cfg) {
  ensureDirs();
  const tmp = CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(stripDerived(cfg), null, 2), 'utf8');
  fs.renameSync(tmp, CONFIG_FILE);
}

/** 给渲染进程的完整配置：带 hasKey / keyHint */
export function loadConfigForUi() {
  const cfg = normalizeConfig(loadConfigRaw());
  const secrets = secretStates();
  for (const p of cfg.llm.profiles) {
    const s = secrets[p.id];
    p.hasKey = !!(s && s.present);
    p.keyHint = s ? s.hint : '';
    // 这条不是"有没有密钥"，而是"这把密钥像不像真的" —— 见 looksLikePlaceholderKey。
    p.keyIsPlaceholder = !!(s && s.fake);
  }
  cfg.app = cfg.app || {};
  cfg.app.encryptionAvailable = secrets.__encryptionAvailable;
  cfg.app.plaintextFallback = secrets.__plaintextFallback;
  return cfg;
}

/** 供 supervisor 使用：不带上层的展示字段，但带解密后的密钥（只在主进程内流动） */
export function configForRun() {
  return normalizeConfig(loadConfigRaw());
}

export function makeFirstRunBackup() {
  if (fs.existsSync(CONFIG_FILE)) return false;
  ensureDirs();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(defaultConfig(), null, 2), 'utf8');
  return true;
}

export { newId, DEFAULT_RULES };
