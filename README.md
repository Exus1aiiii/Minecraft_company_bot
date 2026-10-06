# MC 陪伴机器人（工作代号 mc_company_bot）

一个在 Windows 上运行的像素风桌面应用：接入自定义大模型 API，在多个 Minecraft 服务器中并行运行可随时开关的陪伴型 bot —— 陪你聊天、听你指挥、一起探险、帮你采集、帮你盖房。

本仓库以 **MIT 许可**发布（见 [LICENSE](LICENSE)）；用到的第三方组件与许可见 [THIRD-PARTY.md](THIRD-PARTY.md)。

## 三步跑起来

> 面向"从 GitHub 拿到这份源码"的人。**Windows 10/11 64 位**；第一次启动要联网下载约 **460 MB**
> （Node 22 运行时 30 MB + 引擎依赖 300 MB + 界面运行时 130 MB），装完约占 1.5 GB。
> **Node 不用自己装** —— 发现没有，脚本会自己下（`tools\install-node.ps1`）。

1. **拿到源码**：`git clone <这个仓库的地址>`，或在页面上点 *Code → Download ZIP* 解压到任意目录
   （别放进需要管理员权限的目录，例如 `C:\Program Files`）。
2. **双击 `启动.cmd`**：缺什么它自己补齐（Node 运行时 → 引擎依赖 → 界面运行时），补完自动开窗口。
   窗口标题出现「MC 陪伴机器人」就成了。
3. **在窗口里填两样**：
   - 「服务器」页 → 你的 MC 服务器地址（`主机:端口`；离线登录服可用，**1.21.1 最稳**）；
   - 「模型」页 → 大模型 API Key（DeepSeek / 通义 compatible-mode / 本地 Ollama 都行），**存完点一下"测试"**；
   然后回「机器人」页点开机，bot 就进服了。

不想装、只想先看看：`tools\launch-gui.ps1 -Check`（体检，不开窗口）；
只想问"还缺什么"：`runtime\node-v22*\node.exe tools\bootstrap.mjs --check`。

启动不了的时候，窗口里会**写明原因**而不是只说"失败了"（Electron 退出码翻成人话，"连不上服 / 被顶号 /
Key 不对"分开报），日志在 `runtime\logs\`。踩过的坑都在下面的[已知坑](#已知坑踩过的别再踩)表里。

## 当前状态

> **M1 已完工**：引擎侧、主进程侧、渲染进程侧全部落地，**这边已实测把窗口开出来、真机四项能力跑通**；
> 你手上那份按上面三步即可复现。
> **十七套自动自检全绿**（主进程 64 项 + 多 bot 53 项 + 多服务器 31 项 + 渲染进程八页
> + 中文采集词典 47 项 + 建造器 32 项 + 探险器 34 项 + 记忆模块 68 项 + 工坊 129 项
> + 回执翻译 66 项 + 本地汇报 69 项 + 首跑链路 51 项 + 大模型错误路径 71 项 + 三个静态检查）。
> **用户要的能力已全部跑通**：聊天互动、接受聊天框指令、采集原料（实测砍回 10 个橡木）、
> 陪同探险（实测走 32 格并汇报"看见了煤矿×132、铁矿×38"，还自己走回来）、
> **帮忙盖房子**（实测盖出 23/23 块的完整小屋，并用另一个客户端从方块层面取证）、
> **长期陪伴记忆**（实测四句话只花 1 次大模型调用）、
> **合成链**（说一句"挖点石头"，bot 自己砍木头 → 削木板 → 搭工作台 → 做木镐 → 挖到石头，
> 服务器当场发了 `[Stone Age]` 成就；说"做把石镐"它做出石镐，`[Getting an Upgrade]`）、
> 以及**烧炼链**（说"做把铁镐"，它自己去挖铁矿石、烧出铁锭、打出铁镐 ——
> 服务器发了 `[Acquire Hardware]` 成就）。
> 这些能力全部走的是**零 token 通路** —— 一次大模型调用都不发生。
>
> ★ 你给的服务器（地址写在 `runtime\config.json`，不随仓库公开）已配好（1.21.1 / 离线登录可用 / 延迟 19ms），
> 「小豆」已指向它；**你的游戏 ID 也已写进两台 bot 的主人名单**
> （这一步以前只能手改配置文件，现在「机器人」页里能直接改，没配过还会在页面顶部弹一张首跑卡）。
> bot 还会**把引擎的英文回执翻成中文再说给你听**（`Found non-destructive path.` →
> 「找到一条不用拆方块的路。」），143 句引擎台词里 115 句有中文，剩下 28 句是
> 我们还没开放的能力（种地、村民交易）并已列表注明。
> **"多服务器并行"也已实测通过**：两个 bot 分处两台服务器、各连各的、跨服零串台。
> 请双击 **`启动.cmd`** 走一遍验收（见 [文档 08](<docs/08-M1实施与验收报告.md>) §六）。
> **启动不了的话窗口里会直接写明原因**（复制那几行给我就行）：它会把 Electron 的退出码
> 翻成人话，并区分"Electron 自己没起来"和"起来了但连不上服/被顶号/Key 不对"。
> ★ **本轮已实测把窗口开出来了**：这台机器上 Chromium 的沙箱起不来（`electron.exe --version`
> 都是 `0x80000003`），启动器现在会**自动换一种方式重试**，窗口标题「MC 陪伴机器人」实测正常出现，
> 界面八页、两台 bot 的配置都读出来了（原因与修法见坑表最后几行）。
> **2026-10-06 用户在自己电脑上复验：窗口正常打开**，只在第一次看到那句黄色的沙箱提示；
> 现在启动器会把这次结论记在 `runtime\sandbox-fallback.txt`，之后启动直接走「关掉沙箱」，
> 屏幕上只留一行灰色的说明，不再重复报 0x80000003。
> 只想体检不想开窗口：`tools\launch-gui.ps1 -Check`（会顺便把沙箱能不能用报出来；
> 沙箱修好之后它会**自己清掉那份记忆**）。
> 关键时间点：**2026-10-05** 引擎首次成功登录 MC 1.21.1 服务端；同日四项唤醒规则实测通过、token 计数链路打通。

## 文档

| 文档 | 内容 |
|---|---|
| [步骤一 · 需求评估与框架设计](<docs/01-需求评估与框架设计.md>) | 需求拆解、原始设想的 20 项风险、分层架构、关键决策、路线图、**已确认的 9 项决策记录** |
| [步骤二 · 开源项目调研与选型](<docs/02-开源项目调研与选型.md>) | GitHub 上 AI 操控 MC 的成熟项目对比与选型结论（含许可证合规）、mineflayer 生态、跨版本方案、皮肤路径 |
| [附录 A · Mindcraft 引擎能力速查](<docs/03-Mindcraft引擎能力速查.md>) | 引擎的完整命令表、蓝图机制、10 个自动模式、人格/记忆结构、安全红线、工程地雷，以及**聊天入口 / 唤醒 / 权限 / 生命周期**的源码级事实 |
| [附录 B · M1 实施计划](<docs/04-M1实施计划.md>) | M1 目标与验收标准、进程架构、任务分解 T0–T8、**必验风险清单**、已确认的开放决策 |
| [附录 C · Vendor 补丁与依赖锁定](<docs/05-vendor补丁与依赖锁定.md>) | 我们对 vendored 引擎的每一处改动（V-1a/V-1b/V-2/V-3）、依赖锁定理由、Node 版本实测结论、重装与复现步骤 |
| [附录 D · T0 技术验证报告](<docs/06-T0技术验证报告.md>) | **协议栈错配的完整根因链与修法**、聊天门四项规则实测证据、遗留问题 R-8~R-10 |
| [附录 E · 应用架构与接口契约](<docs/07-应用架构与接口契约.md>) | 目录结构、`AppConfig` schema、`BotRuntime` 状态、事件传输、`window.mcbot` API 全表、像素风设计规范、人格面具契约 |
| [附录 F · M1 实施与验收报告](<docs/08-M1实施与验收报告.md>) | **验收对照表 A1–A6**、实测行为表、一次唤醒的真实成本拆解（5137 token 花在哪）、本轮修掉的真 bug、**中文采集指令 / 盖房子 / 一起探险 / 长期陪伴记忆 / 合成链 / 烧炼链 / 直接敲命令 / 首跑那一关**八篇专题（§七·补 ~ 补八）、遗留问题 R-8~R-14 |
| [附录 G · 初版功能与性能总结（含发布评估）](<docs/09-初版功能与性能总结（含发布评估）.md>) | 初版能力清单、**实测性能数字**（冷启动 5.06s / 中文回复 24~30ms / 一次唤醒 5137 token）、诚实的能力边界、以及**要发 GitHub 必须先处理的体积·隐私·许可证**清单（含 6 处个人信息位置） |

## 核心结论速览

