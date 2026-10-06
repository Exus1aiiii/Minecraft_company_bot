// ============================================================================
// 把 runtime\config.json 恢复成"用户视角的出厂状态"
//
// 为什么要单独写一个脚本：无头自检为了让 supervisor 起进程，必须把配置真的
// 落盘成"指向本地假模型"，跑完再还原。但如果测试被中途打断（比如管道的
// Select-Object -First N 把进程提前掐了），还原那一步就跑不到，用户的
// runtime\config.json 里就会留下 http://127.0.0.1:8799/v1 和测试用的第二个
// bot —— 用户一打开应用会以为自己的 API 地址坏了。
//
// 这个脚本是那种情况下的兜底。用 Node 读写（不用 PowerShell 的 Get-Content，
// 它的默认代码页会把 UTF-8 中文读成乱码）。
//
// 用法：
//   node tools/fix-config.mjs          # 只看现状，不改
//   node tools/fix-config.mjs --apply  # 真的修
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.dirname(HERE);
const CONFIG_FILE = path.join(PROJECT_ROOT, 'runtime', 'config.json');

const APPLY = process.argv.includes('--apply');

// 官方的 provider 预设 —— 与 app/electron/store.mjs 的 PROVIDER_PRESETS 一致
const OFFICIAL = {
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  qwen: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  ollama: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b' },
};

// 与 app/electron/store.mjs 的 DEFAULT_RULES 一致
const DEFAULT_RULES = [
  { id: 'follow', enabled: true, patterns: ['跟着我', '跟紧我', '跟我来', '跟上我'], action: 'followPlayer' },
  { id: 'stop', enabled: true, patterns: ['停下', '别动', '站住', '停一下'], action: 'stop' },
  { id: 'come', enabled: true, patterns: ['过来', '来我这', '来我身边'], action: 'goToPlayer' },
  { id: 'inventory', enabled: true, patterns: ['你背包里有什么', '看看背包'], action: 'inventory' },
  { id: 'where', enabled: true, patterns: ['你在哪', '报坐标'], action: 'stats' },
];

if (!fs.existsSync(CONFIG_FILE)) {
  console.log('runtime\\config.json 不存在，没什么可修的。');
  process.exit(0);
}

const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
const cfg = JSON.parse(raw);

const changes = [];

// ① 被测试改成假模型的 profile
for (const p of cfg.llm?.profiles || []) {
  const want = OFFICIAL[p.id];
  if (!want) continue;
  if (p.baseUrl !== want.baseUrl) {
    changes.push(`llm "${p.id}" 的 baseUrl：${p.baseUrl} → ${want.baseUrl}`);
    if (APPLY) p.baseUrl = want.baseUrl;
  }
  if (p.model !== want.model) {
    changes.push(`llm "${p.id}" 的 model：${p.model} → ${want.model}`);
    if (APPLY) p.model = want.model;
  }
}

// ② 测试塞进去的第二个 bot —— 不删，而是把它修成一个**正经的演示 bot**。
//    理由：用户的原始需求是"可多服务器并行"，配置里有两个 bot 时，一打开
//    界面就能看见并行长什么样；但测试版留了一堆痕迹（规则表被清空、
//    enabled=true），那些必须补回来。
const DEMO_BOT_ID = 'bot-axiao';
for (const b of cfg.bots || []) {
  if (b.id !== DEMO_BOT_ID) continue;
  if ((b.rules || []).length === 0) {
    changes.push(`bot "${b.id}" 的规则表是空的（测试时故意清空以便计数）→ 补回默认 5 条`);
    if (APPLY) b.rules = JSON.parse(JSON.stringify(DEFAULT_RULES));
  }
}

// ③ 测试留下的 enabled=true —— 用户没要求开机自动启动
for (const b of cfg.bots || []) {
  if (b.enabled === true) {
    changes.push(`bot "${b.id}" 的 enabled：true → false（你没说要开机自动启动）`);
    if (APPLY) b.enabled = false;
  }
}

if (changes.length === 0) {
  console.log('✓ runtime\\config.json 是干净的，无需修改。');
  process.exit(0);
}

console.log(APPLY ? '将做以下修改：' : '发现以下问题（加 --apply 才会真的改）：');
for (const c of changes) console.log('  · ' + c);

if (!APPLY) {
  console.log('\n当前内容：');
  console.log(JSON.stringify(cfg, null, 2));
  process.exit(0);
}

// 先备份再原子写回
const backup = CONFIG_FILE + '.before-fix';
fs.writeFileSync(backup, raw, 'utf8');
const tmp = CONFIG_FILE + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
fs.renameSync(tmp, CONFIG_FILE);

const verify = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
console.log('\n✓ 已修好。');
console.log(`  profile 数：${verify.llm.profiles.length}，bot 数：${verify.bots.length}`);
for (const p of verify.llm.profiles) console.log(`  · ${p.id.padEnd(8)} ${p.baseUrl}  (${p.model})`);
for (const b of verify.bots) console.log(`  · ${b.id.padEnd(14)} ${b.displayName}  唤醒名 ${JSON.stringify(b.wakeNames)}  enabled=${b.enabled}`);
console.log(`\n  原文件已备份到 ${path.basename(backup)}`);
