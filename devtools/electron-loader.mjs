// devtools/electron-loader.mjs
// Node 模块定制钩子：把所有 `import ... from 'electron'` 改指到 devtools/electron.mjs。
//
// 用法（由 devtools/headless-main.mjs 自己注册，无需手动传参）：
//   node --import ./devtools/register-electron-stub.mjs devtools/headless-main.mjs

import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STUB_URL = pathToFileURL(path.join(HERE, 'electron.mjs')).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'electron' || specifier === 'node:electron') {
    return { url: STUB_URL, shortCircuit: true, format: 'module' };
  }
  return nextResolve(specifier, context);
}