- **定位**：不自研 AI 打 MC 的算法，而是把成熟开源能力**产品化**成 Windows 桌面软件。
- **选型已定**：自研像素风桌面壳（**Electron + 无打包器的原生 ESM 渲染进程**）+ **vendor `mindcraft-bots/mindcraft`（MIT, 5.8K★）** 作引擎 + mineflayer 插件族。
- **目标版本已修订为 MC 1.21.1 + Fabric/原版离线服**（原定 1.21.6 在用户手上不可达；1.21.1 仍在引擎支持区间内，**不需要 ViaProxy**）。
- **三层控制**：反射层（毫秒级，无大模型）→ 技能层（硬编码可组合）→ 决策层（大模型）。大模型**只做决策，不碰实时回路**。
- **🔴 安全红线**：引擎的 `!newAction` 会在宿主进程内执行模型写的 JS → 已加进 `blocked_actions`，**从提示词里删掉、从执行表里禁掉**，双保险。
- **★ 唤醒称谓引擎完全没有**：`agent.js` 只按"谁说的"过滤，不按"说的是什么"过滤 —— **公屏上任何人说任何话都会触发一次大模型调用**。这既是最大浪费，也是"限定称谓"需求必须自研的原因。**已由 `runner/mcbot-gate.mjs` 解决并实测通过。**
- **★ 接入方式零源码改动**：`src/models/` 目录会被 `_model_map.js` 自动扫描注册 provider —— 所以"任意大模型 API"只靠新增一个 `mcbot.js` 就实现了，不用碰引擎源码，`npm install` 也冲不掉。
- **★ 一次唤醒的真实成本**：**约 5137 token**（其中 68% 是引擎的命令文档）。一个 20 万 token 的日预算 ≈ 39 次唤醒。详见 `docs/08` §四。
- **★ 采集/探险走"零 token 通路"**："砍点木头""附近有没有铁矿""四处走走"这类话由中文词典直接翻译成引擎命令，**一次大模型调用都不发生**（实测整轮放行 9 次、大模型只用了 1 次）。实测砍回 10 个橡木。详见 `docs/08` §七·补。
- **★ "四处走走"原来只是逃跑**：引擎里跟探索沾边的只有 `!moveAway(distance)` —— 朝任意方向离开 N 格，**走完什么都不知道、也说不出一句话**。已换成我们自己的 `runner/explorer.mjs`：挑方向（不往水里跳）、分段短跳、扫周围 33×13×33 格、回来报出"**走了多远、到了哪、看见了什么**"，再自己走回玩家身边。实测 32 格 9 秒走完并汇报「我往西走了 32 格……一路上看见了煤矿×132、铁矿×38。」，**同样零 token**。详见 `docs/08` §七·补三。
- **★ 盖房子引擎完全没有**：41 条动作命令里**没有 `!build`**；最接近的 `!placeHere` 官方描述明确写着
  *"Do NOT use to build structures"*；引擎自带的分层蓝图系统只能靠 `!newAction` 驱动，而那是我们的安全红线。
  → 建造长在我们这一层（`runner/builder.mjs`），但**放方块复用引擎的 `skills.placeBlock`**（它自己处理清障、找支撑面、走近走远）。
  实测盖出 **23/23 块**的完整小屋，并换一个客户端从方块层面读回来验证。同样走**零 token** 通路。详见 `docs/08` §七·补二。
- **★ 引擎自带的"记忆"不是给陪伴用的**：`history.memory` 硬上限 **500 字符**（`'...(Memory truncated to 500 chars. Compress it more next time)'`），每攒够若干条还要**再调一次大模型**去重写它（记忆本身要花钱），而且我们启动时是 `load_memory: false` —— **重启一次就归零**。
  → 自己起了一层 `runner/memory.mjs`：四种记忆（事实/约定/地点/经历）、**中文二元组检索**（中文没空格，按字切会把"钻石"拆成两个没意义的字）、80 条封顶但**约定永不被挤掉**、原子落盘、坏文件返回空记忆绝不抛。
  三条入口里两条零 token（"记住…"/"你还记得…"），第三条在闲聊走大模型时**顺手记下来**，只在检索命中时才往 history 里塞相关内容。实测四句话只花 1 次调用。详见 `docs/08` §七·补四。
- **★ 玩家问"你在哪/背包里有什么"，中文指令和直接敲 `!stats`/`!inventory` 必须得到同一个答案**：引擎那两条命令吐的是**给模型看的内部转储**（15 行、还带 `self_preservation(ON)` 一长串，实测被聊天框拆成两条发出去）。现在 `runner/self-report.mjs` 的 `LOCAL_REPORTS` 在门禁里抢在 `commandExists()` 之前接管，四种问法实测**一字不差**、大模型 0 次 / 0 token。详见 `docs/08` §七·补七。
- **差异化机会**：限定称谓唤醒 + owner 权限、皮肤、多服务器并行、像素风 GUI、真正的长期陪伴记忆——**所有现成项目都没做**。

## 已知坑（踩过的，别再踩）

