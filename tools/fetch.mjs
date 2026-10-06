// 下载工具：绕开被沙箱阻断的 curl.exe(schannel)，改用 Node 自带 OpenSSL 的 fetch。
// 用法: node tools/fetch.mjs <url> <输出路径>
import { writeFile } from 'node:fs/promises';

const [url, out] = process.argv.slice(2);
if (!url || !out) {
  console.error('usage: node tools/fetch.mjs <url> <outFile>');
  process.exit(2);
}

const res = await fetch(url, { redirect: 'follow' });
if (!res.ok) {
  console.error(`HTTP ${res.status} ${res.statusText} <- ${url}`);
  process.exit(1);
}
const buf = Buffer.from(await res.arrayBuffer());
await writeFile(out, buf);
console.log(`saved ${out} (${(buf.length / 1048576).toFixed(2)} MiB) <- ${url}`);
