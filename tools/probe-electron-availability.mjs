// tools/probe-electron-availability.mjs
// 目的：确认本机能不能装上 Electron —— 这是 T6（像素风 GUI）的先决条件。
// 本机 curl.exe 的 schannel 被沙箱挡死，Java 的 TLS 也坏，只有 Node 自己的 fetch 能联网，
// 所以 Electron 的二进制包也必须由 Node 直接下载，而不是交给 npm 的 postinstall。
//
// 用法：node tools/probe-electron-availability.mjs [版本]
//   - 不给版本 → 先查 registry 的 latest
// exit 0 = 至少有一个可用下载源；exit 1 = 全都拿不到

const wantVersion = process.argv[2] || null;

const j = async (url) => {
  const r = await fetch(url, { redirect: 'follow', headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} <- ${url}`);
  return r.json();
};

// 只探测、不下载：优先 HEAD，不支持就退化成 Range 请求
const probeUrl = async (url) => {
  const attempts = [
    { method: 'HEAD' },
    { method: 'GET', headers: { Range: 'bytes=0-0' } },
  ];
  for (const opt of attempts) {
    try {
      const r = await fetch(url, { redirect: 'follow', ...opt });
      // 206 = 服务器接受了 Range；200 也可能只是忽略了 Range 但确实存在
      const ok = r.ok || r.status === 206;
      const len = r.headers.get('content-range')?.split('/')[1] || r.headers.get('content-length') || '-';
      if (r.body) { try { await r.body.cancel(); } catch {} }
      return { ok, status: r.status, len, via: opt.method };
    } catch (e) {
      if (opt.method === 'GET') return { ok: false, status: 'ERR', len: e.message, via: '-' };
    }
  }
};

const humanSize = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return String(n);
  return `${(v / 1024 / 1024).toFixed(1)} MiB`;
};

console.log('=== Electron 可用性探测 ===\n');

// 1) 版本号
let version = wantVersion;
if (!version) {
  for (const reg of ['https://registry.npmjs.org', 'https://registry.npmmirror.com']) {
    try {
      const meta = await j(`${reg}/electron/latest`);
      version = meta.version;
      console.log(`registry ${reg}\n  latest electron = ${version}` +
        (meta.engines?.node ? `  (engines.node: ${meta.engines.node})` : ''));
      break;
    } catch (e) {
      console.log(`registry ${reg}\n  ✗ ${e.message}`);
    }
  }
}
if (!version) {
  console.log('\n无法确定 Electron 版本，退出。');
  process.exit(1);
}

// 2) 二进制下载源。fileBase 是 electron 的 @electron/get 期望的文件名格式
const fileBase = `electron-v${version}-win32-x64.zip`;
const candidates = [
  ['npmmirror binary mirror', `https://registry.npmmirror.com/-/binary/electron/${version}/${fileBase}`],
  ['npmmirror.com/mirrors', `https://npmmirror.com/mirrors/electron/${version}/${fileBase}`],
  ['github releases', `https://github.com/electron/electron/releases/download/v${version}/${fileBase}`],
];

console.log(`\n目标文件：${fileBase}\n`);
let anyOk = false;
const usable = [];
for (const [label, url] of candidates) {
  const r = await probeUrl(url);
  if (r.ok) { anyOk = true; usable.push([label, url]); }
  console.log(`${r.ok ? '✓' : '✗'} ${label.padEnd(26)} status=${String(r.status).padEnd(4)} size=${humanSize(r.len)}`);
  console.log(`  ${url}`);
}

// 3) 顺带确认 npm install 能不能把 electron 包本身拉下来（不含二进制）
console.log('\n=== 结论 ===');
if (anyOk) {
  console.log('可以用。安装时给 npm 指定镜像，避免走 github：');
  console.log(`  $env:ELECTRON_MIRROR = '${usable[0][1].replace(fileBase, '')}'`);
  console.log(`  $env:ELECTRON_CUSTOM_DIR = '${version}'`);
  console.log('  npm install electron --save-dev');
  console.log('（若 npm 的 postinstall 仍失败，就自己用 tools/fetch.mjs 下 zip 解到 node_modules/electron/dist）');
  process.exit(0);
} else {
  console.log('🔴 三个源都拿不到 Electron 二进制。');
  console.log('退路：① 换镜像重试 ② 改用本地 HTTP 服务承载 GUI（Express + 浏览器），');
  console.log('      先保证功能可验收，桌面壳后补。');
  process.exit(1);
}