| 坑 | 结论 |
|---|---|
| 上游 `.gitignore` 忽略了 `package-lock.json` | 全新安装必然依赖漂移，`patches/` 全部失效。我们保留自己的 lockfile |
| 钉死补丁涉及的包 ≠ 安全 | 钉死的版本可能低于其下游依赖声明的最低要求。改版本后必跑 `tools/probe-protocol-stack.mjs` |
| `mcdata.js:11` 是模块级快照 | agent 子进程**永远拿不到配置里的 MC 版本**，只能靠 `defaultVersion` 兜底 → 由 V-3 守卫接管 |
| 本机 `curl.exe` 与 Java 的 TLS 都不可用 | 一切下载必须走 Node 的 `fetch`（`tools/fetch.mjs`） |
| 沙箱给工作区文件打完整性标签 | Java 的 `Files.isWritable()` 会误判 → **Fabric 服务端 remap 在本机无法完成**，测试服改用纯原版 |
| `ELECTRON_RUN_AS_NODE=1` 是 DSH 注入的 | 直接跑 `electron.exe` 会退化成纯 Node。`启动.cmd` 已自动清掉 |
| 同名残留 bot 进程会导致 `duplicate_login` 踢线 | 用 `taskkill /pid <PID> /T /F` **按 PID 树杀，绝不按镜像名杀**——你自己的 MC 客户端就是 `java.exe` |
| 沙箱下 `stdio:'pipe'` 会 EPERM | 主进程与子进程之间一律走**文件**（jsonl 事件流 / `--out` 结果文件），不捕获管道 |
| PowerShell 的 `Get-Content` 读 UTF-8 jsonl 会乱码 | 文件本身没问题。用 `node tools/mcbot-inspect.mjs` 看，别用 `Get-Content` |
| PowerShell 传 `node -e` 会吃掉双引号、here-string 会插值 `$COMMAND_DOCS` | 宁可写成 `.mjs` 文件再跑 |
| **测试脚本改用户配置，靠"跑完还原"是不可靠的** | `... \| Select-Object -First N` 会把 node 硬杀掉，`finally` 与 `process.on('exit')` 都跑不到。自检现在把用户数据目录整个重定向到沙箱（`devtools/sandbox-env.mjs`），**物理上够不着** |
| 一个路径变量干两件事 | `RUNTIME_HOME`（随应用分发：Node/Java/测试服）≠ `RUNTIME_DIR`（用户数据：config/secrets/logs）。混用会让沙箱里的自检找不到 Node |
| `supervisor.start()` 的失败返回有两种形状 | `{ok:false, error:'…'}` 与 `{ok:false, errors:[…]}`，只打印 `.error` 只会得到 `失败：undefined` |
| 事件的 `ts` 是数字（epoch 毫秒），不是 ISO 字符串 | `Date.parse(ev.ts)` 恒得 `NaN`，用它做时间过滤会静默丢掉**全部**事件 |
| **吞异常的 `.catch(() => {})` 是最贵的代码** | 建造任务抛异常后整个流程静默消失（日志里连"开始盖房"都没有），白查半小时。一律改成 `onFailure(err)`：`console.error` + `emit('error', {where, message, stack})` |
| mineflayer 的 `bot.blockAt()` **只认 Vec3 实例** | 传普通 `{x,y,z}` 会在 `prismarine-world/src/worldsync.js:102` 报 `pos.floored is not a function`。用 `vecAt()` 从 `bot.entity.position.constructor` 借构造器；假 bot 也要**故意挑食**才测得出来 |
| 「与基线对比未变」≠「目标文件是期望的状态」 | 两个断言必须分开写。我曾拿**已经脏了的基线**连跑多轮并汇报"配置零改动"，其实配置一直是坏的 |
| 指数退让的选址只看四角是不够的 | 3×3 的四个角 x 同奇偶，缓坡上四角永远一样高，中间那列反而更高。地基要取**整块地**的最高层，且要逐列检查是否被占 |
| 引擎的 `skills.craftRecipe()` 材料不够会**少合几次就返回**，不报错 | `skills.js:103` 是 `bot.craft(recipe, Math.min(craftLimit.num, num), table)`。**"调过了"不等于"做出来了"** —— 每一步做完都要重新数背包 |
| `mcData.items` 按**数字 id** 索引 | 按名字查要用 `mcData.itemsByName`；合成配方在 `mcData.recipes[itemId]`（引擎的 `getItemCraftingRecipes` 是它自己的包装，原始 mineflayer 上没有） |
| 只报"引擎进程退出（code=1）"等于没说 | 真正的原因只写在日志尾巴上。`supervisor.mjs` 的 `readExitReason()` 会读最后 16KB 并翻成中文（同名在线 / 连不上服务器 / 被踢……） |
| 一句里说两件事要先按标点切句再判断 | 但**坐标里的逗号不是切句符** —— `(-12, 64, 30)` 会被切成三截。切句前先把坐标三元组换成占位符 |
| 带 `g` 的正则 `.test()` 会记住 `lastIndex` | 同一个正则既做切分又做判断，迟早会在某次调用上给出错误答案。留一个不带 `g` 的副本专门判断 |
| `node --check` 看不见作用域错误 | `say is not defined`（函数定义在另一个函数内部）语法完全合法，真机第一次跑才炸。**唯一能抓到它的是 `onFailure` 里的 `emit('error', …)`** |
| 判断自检过没过要看**退出码**，不是匹配输出文本 | `2>&1 \| Out-String` 再 `-match '✓'` 会把全绿的八套全判成失败（`✓` 过管道编码后匹配不上） |
| 引擎 `bot.craft()` 会**少合几次就返回** | `skills.js:103` 是 `bot.craft(recipe, Math.min(craftLimit.num, num), ...)`，且合成后背包更新有延迟。补材料必须**循环 + 每轮等 600ms**，不能算一次了事 |
| 一次 `GoalXZ` 拉太远会**几乎原地打转** | 实测拉 48 格穿森林，150 秒只挪了 26 格。切成 ≤16 格一段、段间重新算路后，同样 32 格只要 9 秒 |
| 被 `pathfinder.stop()` 之后 `goto` **不一定抛错** | 有的版本是安静停下、照常 resolve。只看"有没有抛异常"会把"半路停下"报成"走完了"——**那是在跟玩家撒谎**。要自己记 `interrupt_code` |
| 超时定时器**不能随便 `unref()`** | 它是"唯一还在等的东西"时，unref 会让 Node 直接退出（`unsettled top-level await`），超时保护永远不触发 |
| `node --check` **看不见作用域错误** | `say is not defined`（函数定义在另一个函数内部）只有真机跑到那一步才炸。靠 `onFailure` 抓出来 |
| 中文检索**不能按字切** | "钻石"会被拆成两个没意义的字。用二元组 + 忽略表（什么/怎么/这个/一下…），否则"这是什么"会匹配上一切 |
| 规则表的匹配是**第一条命中就停**，通用规则必须排在具体规则后面 | `Used (.+?)\.` 会把它前面的 `Used /setblock to place … at …` 整句吞掉。通用规则的捕获组要用**形状约束**（`(\w+)`）而不是什么都吃的 `(.+?)` |
| 🔴 **`!smeltItem` 命令烧成功 500ms 后会 `agent.cleanKill()` 自杀重启** | `commands\actions.js:284-291`。对用户就是"每烧一次熔炉多一条意外退出"。要烧东西就**直接调库函数** `skills.smeltItem(bot, name, num)`（`skills.js:142`，做完正常返回） |
| 「每次记得补一条」不是工程，**能跑起来的检查才是** | 真机上漏过两次英文回执。`tools\check-speak-coverage.mjs` 反过来从引擎源码抠出全部 143 句 `log(bot, …)` 逐句验——当晚就抓出 4 句真漏的 |
| 小写文件名的 `tools\check-*.mjs` 要能被自检调用，就必须**用退出码表达结论** | 只打印不算过。`process.exit(1)` 才能接进自动化 |
| 老用户配置里"改过的话头"不能被我们的新默认值冲掉 | `migrateConfig()` 只增不改，于是**加规则能送到、改话头送不到**。加一张 `PREV_DEFAULT_PATTERNS`：只有当前值**和旧默认一模一样**（= 没自己改过）才刷成新的。**用户的改动永远比我们的新默认值重要** |
| `node --check` 只做语法分析，**看不见"这个名字根本不存在"** | 忘了写 `import` 的话 `--check` 照样 exit=0，真机上表现为"bot 收到了话、也执行了、就是一声不吭"。跑 `tools\check-imports.mjs` |
| 查日志要连 `error` 事件一起看 | 我只提取了 `gate` 和 `log`，于是"忘了 import"那两条 `[error]` 被自己的过滤条件挡在外面，白转一圈 |
| PowerShell 的 `Get-Content` 读 UTF-8 文件可能显示成乱码 | 文件本身没问题（用 Node 读回来是好的）。别急着去"修编码"，先用 `node -e "fs.readFileSync(...,'utf8')"` 确认一遍 |
| **正则的书写顺序就是语义** | `parseRecallIntent` 里"你记得什么/啥/多少/哪些"必须排在那条通配**之前**，否则"什么"会被当成关键词去检索"什么"两个字 |
| 一句里说两件事要**先按标点切句再判断** | `norm()` 会把标点吃掉，整句进同一格 → 存成「我家在 -12 64 30 以后别在晚上出门」这种囫囵话。单元测试抓不到（断言只查"记下了没有"），是真机上看出来的 |
| **坐标里的逗号不是切句符** | 按 `,` 切句会把 `(-12, 64, 30)` 剁成三截，记回来只剩「我家在 -12」。切句**之前**要先用占位符把坐标三元组护起来。这个 bug 是**修上一个 bug 才引出来的** —— 改完必须再真机跑一遍 |
| 带 `g` 的正则 `.test()` 会记住 `lastIndex` | 同一个正则既做切分又做判断，迟早会在某次调用上给出错误答案。留一个不带 `g` 的副本专门判断 |
| 引擎的 `history.memory` **不是给陪伴用的** | 硬上限 500 字符、每次重写都要调大模型（记忆本身要花钱），且我们启动时 `load_memory:false` → 重启即归零 |
| 🔴 **测试运行器报"全绿"比报"红"危险得多** | `run-all-tests.mjs` 第一版把 stub 写成 `['./devtools/register-electron-stub.mjs']`，拼出来是 `node <stub文件> <自检文件>` —— **少了 `--import`**，等于把 stub 当入口脚本跑，它注册完就退。四套 headless 全部"80ms 通过"、输出为空，运行器照样报「14 套全绿」。红灯你会去查，**假绿你会直接信**。必须写成 `['--import', './devtools/register-electron-stub.mjs']` |
| 只看退出码 = 把"什么都没跑"当成"全跑通了" | 一个空转的进程和一个跑完的进程，退出码一模一样（都是 0）。`run-all-tests.mjs` 现在每套都带一个 `expect` 正则，**没打出那句"跑完了"的汇总就算失败**，并打印它仅有的一点输出。已反向验证：把 `--import` 改回去 → 立刻报「退出码 0，但没打出汇总行」 |
| 手工起引擎测试时，**必须自己把门禁注入进去** | 门禁（`runner/mcbot-gate.mjs`）是 `supervisor.mjs` 用 `NODE_OPTIONS=--import file:///…/mcbot-gate.mjs` 注入的。手工跑 `node runner\engine-launcher.mjs` 就**没有我们这一层**——我因此拿到一份"中文指令没生效"的假结论（4 条全走了大模型），白查一轮。手工复现时先 `$env:NODE_OPTIONS = '--import file:///D:/mc_company_bot/runner/mcbot-gate.mjs'`，并确认事件流里有「已上线，守卫 N 位主人」 |
| **挑东西要按意图挑，不能按位置挑** | `cfg.servers[0]` 原本是"本机测试服"，用户把自己的线上服加进配置并排在前面之后，这一行就变成了他的真服务器——`headless-multibot` 于是把**用户的服务器地址改成了 127.0.0.1**（改的是沙箱副本），然后因为测试玩家在本地服喊话、bot 在线上服，三处断言齐红，看着像唤醒逻辑坏了。现在统一用 `pickLoopbackServer()` 按 host 是不是回环挑，并且**最后再加一道闸**：拿 `buildLaunchSpec` 出来的 spec 断言目标必须是回环，否则直接停 |
| 位置假设失效时，测试**不会报错，只会静默失效** | 上面那条改完之前，`headless-multibot` 每天都是"绿的"——只是绿得没有意义。凡是"取第 0 个"的地方，都要问一句：这个 0 是谁保证的？ |
| `!stats` / `!inventory` 是**给模型看的内部转储**，不能透传给玩家 | `!stats` 吐 15 行、含 `self_preservation(ON)` 一长串，实测被拆成两条聊天消息发出去。现在 `runner/self-report.mjs` 的 `LOCAL_REPORTS` 在门禁里**抢在 `commandExists()` 之前**接管，玩家说「报一下坐标」和直接敲 `!stats` 得到**同一句中文** |
| 40 个护甲/工具名不能靠一条条列 | `iron_helmet` 会原样漏出去。用 `MATERIAL_CN × PIECE_CN` 两张小表拼（`iron`+`helmet`→铁头盔），放进 `runner/engine-speak.mjs` 的 `EXTRA_CN` 之后、前缀规则之前 |
| 🔴 **`.cmd` 里写中文 = 用户双击后满屏乱码、窗口根本不出现** | cmd.exe 用**控制台代码页**（中文 Windows = GBK/936）解码 `.cmd` 内容，UTF-8 中文被解错后**把换行吃掉了**：`rem 这是一句注释` 和它下面那行命令被拼成一条去执行，于是每一句中文注释都变成一条「'xxx' 不是内部或外部命令」。`启动.cmd` 实测 `bytes=962 非ASCII=333 LF=39 CRLF=0 BOM=false`。**修法**：`.cmd` 只留纯 ASCII（现在约 15 行），中文全部搬进带 **BOM** 的 `.ps1`，换行一律 CRLF。**这条连注释里的中文都不放过**（我曾在 `.cmd` 注释里写了个中文文件名，照样被 checker 抓出来）。`tools/check-launchers.mjs` 查的就是**字节**，代码 review 永远看不出这类问题 |
| ★ PowerShell 用 `&` 调 **GUI 子系统程序**根本不等它 | `electron.exe` 不带控制台，`& $electron $appDir` 会立刻返回、`$LASTEXITCODE` **根本不被设置** → 用户双击后黑窗口一闪就关，看着像什么都没发生，后面整段诊断代码永远跑不到（第一版 `launch-gui.ps1` 就这么写的）。要用 `System.Diagnostics.ProcessStartInfo` + `UseShellExecute=$false` + `WaitForExit()`。**不用 `Start-Process`** 是因为它的 `-ArgumentList` 对含空格路径的加引号规则很绕 —— 那正是"路径里有空格就启动失败"这类怪问题的来源 |
| ★★ **对陌生人"静默拒绝"是最糟的首跑体验** | 门禁 `runner/mcbot-gate.mjs` 里 `if (!owners.some(o => lower(o) === lower(username))) { reject('rejectedNotOwner', …); return; }` —— 名单外的人说话**一个字都不回**。而出厂 `owners` 是 `['Steve']`，它**非空**，所以 `validateConfig` 的"必须指定主人"和界面警告**都不会响**，用户看不到任何异常，只看到"喊它一声不吭，像坏了"。修法三处：①`ownersConfigured` 显式标记（显式布尔优先，否则"名单 ≠ 出厂值"就算配过）②GUI 首跑卡，一键把自己的 ID 填进去 ③游戏内**一次性**提示（只在明确未配置时说、每人每会话只说一次、私聊永远算而公屏必须带唤醒称谓 —— 否则就变成对全服广播家底） |
| 大小写没对齐会让判定**恒假，而且不报错** | `isFactoryOwners` 拿未小写化的 `['Steve']` 去比已经 `toLowerCase()` 的名单，`'steve' === 'Steve'` 永远 false → 出厂名单**永远判不出来** → 首跑提示永远不出现，也没有任何报错。预生成一张 `FACTORY_OWNERS_LC` 再比。**这个 bug 是 `test-firstrun` 第一轮就跑出来的**（同轮还抓出"显式 `false` 被无视"），所以那条链路才值得写单测 |
| 视图状态放在 `render()` 内部 = 任何一次重挂都归零 | `app/renderer/app.js` 的 `saveConfig()` 成功后**有意**调 `remountView()`（避免视图抱着旧配置对象）。于是用户点开卡片 → 改字段 → 按「保存配置」→ 编辑区当场自己合上，**看起来像改动被丢了**。展开状态要提到**模块级**（`app/renderer/views/bots.js` 顶部的 `openCards`）。★ 改状态持有方式时最容易出的事是"声明改了、引用没改"，而它报出来的错**会指向完全不相关的地方**（这里是 `state.detailOpen is not iterable`） |
| 断言别拿整个 `innerHTML` 去 `includes` | toast 文案里也带着「主人」「小豆」这些词，用整页文本查字段会**假阳性通过** —— 我第一版就这么"通过"了两条根本不存在的字段。要查就查 `querySelector('.edit-grid').textContent` 那个小范围 |
| 自检里点按钮之前，要先等上一次异步操作引发的重挂落定 | 首跑那一按会触发 `save()` → `remountView()`。点早了，点到的是**马上要被丢掉的那棵 DOM**，现象是"按钮已经写着『收起详情』、里面却是空的"，看起来像渲染坏了，其实只是点早了。等 600ms 再动手 |
| **自检不能依赖"用户的数据凑巧符合"** | `headless-multiserver` 是从**用户的真配置**里找 `bot-axiao` 的：只要找到了，那段"给 B 设 `owners: ['Steve']`"的代码就**整个被跳过**。用户给出自己的游戏 ID、我们据此改了 `bot-axiao.owners` 之后，这套自检立刻变红，报的是「B 收不到自己服务器上的公屏？」，而真相是门禁按**新名单**把测试玩家判成了陌生人（`rejectedNotOwner`），**跟服务器隔离毫无关系**。凡是断言依赖的性质，都要由测试自己摆好（现在 `wakeNames`/`owners`/`ownersConfigured` 都无条件钉死），并且**改完用户配置后要重跑一遍全量自检** —— 这类耦合只有跑起来才看得见 |
| 🔴 **闸门必须建在"被测对象真正走的那条链"上** | `headless-multibot` 里有一道"这个 bot 必须连本机"的闸，它检查的是 `buildLaunchSpec(botB, srv, …)` 算出来的 spec —— 而 `srv` 是**我们自己显式传进去的**，算出来当然是 `127.0.0.1`，属于自问自答。可 `supervisor.start()` 起进程时走的是**另一条链**：`bot.serverId` → 从**已保存的配置**里反查 `servers[]` → `host`。同时那台 bot 的 `serverId` **从来没被钉死**（找到用户配置里同 id 的 bot 就整段跳过赋值）。两件事叠起来的结果：**这套自检真的把 bot「阿霄」登进了用户的线上服务器**（用户的线上服务器，地址见 `runtime\config.json`；日志原文见 `docs/08` §7i.8）。修法：闸门挪到 `saveConfigRaw()` 之后、读回**已保存的配置**再走 `serverId → servers[] → host`；并加 `MCBOT_VERIFY_GATE=1` 开关，故意把地址换成保留段 `192.0.2.1` 来证明它真会拦（427ms、退出码 1，在起任何进程之前）。**一个检查了错对象的断言比没有断言更危险 —— 它会让你以为这件事已经被守住了** |
| **失败报告里必须能看见失败的那行** | 上面那次排到最后只剩「1 个问题（共 53 项检查）」，而运行器只打 `stderr` 的**头 8 行** —— 这些自检把几十上百行进度全写在 stderr 上，于是"哪条断言红了"永远被埋在中间。改成**先挑出含 `✗` 的行**再打印。一条看不见失败的失败报告，等于没有报告 |
| ★ **"红行"可能压根不在 `stderr` 里** | 改完上面那条，还是遇到一次"17 套里红 1 套、报告里却一条红行都没有" —— 因为 `headless-multibot` 把进度写在 **stdout**，而报告只在 `stderr` 里找 `✗`。现在两边一起找。**而且这次的单红至今没能复现**（单套 2 次全绿、完整 17 套 1 次全绿；沙箱日志每次运行都会被清空，原始输出没留下）—— 所以"修好了"这句话要留给下一次真的红给我看的时候再说 |
| 🔴 **"密钥我填过了"可能是一把假密钥** | 早期还没做沙箱的自检，把它的测试密钥 `sk-multibot-fake` 写进了用户的 `runtime\secrets.json`（`devtools/headless-multibot.mjs` 里写死的那把）。界面照着它显示「已保存（sk-…fake）」，**和真密钥长得一模一样** —— 用户于是以为填过了，然后对一个永远 401 的 bot 找原因。修法：`store.looksLikePlaceholderKey()` 判定"明确是假的"形态，模型页把它单列成第三种状态（红字 + "请把真 Key 粘上来覆盖它"）；`tools/clean-fake-keys.mjs` 只删判定为假的，**形态奇怪但可能是真的密钥一律不动**（删除不可逆）。判定刻意保守：真密钥被误判成假的比漏判更糟，用户会去反复重填一把本来好好的 Key |
| **`secrets.json` 里存的不是字符串，是 `{enc, v}` 对象** | `v` 是 base64（`enc:false` 时是明文 base64，`enc:true` 时是 DPAPI 密文的 base64）。我第一版探针写 `String(rec).length`，于是打印出 `"[object Object]"`（长度 15），**差点第二次得出"密钥没保存上"的错结论**。判据只有一个：`store.getSecret(id)` 能不能取回值；看状态用 `store.secretStates()`。顺带：`validateConfig()` 返回的是**数组**，不是 `{errors}` |
| **`enc:false` 是"跑在 electron stub 下"的铁证** | 真实 Electron 里 `safeStorage.isEncryptionAvailable()` 为真，落盘一定是 `enc:true`；只有自检脚本（stub）才会走明文分支。查"这条记录是谁写的"时，这一位比时间戳还可靠 |
| ★ **`.gitignore` 里含通配符的模式写错 = 静默不生效** | `runner/bots/*.launch.json`、`vendor/*.tar.gz` 这种"路径里带 `*`"的模式，我第一版匹配器把 `*` 直接留给了正则，于是它变成"零个或多个斜杠"——**模式等于没写**（那两样东西照样被判成"会提交"，`.launch.json` 里就是你的服务器地址）。凡是"靠模式匹配"的规则，都要**拿真样本反向验证一次**；`check-publish` 首跑报出来的"未忽略"就是靠这个抓到的 |
| 块注释里出现 `*/` 会把注释**提前闭掉** | 我在注释里写了个 glob 示例 ``a/*/b*.json``，其中的 `*/` 直接结束了注释 → `SyntaxError: Unexpected token '.'`，报错行还指着注释**下面**那行。`node --check` 一秒就能抓到，别用"看起来是对的"糊过去 |
| 隐私扫描工具**不能把要查的隐私值写死在自己身上** | 否则这个工具本身就是下一处泄漏（"列出 6 处带个人信息的地方"那份清单，自己就带着那 6 个值）。`tools/check-publish.mjs` 每次从 `runtime/config.json` **现读**服务器地址与主人名单，拿它们去搜要提交的文件 |
| 🔴🔴 **`0x80000003` 不是"显卡不行"，是 Chromium 的沙箱在这台机器上起不来** | 症状：双击 `启动.cmd`，黑窗口里只有一句「Electron 自己没能启动起来（退出码 0x80000003）」，**配置和 Key 一点问题都没有**。取证：`electron.exe --version` → `0x80000003`、**完全没有 stderr 输出**（崩在 Chromium 打日志之前）；`electron.exe --version --no-sandbox` → 正常打印 `v44.5.1`；加上 `--no-sandbox` 跑本应用，窗口标题「MC 陪伴机器人」正常出现（主进程 + GPU + utility + 渲染，四个进程齐全）。`0x80000003` = `STATUS_BREAKPOINT`，即 Chromium 的 `IMMEDIATE_CRASH()`（`__debugbreak()`）—— **它表达的是 CHECK 失败，不是"显卡不支持"**。这台机器上跑着**腾讯电脑管家**（`QQPCRTP`）、且「内存完整性」（HVCI）是**开**的，两者都是 Chromium 沙箱的常见对手；`--disable-gpu` / `--disable-gpu-sandbox` / `--in-process-gpu` **都没用**（挂的是主进程那个沙箱）。修法：启动器**先按正常方式起，8 秒内看到 0x80000003 就自动换 `--no-sandbox` 再来一次**（实测崩在 1 秒内，探 8 秒足够；第一次仍保留沙箱，不因为一台机器的问题让所有人一起降级），并把原因和"怎么彻底修好"用人话打出来。**2026-10-06 补**：这句话每次启动都会重演一遍（对一台**已知**沙箱起不来的机器就是噪音），所以现在第一次试出来之后会写一份 `runtime\sandbox-fallback.txt`，之后直接按"关掉沙箱"启动、只留一行灰字说明；删掉那个文件（或跑 `-Check`，它会在沙箱恢复时自动删）就能重新试一次沙箱。`tools\launch-gui.ps1 -Check` 可以只体检、不开窗口 |
| ★ **静态断言必须先把注释剥掉** | `check-launchers` 里那条"没有退回 `& $electron` 那种写法"，第一版直接对整个文件跑正则 —— 结果被启动器注释里那句「**绝对不能**写成 `& $electron $appDir`」判成违规（自己写下的反面教材把自己告了）。断言的对象是**代码**，不是文本：先剥掉整行 `#` 注释与 `<# #>` 块再判 |
| ★ **自检注入的 `NODE_OPTIONS` 会把"体检"类子进程带偏，造出假绿** | `check-launchers` 第三节要用真的 `electron.exe` 探一次沙箱，而自检自己就是靠 `--import register-electron-stub.mjs` 跑的，这个变量会被子进程继承 —— 真 Electron 加载了那个 stub，于是 `--version` 打印出**stub 的假版本号 `v24.21.0`、退出码 0**，体检报告"沙箱正常"，而真相是这台机器沙箱根本起不来。**凡是要探测"没有我们的东西在场时会怎样"，都要先把我们注入的环境摘干净**（这里 `delete env.NODE_OPTIONS` / `ELECTRON_RUN_AS_NODE`；`launch-gui.ps1` 里同样先清这两个变量） |
| 🔴 **本地测试服会随机把 mineflayer 客户端踢下线** | `testserver\logs\latest.log` 里 `lost connection` 的原因统计：`Disconnected` 237 次、`You logged in from another location` 2 次、**`Invalid move player packet received` 11 次**（测试玩家和我们的 bot 都会被踢，有一次 Steve 活了 1 秒）。后果不是"测试挂了"，而是**测试静默地失去观察能力**：`headless-multibot` 那条「A 的提示句数不对：期望 2 实得 1」查了半天，真相是 Steve 在收到第二句提示**之前**就被踢了，公屏一条都没收到 —— 断言数字是对的，错的是它把"我的测试玩家掉线"记成了产品缺陷。修法：测试客户端统一用 `makeTestPlayer()`（`end` 事件后 800ms 自动重连、`saw[]` 跨重连共享、`kicked` 记原因），`say()` 先等 `spawned` 再发（等不到就明说"这句话没发出去"，**绝不对着死客户端 `chat()`**），每条断言失败时贴一句 `kickNote()` 写明"期间被踢过几次、最后一次为什么" |
| 🔴 **`getSecret()` 在真 Electron 之外必然返回空** | 密文是 DPAPI 加密的，只有 Electron 的 `safeStorage` 能解。用 electron stub 跑探针查"用户到底填没填 Key"，看到的是 `present:false` —— **这是探针的假阴性，不是用户没填**（真记录在 `runtime\secrets.json` 里明明是 `{enc:true, v:"v10…"}`、140 字节）。判据只能是"在真 Electron 里 `getSecret()` 取不取得到值" |
| ★★ **`safeStorage` 的解密材料跟着 `userData` 目录走** | 探针即使跑在真 Electron 里，如果 `app.setPath('userData', …)` 指向的**不是真应用那个目录**（`runtime\electron-userdata`），照样解不开、照样报 `hasKey=false`。做这类探针必须**和真应用共用同一个 userData** |
| ★★ **Electron 主进程脚本默认 userData 在 `%APPDATA%` 下，本环境写不进去 → 直接 `0xC0000005` 崩掉** | 表现极具误导性：脚本刚开始执行就崩，`app.whenReady()` 不触发、**没有任何错误输出**，看起来像"Electron 在这台机器上根本跑不了"。而真应用（`app\electron\main.mjs:35-37`）早把 userData 收进项目里了，所以它一直好好的 —— 差别就在那一行 `app.setPath('userData', …)`。所有"最小复现"都栽在这里 |
| ★ **Windows 上 `electron.exe` 是 GUI 子系统程序，重定向也拿不到它的输出** | `*> log`、`Start-Process -RedirectStandardOutput`、cmd 的 `&` 重定向，全都是 **0 字节**。这类探针必须**把结果写进文件**，别指望 stdout。另外 `cmd /c "… & echo EXIT=%ERRORLEVEL%"` 里的 `%ERRORLEVEL%` 是**解析期展开**的，打出来的永远是命令执行前的旧值 —— 想拿退出码就用 `System.Diagnostics.Process` + `WaitForExit()`（`launch-gui.ps1` 里那套） |
| ★ **"用户说填好了 Key"要用真调用验，不要猜** | `tools\keyprobe\`（一个最小 Electron 应用壳）会解密 Key、看形态、检查 UI 有没有漏明文，并**真的调一次 DeepSeek**（`max_tokens:1`）打印 `HTTP 状态 / 耗时 / usage`。跑法：`app\node_modules\electron\dist\electron.exe tools\keyprobe --no-sandbox`，结果在 `tools\keyprobe\key-verify-report.txt`（退出码 0=能用 / 2=解不开 / 3=接口报错）。实测用户那把 Key：`sk-…4874`（长度 35、非占位符）、`HTTP 200 / 187ms`、`prompt=9 completion=1`。**备用死路**：试过用 PowerShell 的 `ProtectedData.Unprotect` 直接解（CurrentUser / LocalMachine × 有无熵四种组合）全是 `The data is invalid`，这条路走不通 |
| 🔴🔴 **用 PowerShell 的 `Get-Content` / `Set-Content` 往返改文件，会把中文和换行一起毁掉（不可逆）** | 这个开发环境的 `pwsh` 实际是 **Windows PowerShell 5.1**：`Set-Content -Encoding utf8` 会**加 BOM**，而 `Get-Content` 读**无 BOM 的 UTF-8** 时按 **GBK(936)** 解码。于是"读出来改一处再写回去"会：中文变 `鈥斺€?` 乱码，**并且落在行尾的多字节字符留下悬空引导字节、把紧随的 `0x0A` 当尾字节吃掉** → 换行被吞、多行并成一行、连字符串的收尾引号都没了。实测把 `tools\bootstrap.mjs` 从 488 行毁成 449 行、`node --check` 报 `SyntaxError: Unexpected token ':'`，**而且不可逆**（只能靠反压缩原文救回来）。**规则**：改文本只用 `edit` / `write` 工具或 `node -e`；判断行数/内容也只用 node（`(Get-Content 文件).Count` 在无 BOM 的 UTF-8 上会少报行数） |
| ★ **乱码哨兵 + 显式豁免** | `tools\check-launchers.mjs` 第二节之二会扫 108 个文本文件（跳过 `node_modules` / `runtime` / `vendor`）找 20 多个 GBK 乱码特征字（≥3 次或 ≥2 种才算），命中就报红并告诉你怎么救。有的文件**必须照引乱码**（`docs\08` §7i.1 存着用户那次报障的原文，乱码本身就是证据）—— 这类文件在开头写一行 `moji-scan:ignore` 显式声明豁免，而不是让哨兵闭嘴 |
| ★★ **一句坏掉的脚本，报出来的却是别的原因** | 用户双击 `启动.cmd` 时 `tools\bootstrap.mjs` 已被上一条那个坑毁掉，Node 抛 `SyntaxError`，而启动器把整个失败说成「依赖没补齐（上面是它们自己报的原因）」—— 用户看到的是"网络问题"，真相是"文件坏了，要重新下载源码"。修法：启动器在跑 bootstrap 之前先 `& $node --check $bs`，坏了就用 5 行大白话说明"项目文件坏了 / 多半是下载不完整或被记事本存坏 / 重新解压覆盖即可"。**"报错信息说的原因"必须和"真正的原因"对得上，否则它比不报错更贵** |
| ★ **`\s` 会跨行，于是断言可以被"隔壁行"满足** | 刚写的"启动器必须先 `node --check`"那条不变量用了 `/--check\s+\$bs/`，而启动器里另有一行 `Say '【依赖清单（tools\bootstrap.mjs --check）】'` 与下一行的 `$bs…` —— **把被断言的那句代码整段删掉，断言照样通过**（负数验证当场抓住：删了不报红）。凡是钉"某句代码还在不在"的正则，空白一律写 `[ \t]+` / `[ \t]*`，不要用 `\s`。做负数验证这件事本身，就是能发现这类"形同虚设的断言"的唯一办法 |
| ★ **17 套一起红，可能是环境不让起子进程** | 在受限沙箱里跑 `tools\run-all-tests.mjs`，17 套全是 `退出码 null（spawnSync … EPERM）` —— 因为 Node 的 `spawnSync` 默认用**管道**收输出，而受限模式禁止建命名管道。**一行被测代码都没跑到**。运行器现在会把"全是 EPERM"和"真的挂了"分开说；要跑就逐套直接跑（PowerShell 的 `*>` 重定向不受这个限制）。同类坑：`electron.exe` 的沙箱探测也会 EPERM，那不是"Electron 坏了" |
| 🔴 **脚本里对用户承诺的事，代码里必须有** | `tools\install-node.ps1` 下载失败时会说「手动下好 `node-v22.23.3-win-x64.zip` 放到 runtime\，**再跑一次本脚本，它会跳过下载直接用这个 zip**」—— 而第一版代码**从来没有检查过已存在的 zip**（总是先下载再覆盖）：这句话把用户送进一个永远走不通的循环。修法：加 `if (Test-Path $zip) { 跳过下载 }` 分支（成功后也不删用户自己放的那份），并补 `curl.exe` 作为 WebClient 之外的第二条下载路。**是"冷目录真装一次"把它抓出来的** —— 只读代码看不出来，因为文案和实现分居两处 |
| ★★ **"克隆者拿到的是什么"只能靠冷目录验，而本沙箱里 `git clone` 是坏的** | `git clone D:\mc_cold_run` → `fatal: could not create work tree dir … Permission denied`（沙箱只许写工作区内）；换到工作区内仍失败：`D:\Git\usr\bin\sh.exe: *** fatal error - couldn't create signal pipe, Win32 error 5`。`git archive` + 系统 `tar.exe` 也**不能**用：bsdtar 按 GBK 解释 tar 里的 UTF-8 文件名，`启动.cmd` 变乱码名、还报 `Invalid empty pathname`（304 个文件只解出 299 个）。**可行姿势**：`git -C <仓库> checkout-index -a -f --prefix="<某空目录>/"` → 304 文件、中文名正常（文件名由 git 自己写，不经 tar）。冷目录里跑 `check-launchers`（EXIT=0，4 个启动脚本字节全对）与 `bootstrap --check`（EXIT=1，如实报三样都缺）才叫验证过 |
| ★★ **npm 报的失败原因常常是 `Exit handler never called!`** | 冷装引擎依赖时 npm 最后只吐这一句"The error is with npm itself"，看着像 npm 坏了；真因在它自己的调试日志里：`ERR_TLS_CERT_ALTNAME_INVALID`（这台机器的网络上有代理换证书）。修法：`bootstrap.mjs` 的 `npmFailureHint()` 读 `runtime\npm-cache\_logs\*-debug-0.log` 尾 200KB，把 `ERR_TLS…`/`ENOTFOUND`/`ETIMEDOUT`/`401`/`ENOSPC` 翻成人话附在错误里；并且**直连失败后自动换 `https://registry.npmmirror.com` 再试一次**（lockfile 里的完整性哈希不变，换源不会让版本漂移） |
| ★ **窄化的跑法要有窄化的判据** | `bootstrap.mjs --only node` 明明那一步装好了，收尾却用"应用整体环境自检"判红、退出码 1（引擎依赖当然还缺）—— 用户/脚本会以为 Node 没装上。修法：`--only` 时最终体检只作**说明**打出来、退出码按"点名的步骤是否都就绪"给 0，并补一句"想一次补全就跑 `node tools\bootstrap.mjs`"。**判据的宽窄必须和用户这次要的东西一致** |
| ★ **本沙箱里所有子进程的外网 HTTPS 都被换证书，联网步骤验不了** | `curl.exe https://nodejs.org/…` → `curl: (35) schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS`；`Invoke-WebRequest` → `基础连接已经关闭: 接收时发生错误`；Node → `Hostname/IP does not match certificate's altnames`（npm 的 `ERR_TLS_CERT_ALTNAME_INVALID` 是同一件事）。只有显式 `NODE_TLS_REJECT_UNAUTHORIZED=0` 才通（实测 `registry.npmjs.org/-/ping` → 302）。**绝不要为了让本机验证通过而在项目代码里关掉 TLS 校验** —— 那会把"装不上"变成"装上了但不知道装的是什么"；这类步骤如实记为"只能在用户机器上验" |
| ★ **Git 连不上 GitHub，坏的是 `schannel` 后端而不是网络** | 默认后端：`git ls-remote https://github.com/…` → `fatal: unable to access …: schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS (0x8009030e)`（和上面 `curl` 同一个原因）。**加 `-c http.sslBackend=openssl` 读就通了**（实测 EXIT=0，读回 `refs/heads/main` = 本地 `HEAD`）。**但推送还差一样东西：登录凭据** —— 这个环境弹不出浏览器/Git Credential Manager，`push` 只会说 `could not read Username for 'https://github.com': terminal prompts disabled`（`sh.exe: couldn't create signal pipe, Win32 error 5`），所以推这一步由你来跑。另：本机**没有** `~/.ssh`、**没有** `gh` CLI、Git 不在 PATH（`D:\Git\cmd\git.exe`）。本仓库已推完：<https://github.com/Exus1aiiii/Minecraft_company_bot>（公开，`main`） |
| ★ **"直连失败退镜像"要报的是两次的原因，最后一次放前面** | 换 `registry.npmmirror.com` 重试时真实失败原因变成了 **404**：`minecraft-assets@1.19.0` 这个包镜像上根本没有（`npm error 404 Not Found - GET https://cdn.npmmirror.com/packages/minecraft-assets/1.19.0/…`）。而第一版只把**第一次**（`ERR_TLS…`）的原因摆出来，用户会照着"关代理"去修一个其实不缺的代理问题。修法：`npmWithMirror()` 把两次失败都打出来，`npmFailureHint()` 增加一条 404 规则（"镜像没同步全这个包，不是你的错"） |
| ★ **写进源码里的正则，用正则去检它会被转义吃掉** | 新断言想检 `bootstrap.mjs` 里那条 404 规则，写成 `/\bE404\b/.test(src)` —— 永远不成立：源码里那是**字面量** `\bE404\b`，而 `\b` 是词边界，`b` 和 `E` 都是词字符，边界根本不存在。**检源码里的正则，只能按"这段字面量在不在"来检**（`src.includes('E404')`），别把它的元字符当元字符用 |
| 🔴 **负数验证工具的"备份只在第一次写"会把中间新写的功能一起抹掉** | `runtime\tmp\neg2.mjs` 原先是"没有备份才写"，隔一天再用它：`patch` 一个字符串、`restore` 一还原，**这中间新加的 `npmWithMirror` + 404 规则整段消失**（`check-launchers` 的一条新断言当场报红才发现）。修法：每次 `patch` 都**刷新**备份（还原点 = "这次改动之前"）。**"故意弄坏再改回来"这类工具，还原点必须是紧挨着这一次改动的快照** |
| 🔴 **升级 npm 路径的每一次改动后，都要重跑 `check-launchers`（而不是只看 `--check`）** | 上面那次"被还原抹掉"之所以能发现，是因为 `check-launchers` 里有针对新代码的静态断言（20 条）。`bootstrap.mjs --check` 同一时刻是**绿的** —— 它只体检"依赖装没装"，不看代码里少了什么。**"体检绿"不等于"我刚写的东西还在"** |
| 🔴🔴 **引擎用 `once('kicked'/'end')` 抢在我们前面 `process.exit(1)`，所以后面挂的监听器永远收不到断线事件** | 用户报"bot 受伤后立刻退出、过一会儿又自己进来"，`runtime\logs\bot-xiaodou.jsonl` 里却**一条 `mc/kicked`、`mc/end` 都没有**（事件日志是同步 `appendFileSync`，写过就一定在盘上 —— 没记录就是监听器从没被调用）。真因：`vendor\mindcraft-develop\src\agent\agent.js:69-89` 在 `start()` 里注册 `this.bot.once('kicked'|'end', …)`，回调里直接 `process.exit(1)`；而门的监听器是在 `_setupEventHandlers` 之后才挂的，**排在它后面**。修法：`bot.prependOnceListener(...)` 抢到最前面（新模块 `runner\kick-reason.mjs` 把原因翻成人话，日志里是 `[MCBOT-KICK] …`）。**"事件没上报"先分清是"没发生"还是"监听器没轮到"** |
| 🔴 **`Disconnected: [object Object]` 是引擎自己没读懂服务器的踢人原因** | 1.21.1 的 kick reason 是 protodef 解出来的 `{type:'compound', value:{translate:{type:'string', value:'multiplayer.disconnect.xxx'}}}`；`connection_handler.js` 的关键词表匹配不上时走 `fallback = obj.translate \|\| … \|\| (obj.value?.translate)` —— `value.translate` 是**对象**，进模板字符串就成了 `[object Object]`。解码时要注意：`{type:'string', value:'…'}` 在 `translate` 字段里是**key**，在别处是**文字**（第一版混着处理，单测当场报 9 条红）。认不出的 key 要原样摆出来，不许套用别的已知原因 |
| ★ **`includes('[某标记]')` 检不到写在正则字面量里的标记** | `supervisor.mjs` 里写的是 `/\[MCBOT-KICK\]/i`，也就是字面量 `\[MCBOT-KICK\]` —— `text.includes('[MCBOT-KICK]')` **为假**。这跟 `\bE404\b` 是同一个坑：**检源码里的正则/转义串，要按"实际那串字符在不在"去检**（这里改成 `includes('MCBOT-KICK')`），或者干脆断言"表里那一行"（`/'key'[ \t]*:/`），否则注释里出现同一个名字就能把断言喂饱 |
| ★ **"没有退回旧写法"这类负条件，要按行首锚定或真的剥注释** | 门里那段注释写着"原来是这样写的 `bot.on('kicked'\|'end', …)`"，拿整份文本跑 `/bot\.on\('kicked'/` 就会被自己的注释判红（与 §174 的 `& $electron` 同一个教训）。第一版为此写了个 JS 剥注释器，结果它被正则字面量里成对的引号（`/["']/`）带偏、剥不干净 —— **没有价值的复杂度**。最后用 `/(^\|\n)[ \t]*bot\.on\('kicked'/` 按行首锚定：这个仓库的注释一律以 `//` 开头，代码语句顶着缩进，一次分干净 |

