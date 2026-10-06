// runner/personas/index.mjs
// 人格面具预设库（契约见 docs/07 第九节）。
// 职责：读同目录下的 6 份 JSON 预设；给 UI 提供卡片元数据；给引擎侧提供可直接使用的 systemPrompt。
// 注意：路径一律用 import.meta.url 推导，绝不用 process.cwd()（打包后 cwd 不可靠）。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 本文件所在目录，即 runner/personas/。 */
const PERSONA_DIR = dirname(fileURLToPath(import.meta.url));

/** 固定顺序：personaIds、listPersonas() 都按这个顺序，不受文件系统返回顺序影响。 */
const PERSONA_IDS = Object.freeze([
  'companion-gentle',
  'companion-lively',
  'butler',
  'explorer',
  'builder',
  'quiet',
]);

/** 占位符缺值时的兜底，保证替换后绝不残留 {{...}}。 */
const FALLBACKS = Object.freeze({
  botDisplayName: '小助手',
  ownerName: '主人',
  language: 'zh',
});

/** 允许出现在 systemPrompt 里的占位符白名单；写错名字在加载时就报错，而不是把占位符漏给模型。 */
const PLACEHOLDER_KEYS = Object.freeze(Object.keys(FALLBACKS));

/** 每份预设必须有的字段。 */
const REQUIRED_FIELDS = Object.freeze([
  'id',
  'label',
  'description',
  'tags',
  'traits',
  'systemPrompt',
  'examples',
]);

const VERBOSITY_VALUES = Object.freeze(['short', 'medium', 'long']);

/**
 * 每次都新建正则：/g 正则自带 lastIndex 状态，复用会互相污染。
 * 用 [{] / [}] 代替反斜杠转义，等价且更不容易写错。
 */
function placeholderRegex() {
  return new RegExp('[{][{][ \t]*([A-Za-z0-9_.-]+)[ \t]*[}][}]', 'g');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function fail(message) {
  throw new Error('[personas] ' + message);
}

function describeError(err) {
  return err && err.message ? err.message : String(err);
}

/** 加载期校验：字段齐全、id 与文件名一致、占位符在名单内、examples 是短句对。 */
function assertPersona(data, file) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    fail(file + ' 的顶层必须是一个 JSON 对象');
  }
  for (const key of REQUIRED_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(data, key)) fail(file + ' 缺少必需字段：' + key);
  }
  for (const key of ['id', 'label', 'description', 'systemPrompt']) {
    if (typeof data[key] !== 'string' || data[key].trim() === '') fail(file + ' 的 ' + key + ' 必须是非空字符串');
  }
  if (!Array.isArray(data.tags)) fail(file + ' 的 tags 必须是字符串数组');
  if (!Array.isArray(data.examples) || data.examples.length === 0) fail(file + ' 的 examples 必须是非空数组');
  data.examples.forEach((ex, i) => {
    if (!ex || typeof ex.user !== 'string' || typeof ex.assistant !== 'string') {
      fail(file + ' 的 examples[' + i + '] 需要 user / assistant 两个字符串字段');
    }
  });

  const traits = data.traits;
  if (!traits || typeof traits !== 'object' || Array.isArray(traits)) fail(file + ' 的 traits 必须是对象');
  if (typeof traits.tone !== 'string' || traits.tone.trim() === '') fail(file + ' 的 traits.tone 必须是非空字符串');
  if (!VERBOSITY_VALUES.includes(traits.verbosity)) {
    fail(file + ' 的 traits.verbosity 只能是 ' + VERBOSITY_VALUES.join(' / '));
  }
  for (const key of ['humor', 'initiative']) {
    const v = traits[key];
    if (!Number.isInteger(v) || v < 0 || v > 5) fail(file + ' 的 traits.' + key + ' 必须是 0-5 的整数');
  }
  if (typeof traits.addressStyle !== 'string' || traits.addressStyle.trim() === '') {
    fail(file + ' 的 traits.addressStyle 必须是非空字符串');
  }

  // 占位符白名单：未知名字在加载期就炸，避免把 {{xxx}} 原样喂给模型。
  const used = new Set();
  const re = placeholderRegex();
  let m;
  while ((m = re.exec(data.systemPrompt)) !== null) used.add(m[1]);
  for (const name of used) {
    if (!PLACEHOLDER_KEYS.includes(name)) fail(file + ' 使用了未知占位符 {{' + name + '}}');
  }
}

