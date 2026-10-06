/**
 * tools/sync-launch.mjs —— 把 runner/bots/*.launch.json 的规则表同步成
 * app/electron/store.mjs 的 DEFAULT_RULES。
 *
 * 为什么需要它：`runner/bots/<name>.launch.json` 是**脱离 Electron 手测引擎**用的
 * 静态 spec（正常路径下 spec 由 app/electron/launcher.mjs 按配置现生成，那份永远
 * 跟得上）。规则表一旦加了新条目，静态 spec 就会落后 —— 于是手测时"记住…"没反应，
 * 而界面里明明有这条规则。与其每次手抄，不如让脚本去 store.mjs 里取唯一事实来源。
 *
 * ★ 同样的问题也发生在**服务器地址**上：在界面里把 bot 换到另一台服务器，
 *   静态 spec 还指着旧地址，手测就连去了旧服（而且看不出来 —— 两边都是
 *   "登录成功"）。所以 server 也从 config.json 现取。
 *
 * 必须带 electron 的假模块跑（store.mjs 会 import electron 的 safeStorage）：
 *   node --import ./devtools/register-electron-stub.mjs tools\sync-launch.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_RULES, loadConfigRaw } from '../app/electron/store.mjs';
import { BOTS_DIR } from '../app/electron/paths.mjs';

const files = fs.existsSync(BOTS_DIR)
    ? fs.readdirSync(BOTS_DIR).filter((f) => f.endsWith('.launch.json'))
    : [];

if (files.length === 0) {
    console.log(`没找到 launch spec（${BOTS_DIR}）`);
    process.exit(0);
}

const cfg = loadConfigRaw();
const serverById = new Map((cfg.servers || []).map((s) => [s.id, s]));
const botById = new Map((cfg.bots || []).map((b) => [b.id, b]));

let changed = 0;
for (const f of files) {
    const full = path.join(BOTS_DIR, f);
    const spec = JSON.parse(fs.readFileSync(full, 'utf8'));
    // ★ 比的是**整张规则表**，不只是 id 列表。
    //   只比 id 的话，改了某条规则的 patterns 也会被判成"已是最新"，
    //   于是手测时新加的话头一句话都不认 —— 而界面里明明写着。
    const before = JSON.stringify({ rules: spec.rules || [], server: spec.server || null, owners: spec.owners || null });
    const ids = (spec.rules || []).map((r) => r.id).join(',');
    spec.rules = DEFAULT_RULES
        .filter((r) => r.enabled)
        .map((r) => ({ ...r, patterns: [...r.patterns] }));

    // 服务器 / 主人：以 config.json 为准（找不到对应条目就原样保留，不瞎猜）
    const bot = botById.get(spec.botId);
    const srv = bot ? serverById.get(bot.serverId) : null;
    if (srv) {
        spec.server = { host: srv.host, port: srv.port, version: srv.version, auth: srv.auth };
    }
    if (bot?.owners?.length) spec.owners = [...bot.owners];

    const after = JSON.stringify({ rules: spec.rules, server: spec.server || null, owners: spec.owners || null });
    if (before === after) {
        console.log(`= ${f} 已是最新（${ids}；server=${spec.server?.host}:${spec.server?.port}）`);
        continue;
    }
    const tmp = `${full}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(spec, null, 2), 'utf8');
    fs.renameSync(tmp, full);
    changed++;
    console.log(`✓ ${f}`);
    console.log(`    规则: ${ids} → ${spec.rules.map((r) => r.id).join(',')}`);
    console.log(`    服务器: ${spec.server?.host}:${spec.server?.port}（版本 ${spec.server?.version}，${spec.server?.auth}）`);
}
console.log(changed ? `\n同步了 ${changed} 个文件。` : '\n全部已是最新。');
