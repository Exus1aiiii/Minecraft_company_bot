# 05 · Vendor 补丁与依赖锁定

> 适用版本：`vendor/mindcraft-develop/`（源自 `mindcraft-bots/mindcraft` @ `develop`，2026-10-05 快照）
> 本文件记录**我们对 vendored 引擎做过的每一处改动**。vendor 目录不是只读上游，任何改动都必须登记在此，否则下次同步上游时会静默丢失。

---

## 一、为什么必须锁依赖：上游的 lockfile 是缺失的

`vendor/mindcraft-develop/.gitignore` 第 4 行原本是 `package-lock.json`。也就是说**上游仓库不携带 lockfile**，`package.json` 里的 `^` 范围在每次全新安装时都会解析到当时的最新版。

后果在第一次安装时就撞上了：

| 包 | `patches/` 里的补丁目标 | 全新安装实际解析到 | 结果 |
|---|---|---|---|
| `mineflayer` | 4.33.0 | **4.39.0** | ❌ 补丁打不上 |
| `minecraft-data` | 3.97.0 | **3.117.0** | ❌ 补丁打不上 → **V-3 后改为锁定 3.117.0 并作废该补丁** |
| `protodef` | 1.19.0 | 1.19.0 | ✅ |
| `mineflayer-pathfinder` | 2.4.5 | 2.4.5 | ✅ |
| `mineflayer-pvp` | 1.3.2 | 1.3.2 | ✅ |
| `prismarine-viewer` | 1.33.0 | 1.33.0 | ✅（已移除，见 V-2） |

还有一个自相矛盾之处：`mineflayer@4.33.0` 自身依赖 `minecraft-data: ^3.98.0`，而补丁目录里放着 `minecraft-data+3.97.0.patch` —— 上游自己的依赖声明和自己的补丁互相打架。所以**光锁直接依赖不够，必须用 `overrides` 强制传递依赖**。

**处置**：
1. `.gitignore` 里删除 `package-lock.json` 一行（附注释说明原因），从此保留我们自己的 lockfile。
2. `package.json` 中补丁涉及的包使用**精确版本**（去掉 `^`）。
3. `overrides` 覆盖传递依赖。

---

## 二、上游 `patches/` 里的补丁（承重结构）

`postinstall` 会执行 `patch-package`。这些补丁不是可选优化，**缺任何一个都会导致功能级故障**。
上游原本有 5 个，我们保留了 4 个（第 4 个已作废，见 V-3）：

### 1. `mineflayer-pvp+1.3.2.patch`
`lib/PVP.js`：`this.bot.on('physicTick', () => this.update())` → `'physicsTick'`。
**拼错的 `physicTick` 事件永不触发**，不打此补丁战斗插件完全失效（bot 会站着不动被打）。

### 2. `mineflayer+4.33.0.patch`（3 处）
- `lib/plugins/digging.js`：加 `if (block.material === 'incorrect_for_wooden_tool') block.material = 'mineable/pickaxe'`；并把 `bot.entity.isInWater` 换成 `false`（上游注释：`isInWater, water calc is bugged, so always false`）。
- `lib/plugins/inventory.js`：`use_item` 的 `rotation` 由 `{x:0,y:0}` 改为真实朝向 `x: -bot.entity.yaw*180/Math.PI + 180`、`y: -bot.entity.pitch*180/Math.PI`。
- `lib/plugins/place_block.js`：`blockUpdate` 等待 `timeout: 5000` → **500**。
→ 缺了它，**挖掘判定、吃东西/使用物品的朝向、放方块的等待时长**全都不对。

### 3. `mineflayer-pathfinder+2.4.5.patch`（12KB，最大也最重要）
`index.js` + `lib/movements.js`，核心改动：
- 到点容差 `0.35` → **`0.175`**；`isInLava` 时也 `jump:true`。
- 开门能力 `this.canOpenDoors = false` → **`true`**（上游注释 `Causes issues. Probably due to none paper servers.`）；把 `door`/`trapdoor` 加入 `openable`；新增活板门开关判定与 `getMoveClimbUpThroughTrapdoor` / `getMoveClimbTop` 两个移动候选生成器。
- 岩浆规避重写：仅在 bot 不在岩浆里时才把岩浆加入规避集（`updateLavaAvoidance()`），否则落地即死的场景下永远无路可走。
- 攀爬：`weeping_vines` / `twisting_vines` / `cave_vines` 及 `_plant` 变体加入 `climbables`。
- 放方块后 `if (!placingBlock) placing = false`、乐观预测 `bot.world.setBlockStateId(...)`、成功后补 `bot.setControlState('jump', false)`。
→ **这些正是"bot 卡门 / 卡梯子 / 掉岩浆"的修复。对陪伴型 bot 是刚需。**