| 🔴🔴 **"生成物"一旦被跟踪，你在真机上跑一次它就带上真实数据** | `runner/profiles/<botId>.json` 是启动器每次运行按 `runtime/config.json` 重新生成的（主人名单 = 你的游戏 ID）。它被跟踪进了首个提交，然后在真机上跑过一次 —— 工作区版本就带上了**真实游戏 ID**，再 `git add .` 就是泄露（发布体检 13 条红线把它揪出来）。修法：`.gitignore` 加 `runner/profiles/` + `git rm --cached` 那三个文件。**核实过没发出去**：`git grep -l -F 'Exus1ai' 4bb2c8b` 只命中作者署名 |
| 🔴 **假红线比漏报还贵：它教会你"这些红的忽略就好"** | `check-publish` 曾一边报**真泄露**、一边把 `vendor/…/bots/Xiaodou/*`（引擎运行时生成）也算成"会提交的文件"。根因是它自己的 `.gitignore` 解析器只读根目录那一份（引擎的 `bots/**/` 没生效），且把每个 `*` 都翻成 `[^/]*`（`bots/**` 只匹配一层）。修法：`loadIgnoreRules(prefix)` 支持子目录 + `globToRe` 单独处理 `**`。修完 `会提交 303 个文件 / 3.90 MB`，与 `git ls-files --cached --others --exclude-standard` 数出来的一致 |

