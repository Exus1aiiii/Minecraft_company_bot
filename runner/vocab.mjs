// 中文意图词典：把"砍点木头""挖二十个石头"翻译成引擎能吃的方块 id 与数量。
//
// 为什么需要这个文件：引擎的 !collectBlocks(type, num) 里 type 是 BlockName，
// 而 commands/index.js 对 BlockName 的校验是**精确匹配** getBlockId(arg)
// （只对 plank/seed 后缀做了补 s 的小容错），拿中文进去必然报 Invalid block type。
// 所以中文 → minecraft 方块 id 的翻译只能在我们这一层做。
//
// 设计原则：宁可认不出（返回 null，退回大模型），也不要猜错。
// 猜错的代价是 bot 兴冲冲跑去挖一堆用户没要的东西，而用户只能看着。

/**
 * 中文方块词典。
 * words 里**越长越具体的词优先**（resolveBlock 按词长降序匹配），
 * 所以 "钻石" 不会被 "石" 抢走，"铁矿石" 不会被 "铁矿" 抢走。
 * defaultCount 是这个词条没写数量时的默认采集数。
 */
export const BLOCK_WORDS = [
  // ── 木头（按树种分开，引擎要求精确方块名）──
  { block: 'oak_log', label: '橡木', words: ['橡木', '橡树', '木头', '原木', '木材', '砍树', '棵树'], defaultCount: 10 },
  { block: 'spruce_log', label: '云杉', words: ['云杉'], defaultCount: 10 },
  { block: 'birch_log', label: '白桦', words: ['白桦', '桦木', '桦树'], defaultCount: 10 },
  { block: 'jungle_log', label: '丛林原木', words: ['丛林原木', '丛林木'], defaultCount: 10 },
  { block: 'acacia_log', label: '金合欢', words: ['金合欢'], defaultCount: 10 },
  { block: 'dark_oak_log', label: '深色橡木', words: ['深色橡木'], defaultCount: 10 },
  { block: 'oak_planks', label: '木板', words: ['木板'], defaultCount: 16 },

  // ── 石头类。注意：挖 stone 得到的是圆石，所以"挖石头"要指 stone 方块本身。
  //    要圆石则是去找世界里现成的圆石方块（洞穴、遗迹里才有），语义不同，分开列。──
  { block: 'stone', label: '石头', words: ['石头', '石块', '挖点石', '挖石'], defaultCount: 20 },
  { block: 'cobblestone', label: '圆石', words: ['圆石', '鹅卵石'], defaultCount: 20 },
  { block: 'deepslate', label: '深板岩', words: ['深板岩', '深层石'], defaultCount: 20 },
  { block: 'dirt', label: '泥土', words: ['泥土', '挖土'], defaultCount: 20 },
  { block: 'grass_block', label: '草方块', words: ['草方块'], defaultCount: 16 },
  { block: 'sand', label: '沙子', words: ['沙子', '沙块'], defaultCount: 20 },
  { block: 'gravel', label: '砂砾', words: ['砂砾', '砾石'], defaultCount: 16 },
  { block: 'clay', label: '黏土', words: ['黏土', '粘土'], defaultCount: 16 },
  { block: 'snow_block', label: '雪块', words: ['雪块', '挖雪'], defaultCount: 16 },

  // ── 矿物。找的是"矿石方块"，挖下去掉的是矿物 ──
  { block: 'coal_ore', label: '煤矿', words: ['煤矿', '煤炭', '挖煤', '煤'], defaultCount: 16 },
  { block: 'iron_ore', label: '铁矿', words: ['铁矿石', '铁矿', '挖铁'], defaultCount: 12 },
  { block: 'copper_ore', label: '铜矿', words: ['铜矿石', '铜矿', '挖铜'], defaultCount: 12 },
  { block: 'gold_ore', label: '金矿', words: ['金矿石', '金矿', '挖金'], defaultCount: 8 },
  { block: 'diamond_ore', label: '钻石矿', words: ['钻石矿石', '钻石矿', '钻石', '挖钻石'], defaultCount: 6 },
  { block: 'redstone_ore', label: '红石矿', words: ['红石矿石', '红石矿', '红石'], defaultCount: 12 },
  { block: 'lapis_ore', label: '青金石矿', words: ['青金石矿石', '青金石'], defaultCount: 8 },
  { block: 'emerald_ore', label: '绿宝石矿', words: ['绿宝石矿石', '绿宝石'], defaultCount: 6 },

  // ── 农牧与其它 ──
  { block: 'wheat', label: '小麦', words: ['小麦', '麦子', '收麦'], defaultCount: 16 },
  { block: 'carrots', label: '胡萝卜', words: ['胡萝卜'], defaultCount: 16 },
  { block: 'potatoes', label: '马铃薯', words: ['马铃薯', '土豆'], defaultCount: 16 },
  { block: 'beetroots', label: '甜菜', words: ['甜菜'], defaultCount: 16 },
  { block: 'sugar_cane', label: '甘蔗', words: ['甘蔗'], defaultCount: 16 },
  { block: 'bamboo', label: '竹子', words: ['竹子'], defaultCount: 16 },
  { block: 'cactus', label: '仙人掌', words: ['仙人掌'], defaultCount: 12 },
  { block: 'pumpkin', label: '南瓜', words: ['南瓜'], defaultCount: 8 },
  { block: 'melon', label: '西瓜', words: ['西瓜'], defaultCount: 8 },
  { block: 'sweet_berry_bush', label: '甜浆果', words: ['甜浆果', '浆果'], defaultCount: 12 },
  { block: 'nether_quartz_ore', label: '下界石英', words: ['下界石英', '石英'], defaultCount: 12 },
  { block: 'obsidian', label: '黑曜石', words: ['黑曜石'], defaultCount: 4 },
  { block: 'glowstone', label: '荧石', words: ['荧石', '萤石'], defaultCount: 8 },
];