/** 同步读六份 JSON。任何一份坏了都立刻抛错 —— 静默跳过会让某张卡片从 UI 上凭消失。 */
function loadPersonas() {
  return PERSONA_IDS.map((id) => {
    const file = join(PERSONA_DIR, id + '.json');
    let raw;
    try {
      raw = readFileSync(file, 'utf8');
    } catch (err) {
      fail('读不到预设文件 ' + file + '：' + describeError(err));
    }
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // 兜掉 BOM，JSON.parse 不认它
    let data;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      fail(file + ' 不是合法 JSON：' + describeError(err));
    }
    assertPersona(data, file);
    if (data.id !== id) fail(file + ' 里的 id 是 ' + data.id + '，与文件名不一致');
    return data;
  });
}

/** 模块加载时一次性载入的内存表，之后全部只读访问。 */
const PERSONAS = loadPersonas();
const PERSONA_BY_ID = new Map(PERSONAS.map((p) => [p.id, p]));

/** 面具 id 数组，顺序与 listPersonas() 一致。 */
export const personaIds = PERSONAS.map((p) => p.id);

/**
 * UI 列卡片用：去掉 systemPrompt 与 examples 的元数据数组，按固定顺序返回。
 * 返回深拷贝，调用方怎么改都不会污染预设表。
 */
export function listPersonas() {
  return PERSONAS.map((p) => {
    const meta = clone(p);
    delete meta.systemPrompt;
    delete meta.examples;
    return meta;
  });
}

/** 取完整预设（含 systemPrompt 与 examples）；找不到返回 null。 */
export function getPersona(id) {
  if (typeof id !== 'string') return null;
  const hit = PERSONA_BY_ID.get(id.trim());
  return hit ? clone(hit) : null;
}

/** ctx 取值：非空字符串优先，其次有限数字，最后兜底。 */
function readCtx(ctx, key) {
  const raw = ctx && typeof ctx === 'object' ? ctx[key] : undefined;
  if (typeof raw === 'string' && raw.trim() !== '') return raw.trim();
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  return FALLBACKS[key];
}

/**
 * 把 ctx（{ botDisplayName, ownerName, language }）填进 systemPrompt 的 {{...}} 占位符。
 * 保证返回值：不含任何 {{...}}、每行无尾随空格、首尾已 trim。
 * persona 传对象或面具 id 都可以；传别的会抛 TypeError（这是调用方的编程错误，不该静默吞掉）。
 */
export function buildSystemPrompt(persona, ctx = {}) {
  let target = persona;
  if (typeof persona === 'string') target = getPersona(persona);
  if (!target || typeof target !== 'object' || typeof target.systemPrompt !== 'string') {
    throw new TypeError('[personas] buildSystemPrompt(persona, ctx) 需要一个带 systemPrompt 的面具对象或面具 id');
  }

  const values = {};
  for (const key of PLACEHOLDER_KEYS) values[key] = readCtx(ctx, key);

  let out = target.systemPrompt.replace(placeholderRegex(), (whole, name) => (
    Object.prototype.hasOwnProperty.call(values, name) ? values[name] : whole
  ));
  // 第二道兜底：万一还有没登记的占位符（正常不会发生），也清掉，绝不漏给模型。
  out = out.replace(placeholderRegex(), '');
  out = out.replace(/[ ]{2,}/g, ' ').replace(/[ \t]+$/gm, '');
  return out.trim();
}

// docs/07 第一节把这里写作 buildPrompt()，第九节的契约名是 buildSystemPrompt()；两个名字指向同一实现。
export { buildSystemPrompt as buildPrompt };