## 本机环境

| 项 | 版本 / 路径 | 备注 |
|---|---|---|
| 引擎运行时 Node | **v22.23.3**（`runtime\node-v22.23.3-win-x64\`） | 不能用系统的 v24.15.0；引擎依赖要求 `>=22` |
| 系统 Node | v24.15.0（`D:\nodejs\`） | 仅供工具脚本使用 |
| Java | Temurin JRE 21（`runtime\jdk-21.0.12.1+1-jre\`） | 路径记在 `runtime\java-home.txt`；**Java 自身 TLS 不可用** |
| Electron | **44.5.1**（`app\node_modules\electron\dist\electron.exe`） | 由 `tools\bootstrap.mjs` 自动装（官方源失败会退 `npmmirror` 镜像；`app\package.json` 里没锁死二进制，postinstall 现下，见 `docs/07`） |
| Electron 沙箱 | **起不来**（带沙箱 `0x80000003`，关掉沙箱正常） | 本机实测：腾讯电脑管家在跑 + 内存完整性开着。启动器会自动改用 `--no-sandbox` 重试，**不影响使用**；想恢复沙箱就把本目录加进安全软件信任名单，或关掉内存完整性后重启（`tools\launch-gui.ps1 -Check` 可复验） |
| 测试服务端 | 原版 MC 1.21.1，`127.0.0.1:25565`，离线模式 | 目录 `testserver\` |
| Python | 3.14.5 | |
| git | **2.56.0.windows.1**（`D:\Git\cmd\git.exe`） | **不在 PATH 里**，用全路径调；仓库已 `git init -b main`（`core.autocrlf false`、本地 `user.name/email` 已配），首个提交 `dbf6bc8`、304 文件。`.gitattributes` 写的是 `* -text`，专门防止换行被转换（`check-launchers` 查的是字节） |

## 常用命令

```powershell
$node = 'D:\mc_company_bot\runtime\node-v22.23.3-win-x64\node.exe'