/** 按词长降序排好的 (word, entry) 表，模块加载时算一次。 */
const WORD_INDEX = BLOCK_WORDS
  .flatMap((entry) => (entry.words || []).map((w) => ({ word: w, entry })))
  .sort((a, b) => b.word.length - a.word.length);

/** 数量单位。用来判断"这个数字是不是在说数量"，避免把坐标当成数量。 */
const COUNT_UNITS = '个块棵根组份条摞颗株';

/** 中文数字（1–99 够用：没人会叫 bot 挖一百三十七个方块）。 */
const CN_DIGIT = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** "一点儿/一些/几个"这类模糊量词 —— 表示"随便来点"，不是精确数量。 */
const VAGUE_WORDS = ['一点', '一些', '几个', '几块', '几棵', '少量', '一两个'];

/** 坐标三元组（"去 100 64 200"）—— 这三个数字不是数量，扫描前先抠掉。 */
const COORD_TRIPLE = /-?\d{1,5}\s*[ ,，]\s*-?\d{1,5}\s*[ ,，]\s*-?\d{1,5}/g;

/**
 * 模糊量词里的那个数字不表示数量。
 * 「收一下小麦」「采一点木头」「等我一会儿」—— 这里的"一"是词的一部分，
 * 把它当成"1 个"是最容易犯、也最难被用户理解的一种错。
 */
const VAGUE_NUMERAL = /[一二两三四五六七八九十]\s*(?:点|些|下|会儿|阵|起|直|块儿)/g;

/**
 * 解析数量。返回 null 表示"这句话里没提数量"，由调用方决定默认值。
 * 两种写法都认：「挖 20 个石头」「挖二十个石头」。
 */
export function parseCount(text) {
  const raw = String(text || '');
  if (!raw) return null;

  const s = raw.replace(COORD_TRIPLE, ' ').replace(VAGUE_NUMERAL, ' ');

  // ① 阿拉伯数字 + 量词（最可靠）
  const withUnit = s.match(new RegExp(`(\\d{1,4})\\s*[${COUNT_UNITS}]`));
  if (withUnit) {
    const n = Number(withUnit[1]);
    if (Number.isFinite(n) && n > 0) return clampCount(n);
  }

  // ② 中文数字 + 量词
  const cnUnit = s.match(new RegExp(`([一二两三四五六七八九十]{1,3})\\s*[${COUNT_UNITS}]`));
  if (cnUnit) {
    const n = cnToNumber(cnUnit[1]);
    if (n) return clampCount(n);
  }

  // ③ 孤零零的阿拉伯数字（"挖 20 石头" 没量词）。
  //    这里**只认阿拉伯数字**：中文单字数字在自然语句里太容易是词的一部分
  //    （一起 / 一下 / 一点 / 一片），误判的代价远大于收益。中文数字要带量词才认。
  const bare = s.match(/\d{1,4}/g);
  if (bare) {
    for (const token of bare) {
      const n = Number(token);
      if (n >= 1 && n <= 999) return clampCount(n);
    }
  }
  return null;
}

function clampCount(n) {
  return Math.max(1, Math.min(Math.round(n), 999));
}

/** 「二十三」→ 23，「十」→ 10，「三」→ 3。认不出、或解析出 0，一律返回 null。 */
export function cnToNumber(token) {
  const t = String(token || '').trim();
  if (!t) return null;
  if (t === '十') return 10;
  if (t.length === 1) return CN_DIGIT[t] || null;
  const m = t.match(/^([一二两三四五六七八九])?十([一二三四五六七八九])?$/);
  if (m) {
    const tens = m[1] ? CN_DIGIT[m[1]] : 1;
    const ones = m[2] ? CN_DIGIT[m[2]] : 0;
    return tens * 10 + ones;
  }
  return null;
}

/** 这句话里有没有"随便来点"的模糊说法。 */
export function isVague(text) {
  const s = String(text || '');
  return VAGUE_WORDS.some((w) => s.includes(w));
}

/**
 * 从句子里认出要采的方块。认不出返回 null（调用方应退回大模型）。
 * 返回 { block, label, word, defaultCount }。
 */
export function resolveBlock(text) {
  const s = String(text || '');
  if (!s) return null;
  for (const { word, entry } of WORD_INDEX) {
    if (s.includes(word)) {
      return { block: entry.block, label: entry.label, word, defaultCount: entry.defaultCount ?? 10 };
    }
  }
  return null;
}

/**
 * 把一句中文变成一次采集意图。
 * 返回 { block, label, count, word } 或 null。
 */
export function parseCollectIntent(text) {
  const hit = resolveBlock(text);
  if (!hit) return null;
  const explicit = parseCount(text);
  // 说了"一点儿/一些"又不给数字 → 用比默认更小的量，别让 bot 一去半小时
  const count = explicit ?? (isVague(text) ? Math.max(1, Math.round(hit.defaultCount / 3)) : hit.defaultCount);
  return { block: hit.block, label: hit.label, count, word: hit.word };
}

/** 给日志/界面用的一句话描述。 */
export function describeCollect(intent) {
  return intent ? `${intent.label} × ${intent.count}（${intent.block}）` : '认不出要采什么';
}
