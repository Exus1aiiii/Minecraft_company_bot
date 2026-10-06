// tools/ping-server.mjs
// 机器可读的服务器探测：只输出**一行 JSON**，供主进程（app/electron/ipc.mjs）调用。
// 人类可读的那份是 tools/probe-server-ping.mjs（带诊断文字），两者用途不同，故意分开。
//
// 用法：node tools/ping-server.mjs <host> <port> [目标版本] [--out <文件>]
// 输出：{"ok":true,"version":"1.21.1","protocol":767,"motd":"...","players":{"online":0,"max":10}}
//   或  {"ok":false,"error":"..."}
//
// ★ --out：把结果写进文件而不是 stdout。Electron 主进程必须用这个模式 ——
//   受限沙箱下 Node 的 `stdio:'pipe'` 会 EPERM（打不开命名管道），所以主进程
//   一律"让子进程写文件、自己读文件"，绝不捕获管道输出。

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { applyEnginePatches } from '../runner/engine-patches.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.dirname(HERE);
const ENGINE_DIR = path.join(PROJECT_ROOT, 'vendor', 'mindcraft-develop');

const argv = process.argv.slice(2);
const outIdx = argv.indexOf('--out');
const outFile = outIdx >= 0 ? argv[outIdx + 1] : '';
const positional = outIdx >= 0 ? argv.filter((_, i) => i !== outIdx && i !== outIdx + 1) : argv;

const [host = '127.0.0.1', portArg = '25565', version = ''] = positional;
const port = Number(portArg) || 25565;

const out = (o) => {
  const line = JSON.stringify(o) + '\n';
  if (outFile) {
    try { fs.writeFileSync(outFile, line, 'utf8'); } catch (e) { process.stderr.write(String(e.message) + '\n'); }
  } else {
    process.stdout.write(line);
  }
  process.exit(o.ok ? 0 : 1);
};

// V-3 守卫：把 minecraft-protocol 的 defaultVersion 修正成 minecraft-data 认识的版本。
// 不修的话 mc.ping 会在 ping.js:26 抛 TypeError（这正是当初登录失败的根因）。
if (version) process.env.MCBOT_MC_VERSION = version;
try { applyEnginePatches(() => {}); } catch { /* 修正失败也继续，下面会报出真实错误 */ }

let mc;
try {
  const req = createRequire(path.join(ENGINE_DIR, 'package.json'));
  mc = req('minecraft-protocol');
} catch (e) {
  out({ ok: false, error: `引擎依赖加载失败：${e.message}` });
}

const timer = setTimeout(() => out({ ok: false, error: '探测超时（10 秒）——地址或端口可能不对，或被防火墙挡住' }), 10000);

try {
  mc.ping({ host, port }, (err, res) => {
    clearTimeout(timer);
    if (err) return out({ ok: false, error: String(err.message || err) });
    const v = res?.version || {};
    out({
      ok: true,
      version: v.name ?? null,
      protocol: v.protocol ?? null,
      motd: typeof res?.description === 'string'
        ? res.description
        : (res?.description?.text ?? res?.description?.translate ?? ''),
      players: { online: res?.players?.online ?? 0, max: res?.players?.max ?? 0 },
      latencyMs: res?.latency ?? null,
    });
  });
} catch (e) {
  clearTimeout(timer);
  out({ ok: false, error: String(e.message || e) });
}
