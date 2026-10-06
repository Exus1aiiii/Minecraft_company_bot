// 一次性排查：读 !placeHere / !craftRecipe 的实现，看引擎自己怎么放置方块。
import fs from 'node:fs';
const ENGINE = 'D:/mc_company_bot/vendor/mindcraft-develop';
const s = fs.readFileSync(`${ENGINE}/src/agent/commands/actions.js`, 'utf8');
const lines = s.split(/\r?\n/);
lines.forEach((l, i) => {
  if (/name:\s*["']!(placeHere|craftRecipe|equip|digDown)["']/.test(l)) {
    console.log(`--- 行 ${i + 1}: ${l.trim()}`);
    console.log(lines.slice(i, i + 34).map((x, k) => `${i + k + 1}: ${x}`).join('\n'));
    console.log();
  }
});