### 4. ~~`minecraft-data+3.97.0.patch`~~ → **已作废，移入 `patches-disabled/`**

`data/pc/1.21.6/protocol.json`：`"name": "checksum"` 的 `"type": "i8"` → **`"u8"`**。
→ 1.21.6 协议定义里的符号错误。

**作废原因（V-3）**：`minecraft-data` 上移到 `3.117.0` 之后，上游**已自行把该字段修成 `u8`**（本机实测：`"name":"checksum","type":"u8"`），补丁不再需要，且文件名里的 `3.97.0` 与实际版本对不上会被 `patch-package` 拒绝。
另外，本项目目标版本 1.21.1 的 `protocol.json` 里**根本没有 `checksum` 字段**（实测"未找到"），所以这个补丁从始至终与我们的目标版本无关。
文件本体已移至 `vendor/mindcraft-develop/patches-disabled/minecraft-data+3.97.0.patch` 留档，**不要删** —— 若日后需要回退到 3.97.0，它要跟着回来。

### 5. `protodef+1.19.0.patch`
`src/serializer.js`：把 `Chunk size is ... partial packet ...` 那段 `console.log` 注释掉（刷屏抑制）。

### 已删除：`prismarine-viewer+1.33.0.patch`
内容：`viewer/lib/entity/Entity.js` 的 `if (!e) throw new Error(\`Unknown entity ${type}\`)` → `if (!e) return;`。
**V-2 移除了 `prismarine-viewer` 依赖，该补丁失去对象，已删除**（若日后重新启用 3D 预览，需恢复此补丁并重新锁定 `prismarine-viewer@1.33.0`）。

---

## 三、我们自己的补丁（V 系列）

### V-1a · `src/agent/vision/browser_viewer.js` —— 3D 预览改为惰性加载

**原状**：模块顶层静态 `import prismarineViewer from 'prismarine-viewer'`。
**问题**：`agent.js` 第 14 行 `import { addBrowserViewer } from './vision/browser_viewer.js'`，所以**每个 agent 进程一启动就必然加载整条原生链**，即便 `settings.render_bot_view === false` —— 运行时那层 `if` 保护不了 `import` 阶段。
**改法**：函数内 `await import('prismarine-viewer')`，并用 `try/catch` 包住，加载失败只打日志不致命。

### V-1b · `src/agent/vision/vision_interpreter.js` —— 视觉截图链改为惰性加载

**原状**：第 2 行静态 `import { Camera } from "./camera.js"`；构造函数里 `if (allow_vision) this.camera = new Camera(...)`。
**问题**：`camera.js` 顶层 import 了 `prismarine-viewer` + `three` + `node-canvas-webgl`。
**改法**：
- 删除静态 import；构造函数改为 `this.camera = null;`。
- 新增 `async getCamera()`：首次调用时才 `await import('./camera.js')` 并实例化。
- `lookAtPlayer()` 与 `lookAtPosition()` 中原先的 `await this.camera.capture()` 改为 `await (await this.getCamera()).capture()`。

**为什么必须做**（决定性原因）——原生依赖链是**闭合**的：

```
agent.js:3   import { VisionInterpreter } from './vision/vision_interpreter.js'
vision_interpreter.js:2   import { Camera } from "./camera.js"
camera.js:1-6   prismarine-viewer / three / node-canvas-webgl
agent.js:14  import { addBrowserViewer } from './vision/browser_viewer.js'
browser_viewer.js:2   import prismarineViewer from 'prismarine-viewer'
```

只要 `import('./src/agent/agent.js')`，`canvas` + `gl` + `node-canvas-webgl` + `three` + `prismarine-viewer` 就全部被拉起。**而本机没有任何 C++ 编译工具链**（`C:\Program Files (x86)\Microsoft Visual Studio\18` 存在但 `VC\Tools\MSVC` 为空，`cl.exe` 不在 PATH），这些原生模块若没有可用预编译包就必然安装失败 —— 而它们的 install 脚本在本机实测直接 `spawn EPERM`，`.node` 二进制**一个都没生成**，结果是 `Cannot find package 'prismarine-viewer'`，**整个 `agent.js` 不可加载**。

