// tools/preview-server.mjs
// 开发期用：把 app\renderer\ 当静态站点伺服，让你**不装 Electron** 也能在浏览器里
// 看到界面长什么样。
//
// 为什么不能直接双击 index.html：渲染进程用的是 `<script type="module">`，
// 浏览器对 file:// 下的 ES 模块有 CORS 限制，直接打开会白屏。
//
// 这个页面会自动启用内置演示数据（mock.js），不会连服务器、不会烧 token。
//
// 用法：node tools/preview-server.mjs [port]

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ROOT = path.join(PROJECT_ROOT, 'app', 'renderer');
const PORT = Number(process.argv[2]) || 8899;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (rel === '/' || rel === '') rel = '/index.html';

  const target = path.join(ROOT, rel);
  // 防止 ../../ 越界
  if (!path.resolve(target).startsWith(path.resolve(ROOT))) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(target, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end(`找不到 ${rel}`);
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
    }).end(buf);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`界面预览已启动： http://127.0.0.1:${PORT}/`);
  console.log(`伺服目录：${ROOT}`);
  console.log('（演示数据模式，不会连接任何服务器、不会消耗 token。按 Ctrl+C 结束。）');
});
