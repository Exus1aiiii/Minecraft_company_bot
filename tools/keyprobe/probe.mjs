// tools/keyprobe/probe.mjs
// 一次性探针（不是产品代码）：回答"用户说他填好 API Key 了，到底算不算数"。
//
// 跑法（**不要**带 electron stub 的 NODE_OPTIONS，也不要带 ELECTRON_RUN_AS_NODE）：
//   app\node_modules\electron\dist\electron.exe tools\keyprobe --no-sandbox
// 结果写在 tools\keyprobe\key-verify-report.txt（同时打一份到 stdout，但 GUI 子系统
// 程序在某些启动方式下 stdout 是空的，所以**以文件为准**）。
//
// 它做三件事：
//   ① 把密钥解出来看一眼形态（只看长度和首尾，绝不打印明文）
//   ② 检查 UI 对象里有没有漏明文（安全不变量）
//   ③ 真的调一次 DeepSeek（max_tokens=1，花费可以忽略），确认这把 Key 能用
//
// ★ 三个坑，都是真踩出来的，所以这个文件长这样：
//   ① 默认 userData 在 %APPDATA% 下，本执行环境的文件沙箱不让写 → 脚本刚跑起来就
//      0xC0000005 崩掉，连 app.whenReady() 都不触发、也不留错误信息。
//      必须像真应用（app\electron\main.mjs:35-37）那样把 userData 收进项目里。
//   ② 而且必须指向**真应用用的那个目录**（runtime\electron-userdata）：
//      safeStorage 的解密材料跟着 userData 走，换个目录就解不开用户存的那条密文
//      （症状是 hasKey=false、看起来像"用户没保存"，其实是探针找错了钥匙串）。
//   ③ 结果写文件、不指望 stdout：Windows 上 electron.exe 是 GUI 子系统程序，
//      用 `*> log` 重定向也是 0 字节。
//
// 另外记录一条死路：试过用 PowerShell 的 ProtectedData.Unprotect 直接解，
// CurrentUser / LocalMachine × 有无熵四种组合全是 "The data is invalid" —— 走不通。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, safeStorage } from 'electron';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..', '..');

// 见上面 ★②：必须和真应用用同一个 userData，否则解不开
const USERDATA = path.join(PROJECT_ROOT, 'runtime', 'electron-userdata');
fs.mkdirSync(USERDATA, { recursive: true });
app.setPath('userData', USERDATA);
app.setPath('sessionData', USERDATA);

const REPORT = path.join(HERE, 'key-verify-report.txt');
const lines = [];
const line = (s) => { lines.push(s); try { process.stdout.write(s + '\n'); } catch { /* GUI 子系统 */ } };
const flush = () => { try { fs.writeFileSync(REPORT, lines.join('\r\n') + '\r\n', 'utf8'); } catch { /* ignore */ } };

process.on('uncaughtException', (e) => { line(`未捕获异常：${e?.stack || e}`); flush(); app.exit(9); });
process.on('unhandledRejection', (e) => { line(`未处理的 Promise 拒绝：${e?.stack || e}`); flush(); app.exit(9); });

const watchdog = setTimeout(() => { line('超时 60 秒 —— 强制退出'); flush(); app.exit(5); }, 60000);

app.whenReady().then(async () => {
  let code = 0;
  try {
    const store = await import('../../app/electron/store.mjs');
    line(`Electron ${process.versions.electron} / Node ${process.versions.node}`);
    line(`userData=${USERDATA}`);
    line(`safeStorage 可用=${safeStorage.isEncryptionAvailable()}`);

    const ui = store.loadConfigForUi();
    line('--- 模型页看到的状态 ---');
    for (const p of ui.llm.profiles) {
      line([p.id, p.label, 'hasKey=' + p.hasKey, 'fake=' + p.keyIsPlaceholder, 'hint=' + (p.keyHint || '-')].join('  '));
    }

    const profile = ui.llm.profiles.find((p) => p.id === 'deepseek') || ui.llm.profiles[0];
    const key = store.getSecret(profile.id);
    line('--- 解密结果 ---');
    line(`profile=${profile.id} baseUrl=${profile.baseUrl} model=${profile.model}`);
    if (!key) {
      line('密钥解不出来（getSecret 返回空）—— 没保存成功，或者换了 Windows 账户 / userData 目录。');
      code = 2;
    } else {
      line(`解出来了：长度=${String(key).length}，形态=${String(key).slice(0, 3)}…${String(key).slice(-4)}`);
      line(`看起来像假密钥吗：${store.looksLikePlaceholderKey(key) ? '是（可疑）' : '不是'}`);
      line(`UI 里会不会漏明文：${/sk-[A-Za-z0-9_-]{8,}/.test(JSON.stringify(ui)) ? '会（危险）' : '不会（安全）'}`);

      line('--- 真的调一次 DeepSeek（max_tokens=1，花费可以忽略）---');
      const t0 = Date.now();
      const res = await fetch(`${profile.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: profile.model,
          messages: [{ role: 'user', content: '只回一个字：好' }],
          max_tokens: 1,
          stream: false,
        }),
        signal: AbortSignal.timeout(30000),
      });
      const ms = Date.now() - t0;
      const text = await res.text();
      line(`HTTP ${res.status}（${ms}ms）`);
      if (!res.ok) {
        line(text.slice(0, 400));
        code = 3;
      } else {
        const j = JSON.parse(text);
        line(`回复：${JSON.stringify(j.choices?.[0]?.message?.content)}`);
        line(`用量：${JSON.stringify(j.usage)}`);
        const u = j.usage || {};
        line(`—— 成本校准：prompt=${u.prompt_tokens}（其中命中缓存 ${u.prompt_cache_hit_tokens ?? '接口未返回'}）、completion=${u.completion_tokens}`);
        line('这把 Key 能用。');
      }
    }
  } catch (err) {
    line(`探针自己出错：${err?.stack || err}`);
    code = 9;
  }
  clearTimeout(watchdog);
  line(`退出码=${code}`);
  flush();
  app.exit(code);
});