# ① 启动应用（你会用到的主要就这一条）
.\启动.cmd

# ② 不装 Electron 也能先看界面长什么样（浏览器直开 http://127.0.0.1:8899）
.\预览界面.cmd

# ③ 无头自检（我用来替代"看窗口"的验证手段）—— 一条命令跑完全部十七套
& $node tools\run-all-tests.mjs
# ↑ 约 2 分钟（脚本自己决定哪几套要挂 electron stub，所以**不要再手动加 --import**）。
#   可以只跑指定的几套：… run-all-tests.mjs test-speak check-imports
#   ★ 每套都必须打出自己的汇总行才算过（只看退出码会把"什么都没跑"当成"全跑通了"）
#   ★ 失败时它会把**红掉的那几行原文**打出来（stdout + stderr 一起找）——
#     看不见失败的失败报告等于没有报告
#   想看明细就直接单独跑下面这些：

& $node devtools\render-headless.mjs
& $node --import ./devtools/register-electron-stub.mjs devtools\headless-main.mjs
# 加 MCBOT_HEADLESS_REAL_ENGINE=1 会真的起一个引擎进程（默认指向本地假模型，绝不打真 API）
& $node tools\test-vocab.mjs
# ↑ 中文采集词典单元测试：37 条词条逐个拿引擎自己的 minecraft-data 校验方块 id 真实存在
& $node tools\test-builder.mjs
# ↑ 建造器单元测试 32 项：放方块顺序不变式、屋子几何、材料核算、选址（含"整块地基都要空"）
& $node tools\test-explorer.mjs
# ↑ 探险器单元测试 34 项：中文方向解析、不往水里跳、分段短跳、被叫停不算走完、汇报不许编
& $node tools\test-memory.mjs
# ↑ 记忆模块单元测试 68 项：去重、约定优先保留、中文二元组检索、意图识别、自动捞取、落盘
& $node tools\test-workshop.mjs
# ↑ 工坊单元测试 129 项：配方拿引擎自己那份 minecraft-data 逐条校验、材料核算、步骤合并与排序、
#   烧炼（"铁镐 → 3 铁锭 → 3 原铁矿"的账要一层层算对）、"引擎说做成了但背包没变"必须判失败
& $node tools\test-speak.mjs
# ↑ 回执翻译单元测试 66 项：把 54 条模板还原成引擎源码里的样子、反向校验它确实存在、
#   数字一个不改、认不出的原样返回英文、词典里的名字必须与翻译层完全一致
& $node tools\test-self-report.mjs
# ↑ 本地汇报单元测试 69 项：坐标/血量/群系/天气怎么念、空背包怎么说、
#   护甲部位怎么数、**读不到的值不许编一个**、句子里不许留英文下划线
& $node tools\check-imports.mjs
# ↑ 静态检查："用了某个名字但忘了 import"（这类 bug 只在运行时的某条分支上才炸，
#   `node --check` 只做语法分析、看不见作用域，单测也拦不住）
& $node tools\check-speak-coverage.mjs
# ↑ 反向覆盖检查：①从引擎源码里抠出全部 143 句 `log(bot, ...)`，逐句喂进翻译层，
#   翻完还剩英文的就是漏网的；②玩家能敲的 55 条 `!命令` 逐条登记——要么我们抢前接管
#   （`LOCAL_REPORTS`），要么在 `ENGINE_ONLY` 里写清楚为什么交给引擎，**没登记的报错**
#   （还会反向查"登记了但引擎里已经没有"的过期条目）
& $node --import ./devtools/register-electron-stub.mjs devtools\test-firstrun.mjs
# ↑ 首跑链路单测 51 项：出厂主人名单怎么认、"配没配过"三档怎么推、落盘再读回来标记还在不在、
#   未认领时喂给人格提示词的名字必须是空（不能管用户叫 Steve）、校验仍然不许空名单、
#   以及密钥的三种状态分得清（真 / 像假的 / 没填，且真密钥不许被误判）
#   （这条链路任何一段丢字段，用户看到的现象都是"喊它一声不吭"，而且**不报任何错**）
& $node tools\check-launchers.mjs
# ↑ 启动脚本检查，三节：①**字节**——`.cmd` 必须纯 ASCII+CRLF、`.ps1` 必须带 UTF-8 BOM+CRLF
#   （加 --fix 只改字节不改内容）②**内容不变量**——启动器必须还在"等进程结束 / 认得出
#   0x80000003 / 崩了自动换 --no-sandbox 重试 / -Check 真的跑一次 Electron"这条路上
#   ③**沙箱体检**——用真 electron.exe 探一次，只报告不判失败（这是机器环境，不是我们的代码）
& $node --import ./devtools/register-electron-stub.mjs tools\clean-fake-keys.mjs
# ↑ 清掉 secrets.json 里"早期自检写进去的假密钥"（只删判定为假的，像真的一律不动）。
#   留着它的后果是界面上显示成「已保存（sk-…fake）」，用户以为密钥填过了
& $node --import ./devtools/register-electron-stub.mjs devtools\headless-multibot.mjs
# ↑ 多 bot 并行：真起两个 bot 在同一台服，验证端口不撞、唤醒不串台、关一个不带崩另一个
& $node --import ./devtools/register-electron-stub.mjs devtools\headless-multiserver.mjs
# ↑ 多服务器并行：两个 bot 分处 25565 与 25566，验证各连各的、跨服零串台（缺 25566 时自动跳过）
#   后三个脚本都会把用户数据目录整个重定向到 runtime\tmp\sandbox-selftest\（物理隔离，
#   跑完还会 SHA256 断言你的 config.json / secrets.json 一个字节没变）
& $node --import ./devtools/register-electron-stub.mjs tools\sync-launch.mjs
# ↑ 把 runner\bots\*.launch.json 的规则表同步成 store.mjs 的 DEFAULT_RULES（加了新规则后跑一次）

