// 一次性清理：把用户 runtime\secrets.json 里那条**早期自检写进去的假密钥**删掉。
//
// 为什么必须删：它让模型页显示成「已保存（sk-…fake）」，和真密钥长得一模一样 ——
// 用户会以为"密钥我填过了"，然后对着一个永远 401 的 bot 找原因。
// 删掉之后界面会诚实地写「还没保存密钥」，用户就知道该去填了。
//
// ★ 这个脚本只做一件有依据的事：确认那把密钥**确实是假的**（looksLikePlaceholderKey），
//   才删。万一是真密钥（哪怕形态奇怪），一律不动 —— 删除是不可逆的，
//   宁可留着一条碍眼的记录，也不能把用户真填进去的东西删掉。
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';

const ROOT = path.resolve(import.meta.dirname, '..');
const store = await import(pathToFileURL(path.join(ROOT, 'app', 'electron', 'store.mjs')).href);

const cfg = store.loadConfigRaw();
const states = store.secretStates();
let removed = 0;

for (const p of cfg.llm?.profiles ?? []) {
    const s = states[p.id];
    if (!s || !s.present) { console.log(`- ${p.id}：没有密钥，跳过`); continue; }
    if (!s.fake) { console.log(`- ${p.id}：${s.hint} 看着像真密钥，**不动它**`); continue; }
    console.log(`- ${p.id}：${s.hint} 判定为假密钥（早期自检留下的），删除`);
    store.clearSecret(p.id);
    removed++;
}
console.log(`\n删除了 ${removed} 条假密钥。`);
console.log('secrets.json 现在的内容：');
console.log(fs.readFileSync(path.join(ROOT, 'runtime', 'secrets.json'), 'utf8'));