V-1a/V-1b 之后，这条链不再被静态引用，原生依赖可以**完全不安装**。

> **代价（明确记录）**：`settings.allow_vision` 与 `settings.render_bot_view` 在本项目中**恒为不可用**。若日后需要视觉能力，必须先在开发机上装好 MSVC Build Tools + Python，再重新安装 `canvas`/`gl`/`node-canvas-webgl`/`three`/`prismarine-viewer` 五个包（版本回到 `prismarine-viewer@1.33.0` 以匹配已删的补丁）。这也正是用户决策 7「首期不要 3D 世界预览」的技术落点。

### V-2 · `package.json` —— 版本锁定 + 移除原生依赖

- **钉死**（去 `^`）：`mineflayer: 4.33.0`、`mineflayer-pathfinder: 2.4.5`、`mineflayer-pvp: 1.3.2`、`minecraft-data: 3.117.0`（初版为 3.97.0，已被 V-3 上移）。
- **删除**：`canvas`、`node-canvas-webgl`、`prismarine-viewer`、`three`。
- **保留**：`minecraft-assets`（纯数据包，`mindserver.js:70` 用 `await import()` 动态加载，供贴图代理使用，无原生依赖）。
- **`overrides`**：由 `{ "canvas": ..., "gl": "^8.1.6" }` 改为 `{ "minecraft-data": "3.117.0", "protodef": "1.19.0" }`。
- 新增 `"//"` 字段记录改动理由，方便日后同步上游时一眼看到差异。

### V-3 · `minecraft-data` 版本上移 + `runner/engine-patches.mjs` 协议兜底版本守卫

**背景**：V-2 把 `minecraft-data` 钉在 `3.97.0`（沿用上游补丁文件名的版本号），但**这个版本低于它所有下游依赖声明的最低要求**：

| 依赖方 | 声明 |
|---|---|
| `mineflayer@4.33.0` | `minecraft-data: ^3.98.0` |
| `minecraft-protocol@1.68.0` | `minecraft-data: ^3.109.0` |
| `prismarine-registry@1.12.0` | `^3.70.0` |
| `prismarine-block@1.23.0` | `^3.38.0` |
| `mineflayer-pathfinder@2.4.5` | `^3.5.1` |

**后果一（症状）**：`minecraft-protocol@1.68.0` 的 `defaultVersion = '26.1'`，而 `3.97.0` 最高只到 1.21.8 → `require('minecraft-data')('26.1')` 返回 null → `createClient.js:30` 抛 `unsupported protocol version: 26.1`；`ping.js:26` 抛 `TypeError: Cannot read properties of null (reading 'version')`，`mcserver.js` 的服务器探测一起挂掉。

**后果二（更硬，纯配置修不好）**：`prismarine-chunk@1.41.0`（`mineflayer@4.33.0` 声明 `prismarine-chunk: ^1.39.0`，于是装到 1.41.0）里有

```js
// prismarine-chunk/src/pc/1.18/ChunkColumn.js:15
const hasFluidCount = mcData.version['>=']('26.1')
```

而 `minecraft-data/index.js:42-43` 对未知版本是**硬抛**：

```js
const raise = other => { throw new RangeError(`Version '${other}' not found in [...] for ${type}`) }
this['>='] = other => versions[other] ? v1 >= versions[other].dataVersion : raise(other)
```

→ 只要 `minecraft-data` 不认识 `26.1`，**任何版本**的连接都会在注入 mineflayer 插件时抛 `RangeError`。

**改动 1**：`dependencies` 与 `overrides` 的 `minecraft-data` 同步改为 `3.117.0`（满足最严的 `^3.109.0`）；上游 `minecraft-data+3.97.0.patch` 移入 `patches-disabled/`。

**改动 2（防御性，避免同类问题再咬人）**：新建 `runner/engine-patches.mjs`，导出：

| 函数 | 作用 |
|---|---|
| `describeProtocolStack()` | 只读。返回 `{defaultVersion, supported, known, unknown, chosen, target, versions}` 或 `{error}` |
| `applyProtocolVersionGuard(log)` | 把 `minecraft-protocol/src/version.js` 的 `defaultVersion` 改成"`minecraft-data` 确实有数据"的版本 |
| `applyEnginePatches(log)` | 目前 = `applyProtocolVersionGuard`，后续引擎硬化补丁都挂这里 |