# ③c 用一个假玩家在游戏里跟 bot 说话（验收 A2/A3/A5、中文采集指令、盖房子、探险、记忆都靠它）
& $node tools\test-player.mjs --name Steve --gap 12000 `
    --say "小豆 去砍点木头" --say "小豆 !inventory" --say "小豆 盖个房子" --say "小豆 四处走走"
& $node tools\test-player.mjs --name Steve --gap 6000 `
    --say "小豆 记住我喜欢钻石" --say "小豆 你还记得我喜欢什么吗"

# ③d 换一个客户端，从方块层面把刚盖的房子读回来（"被告的自述"不算证据）
& $node tools\inspect-build.mjs --x -16 --y 112 --z -4 --w 3 --d 3 --h 2

# ③b 万一配置真被改坏了，用这个修回来（默认只体检，加 --apply 才改）
& $node tools\fix-config.mjs

# ④ 启动测试服务端
cmd /c "cd /d D:\mc_company_bot\testserver && <jre>\bin\java -Xmx2G -jar server.jar nogui > vanilla.log 2>&1"

# ⑤ 协议栈自检（离线）→ 服务器 ping 自检（需要服务端在跑）
& $node tools\probe-protocol-stack.mjs 1.21.1
& $node tools\probe-server-ping.mjs 127.0.0.1 25565 1.21.1

