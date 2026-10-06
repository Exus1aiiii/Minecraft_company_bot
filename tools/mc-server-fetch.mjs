// 手工组装 Fabric 服务端（完全绕开 Java 的 TLS：所有下载都走 Node 的 fetch）
//
// 背景：本机 JRE 的默认 SSLContext 构造失败
//   java.security.NoSuchAlgorithmException: Error constructing implementation
//   (algorithm: Default, provider: SunJSSE, class: sun.security.ssl.SSLContextImpl$DefaultSSLContext)
//   Caused by: java.security.KeyManagementException: problem accessing trust store
// 于是 fabric-installer 与 fabric-server-launch.jar 都无法自己联网拉元数据/依赖。做法改为：
//   1) 用 Node 下载原版 server.jar
//   2) 用 Node 下载原版 version.json 里的全部 libraries
//   3) 用 Node 下载 fabric-loader 的全部 libraries
//   4) 用 Node 下载 fabric-server-launch.jar
// 这样 fabric 启动器在本地就能找齐所有依赖，全程不需要 Java 联网。
//
// 用法：node tools/mc-server-fetch.mjs [mcVersion] [outDir]
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const mcVersion = process.argv[2] || '1.21.1';
const outDir = process.argv[3] || 'D:\\mc_company_bot\\testserver';

async function get(url) {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status} <- ${url}`);
    return res;
}
async function getJson(url) { return (await get(url)).json(); }

let nOk = 0, nSkip = 0, nFail = 0;
async function save(url, dest, label) {
    try {
        const s = await stat(dest);
        if (s.size > 0) { nSkip++; return; }
    } catch {}
    try {
        const res = await get(url);
        const buf = Buffer.from(await res.arrayBuffer());
        await mkdir(dirname(dest), { recursive: true });
        await writeFile(dest, buf);
        nOk++;
        if (nOk % 20 === 0) console.log(`    ... ${nOk} downloaded`);
    } catch (e) {
        nFail++;
        console.log(`  !! FAIL ${label}: ${e.message}`);
    }
}

// Maven 坐标 -> 仓库相对路径
function mavenRel(name) {
    const [g, a, v] = name.split(':');
    return `${g.replace(/\./g, '/')}/${a}/${v}/${a}-${v}.jar`;
}

console.log(`=== 1) 原版服务端 ${mcVersion} ===`);
const manifest = await getJson('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json');
const ver = manifest.versions.find(v => v.id === mcVersion);
if (!ver) throw new Error(`version ${mcVersion} not found in manifest`);
const verJson = await getJson(ver.url);
const serverDl = verJson.downloads?.server;
if (!serverDl) throw new Error('no server download for this version');
console.log(`  server.jar size=${serverDl.size}`);
await save(serverDl.url, join(outDir, 'server.jar'), 'server.jar');
await writeFile(join(outDir, 'version.json'), JSON.stringify(verJson, null, 2));

console.log(`=== 2) 原版 libraries (${verJson.libraries.length}) ===`);
for (const lib of verJson.libraries) {
    const art = lib.downloads?.artifact;
    if (!art?.url) continue;                       // natives/classifiers 服务端不需要
    if (lib.name.includes(':natives-')) continue;
    await save(art.url, join(outDir, 'libraries', mavenRel(lib.name)), lib.name);
}

console.log(`=== 3) Fabric loader for ${mcVersion} ===`);
const loaders = await getJson(`https://meta.fabricmc.net/v2/versions/loader/${mcVersion}`);
const loader = (loaders.find(l => l.loader.stable) || loaders[0]).loader.version;
const installers = await getJson('https://meta.fabricmc.net/v2/versions/installer');
const installer = (installers.find(i => i.stable) || installers[0]).version;
console.log(`  loader=${loader} installer=${installer}`);

const profile = await getJson(`https://meta.fabricmc.net/v2/versions/loader/${mcVersion}/${loader}/profile/json`);
console.log(`  mainClass: ${profile.mainClass}`);
await writeFile(join(outDir, 'fabric-loader-profile.json'), JSON.stringify(profile, null, 2));

console.log(`=== 4) Fabric libraries (${profile.libraries.length}) ===`);
for (const lib of profile.libraries) {
    if (!lib.url || !lib.name) { console.log(`  ! 无 url，跳过: ${lib.name}`); continue; }
    await save(lib.url.replace(/\/$/, '') + '/' + mavenRel(lib.name), join(outDir, 'libraries', mavenRel(lib.name)), lib.name);
}

console.log(`=== 5) fabric-server-launch.jar ===`);
await save(`https://meta.fabricmc.net/v2/versions/loader/${mcVersion}/${loader}/${installer}/server/jar`,
    join(outDir, 'fabric-server-launch.jar'), 'fabric-server-launch.jar');

console.log(`=== 6) launcher properties / eula / server.properties ===`);
await writeFile(join(outDir, 'fabric-server-launcher.properties'),
    `serverJar=server.jar\n`);
await writeFile(join(outDir, 'eula.txt'),
    `# 由 tools/mc-server-fetch.mjs 生成：本机自建测试服，仅本地使用\neula=true\n`);
await writeFile(join(outDir, 'server.properties'), [
    'online-mode=false',          // 离线模式：用户决策 1
    'server-port=25565',
    'motd=MCBOT test server 1.21.1',
    'gamemode=survival',
    'difficulty=normal',
    'spawn-protection=0',         // 否则 bot 不能在出生点附近挖/放
    'max-players=10',
    'view-distance=8',
    'simulation-distance=6',
    'level-name=world',
    'allow-flight=true',          // bot 用 pathfinder 可能悬空
    'enable-command-block=true',
    'white-list=false',
    'enforce-secure-profile=false',
    'sync-chunk-writes=false',
    ''
].join('\n'));

console.log(`\n下载完成: 新增 ${nOk} 个 / 已存在 ${nSkip} 个 / 失败 ${nFail} 个`);
if (nFail > 0) process.exit(1);
console.log('DONE');
