// devtools/register-electron-stub.mjs
// 只有一件事：注册上面的解析钩子。写成一个独立文件是因为 --import 传的必须是
// 一个副作用模块，钩子要在被测模块被加载之前就位。
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
register('./electron-loader.mjs', pathToFileURL(path.join(HERE, 'electron-loader.mjs')).href);