# ⑥ 本地假大模型（零成本验证）+ 引擎 + 假玩家
& $node tools\mcbot-fake-llm.mjs --port 8799
# ★★ 手工起引擎时，门禁必须自己注入 —— 应用里是 supervisor.mjs 干的这件事。
#    不注入的话你测的是**没有我们这一层**的裸引擎（中文指令会直接走大模型）。
$env:MCBOT_LLM_API_KEY = 'sk-test-fake'      # 应用里由主进程注入
$env:NODE_OPTIONS = '--import file:///D:/mc_company_bot/runner/mcbot-gate.mjs'
& $node runner\engine-launcher.mjs --bot-json runner\bots\xiaodou.launch.json
# 起来了就该在事件流里看到「已上线，守卫 1 位主人」；看不到就是门禁没装上。
& $node tools\test-player.mjs --name Steve --say "小豆 你好呀"
# 中文汇报这两条（零 token，走本地）：
& $node tools\test-player.mjs --name Steve --gap 10000 `
    --say "小豆 报一下坐标" --say "小豆 !stats" --say "小豆 看一下背包" --say "小豆 !inventory"

# ⑦ 看事件流（中文正确显示，别用 Get-Content）
& $node tools\mcbot-inspect.mjs summary bot-xiaodou
& $node tools\mcbot-inspect.mjs events bot-xiaodou 30

# ⑧ 发布体检：如果现在 `git add .` 并推到 GitHub，会漏出去什么？
& $node tools\check-publish.mjs            # 加 --list 会列出每一个会提交的文件
# ↑ 回答的是一个很具体的问题，分两档：
#   ✗ 红线（退出码 1）—— 真密钥、你的游戏 ID、secrets.json/keys.json 本身会进仓库
#   ! 留意（不影响退出码）—— 你的服务器地址出现在文档里、还没有 LICENSE…
#   ★ 本机专属的值**不写死在工具里**，每次从 runtime\config.json 现读 —— 否则体检工具
#     自己就成了下一处泄漏。反向验证过：往里塞一条真密钥形态的串，它立刻报红线并退出 1。
#   配套：THIRD-PARTY.md（第三方归属：引擎 MIT © 2024 Kolby Nottingham，不许删）
```