`chosen` 的取值：配置里 `MCBOT_MC_VERSION` 是具体版本且 `minecraftData(v)` 有数据 → 用它；否则退到 `known[known.length-1]`（认识的最高版）。

**为什么是改属性而不是打补丁**：`createClient.js:28` 与 `ping.js:24` 都是**调用时**读 `require('./version').defaultVersion`，CJS 模块对象在同一份 require 缓存里，改属性即全进程生效，且**完全不动 `node_modules` 里的文件** —— `npm install` 冲不掉它。

**为什么选目标版本而不是"认识的最高版"**：`autoVersion.js` 会把 `options.version` / `options.protocolVersion` / `client.version` 全部纠正成服务端上报的真实版本（`autoVersion.js:38-42`），但**不会改写 `options.majorVersion`**，而 `majorVersion` 决定 mineflayer 的 dataPaths 选择。兜底值越接近目标版本越安全。

**挂载点**：
- `runner/mcbot-gate.mjs` 顶部 `import { applyEnginePatches }` 并**在 `MCBOT_GATE` 判断之前**调用（连接问题与门开不开无关，没配门也要修协议栈）。
- `runner/engine-launcher.mjs` 在 `spawn` 之前做启动前自检，打印 `协议栈` / `版本兜底` 两行；`!stack.chosen` 或目标版本不在 `stack.known` 时 `process.exit(3)` 并列出可用版本。

**验证（全部通过）**：
- `node tools/probe-protocol-stack.mjs 1.21.1` → 通过。`minecraft-data 3.117.0`、`defaultVersion "26.1" 有数据（protocol 775）`、`目标版本 1.21.1 数据存在（protocol 767）`、依赖下限全部满足、"只有 protocol 支持但 data 缺失"为空数组。
- `node tools/probe-server-ping.mjs 127.0.0.1 25565 1.21.1` → `✓ ping 成功 / 服务端报告版本 : 1.21.1 protocol=767`。
- `runner/engine-launcher.mjs --config runner/bots/spike.bot.json` → 门在引擎进程与 agent 子进程两层都装上，`Xiaodou logged in!` / `Xiaodou spawned.`。完整证据见 `docs/06-T0技术验证报告.md` 第三节。

> **教训**：钉死补丁涉及的包时，**必须先校验它没有被压到下游依赖声明的最低要求之下**。`tools/probe-protocol-stack.mjs` 的第 3 条判据就是专门查这个的 —— 以后每次改依赖版本都跑一遍。

---

## 四、Node 版本：**22 LTS**（不是 README 说的 18/20）

`package.json` 没有 `engines` 字段。README 第 24 行写 "Node v18 or v20 LTS recommended. Node v24+ may cause issues with native dependencies" —— **这句话已经过时**。

实测（`npm view <pkg> engines`）：

| 包 / 版本 | `engines.node` |
|---|---|
| `mineflayer@4.33.0`（补丁目标版本） | **`>=22`** |
| `minecraft-protocol@1.55.0` | **`>=22`** |
| `minecraft-protocol@1.54.0` | `>=14` |
| `mineflayer@4.39.0`（漂移后实际装上） | `>=22` |
| `minecraft-protocol@1.68.0` | `>=22` |
| `canvas@3.2.3` | `^18.12.0 \|\| >= 20.9.0` |
| `gl@8.1.6` | `>=18` |

→ 连**补丁针对的那个 mineflayer 版本自己都要求 Node ≥ 22**。Node 18/20 已经不满足引擎当前依赖树。

**结论：用 Node 22 LTS。** 它满足 `>=22`，同时低于 README 警告的 v24+。

- 已落地：`D:\mc_company_bot\runtime\node-v22.23.3-win-x64\`（`node -v` = `v22.23.3`）。
- 备用：`D:\mc_company_bot\runtime\node-v20.20.2-win-x64\`。

---

## 五、重新安装 / 复现步骤

### 5.1 一键（发布版走的就是这条，推荐）

```powershell
cd D:\mc_company_bot
.\启动.cmd                                        # 缺什么自己补：Node 22 → 引擎 npm ci → Electron
```

命令行等价的体检与补装（不用双击时）：

```powershell
& 'D:\mc_company_bot\runtime\node-v22.23.3-win-x64\node.exe' tools\bootstrap.mjs --check   # 只体检，0 = 三样都齐
& 'D:\mc_company_bot\runtime\node-v22.23.3-win-x64\node.exe' tools\bootstrap.mjs --yes     # 缺什么补什么
& 'D:\mc_company_bot\runtime\node-v22.23.3-win-x64\node.exe' tools\bootstrap.mjs --only engine
```

`tools\bootstrap.mjs` 做的三件事与判据（与下面手工版**完全同一套证据**）：
① `tools\install-node.ps1` 把 Node 22 装进 `runtime\node-v22.23.3-win-x64\`（官方源 → npmmirror 镜像，
`SHASUMS256.txt` 校验；**已经放好同名 zip 就直接解压不下载**）；
② 在 `vendor\mindcraft-develop` 里 `npm ci --no-audit --no-fund --include=dev`（官方 registry 失败自动退
`https://registry.npmmirror.com`），装完立刻验 `ENGINE_PINS` 五个精确版本 + 下面 §5.2 那 5 条补丁证据串；
③ 在 `app` 里 `npm ci`，Electron 二进制没下来时设 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`
再 `npm install` 一次。
**注意**：`npm` 失败时它最后那句常常是 `Exit handler never called!`（看着像 npm 自己坏了）；
真因在 `runtime\npm-cache\_logs\*-debug-0.log` 里，bootstrap 会自动读出来翻成人话。
本开发环境所有子进程的外网 HTTPS 都被代理换证书（`ERR_TLS_CERT_ALTNAME_INVALID`），
所以"下载 Node / `npm ci` / 下 Electron"这三段**只在用户机器上验过才算数**，见 `docs\08` §七·补十二。

### 5.2 手工（要看清每一步、或一键脚本出问题时用）

```powershell
$rt   = 'D:\mc_company_bot\runtime\node-v22.23.3-win-x64'
$node = "$rt\node.exe"
$npm  = "$rt\node_modules\npm\bin\npm-cli.js"
$env:PATH = "$rt;" + $env:PATH          # 让 patch-package 的 postinstall 也用 Node 22
$env:npm_config_cache = 'D:\mc_company_bot\.npm-cache'

Set-Location 'D:\mc_company_bot\vendor\mindcraft-develop'
& $node $npm ci                          # 或首次：install --no-audit --no-fund
```

**安装成功的判据（三条都要满足）**：
1. 输出里出现 `patch-package` 且 **4 个补丁**均 `applied`（**不要只看 exit code**）：
   `mineflayer@4.33.0 ✔ / mineflayer-pathfinder@2.4.5 ✔ / mineflayer-pvp@1.3.2 ✔ / protodef@1.19.0 ✔`
2. `node_modules/mineflayer/lib/plugins/digging.js` 里能 grep 到 `incorrect_for_wooden_tool`。
3. `node_modules/mineflayer-pvp/lib/PVP.js` 里是 `'physicsTick'` 而不是 `'physicTick'`。

（`bootstrap.mjs` 的 `detectEngine()` 把上面三条做成 5 条证据串自动查，包含这两条 +
`place_block.js` 的 `timeout: 500`、`pathfinder/index.js` 的 `0.175`、`protodef/src/serializer.js`
被注释掉的 `Chunk size is`；少任何一条都报红，理由写在 `docs\08` §七·补十二 §7m.3 那一带。）

**装完之后必跑**（协议栈自检，两条）：
```powershell
& $node 'D:\mc_company_bot\tools\probe-protocol-stack.mjs' 1.21.1
& $node 'D:\mc_company_bot\tools\probe-server-ping.mjs' 127.0.0.1 25565 1.21.1   # 需要服务端在跑
```
两条都过才继续。**排查顺序固定为：`probe-protocol-stack` → `probe-server-ping` → `engine-launcher`。**

---

## 六、同步上游时的检查清单

1. `patches/` 目录里的补丁文件名是否随上游版本变化（版本号会变，我们的精确锁定值也要跟着改）。
2. V-1a / V-1b / V-2 / V-3 四处改动是否被上游覆盖掉（`git diff` 不可用，用本文件的代码片段比对）。
3. `settings.js` 的默认值是否有新增项（尤其 `allow_insecure_coding` 与 `blocked_actions`）。
4. `src/agent/agent.js` 中 `this.respondFunc = respondFunc;` 与两条 `bot.on('chat'/'whisper')` 的注册位置是否变化 —— 这是聊天门的挂载点，一变就要重新确认时序。
5. **依赖版本三方对齐**：上游 `package.json` 的 `^` 区间、我们钉死的精确版本、各包自己的 `engines`/`dependencies` 下限。跑 `tools/probe-protocol-stack.mjs` 验证。
