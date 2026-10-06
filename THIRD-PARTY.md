# 第三方组件与许可（THIRD-PARTY）

这个项目**建立在别人的开源工作上**。这份文件说明用了什么、分别是什么许可、我们改没改。
发布（哪怕是只发源码）之前请保留这份文件，也请保留 `vendor/mindcraft-develop/LICENSE`。

---

## 一、核心：Minecraft 操控引擎 Mindcraft（vendored，未修改源码）

| 项 | 内容 |
|---|---|
| 项目 | **Mindcraft** —— 用大模型操控 Minecraft bot 的开源方案 |
| 上游 | <https://github.com/mindcraft-bots/mindcraft> |
| 我们的副本 | `vendor/mindcraft-develop/`（源码约 3 MB） |
| 许可 | **MIT License，Copyright (c) 2024 Kolby Nottingham**（原文见 `vendor/mindcraft-develop/LICENSE`，1073 字节） |
| 我们的改动 | **没有改它的源码**。四处加固（V-1a/V-1b/V-2/V-3）都是"运行时注入 + 改模块属性 + 在我们自己这层包一层"，`npm install` 冲不掉，vendored 副本保持干净 |

MIT 的要求是：**再分发时保留版权声明与许可原文**。我们按原样保留了 `LICENSE`；
如果你发布时**删掉了 `vendor/`**（只发我们自己的代码），请在这份文件里保留上面这一节，
并说明"引擎需自行从上游获取"。

⚠️ 注意：`vendor/mindcraft-develop/node_modules/`（714 MB）**不入库**，也不应随发布分发 ——
依赖由使用者在本地 `npm install` 得到（见路线 B 的 `tools\bootstrap.mjs`）。

## 二、引擎的依赖（不进我们的仓库，由 npm 拉取）

引擎 `package.json` 有 30 个直接依赖。挑几个关键的说清许可类别（版本为本机实测）：

| 包 | 版本 | 许可 |
|---|---|---|
| `mineflayer` | 4.33.0 | MIT |
| `minecraft-protocol` | 1.68.0 | **BSD-3-Clause**（不是 MIT，归属条款不同） |
| `minecraft-data` | 3.117.0 | MIT |
| `prismarine-world` / `-chunk` / `-block` / `-item` / `-entity` / `-physics` / `-chat` / `-registry` / `-windows` | 3.7.0 / 1.41.0 / 1.23.0 / 1.18.0 / 2.6.0 / 1.11.1 / 1.13.0 / 1.12.0 / 2.10.0 | MIT |
| `vec3` | 0.1.10 | BSD |
| `yaml` | 2.9.1 | ISC |
| `express` | 4.22.3 | MIT |
| `socket.io` | 4.8.4 | MIT |

这些包**不会**出现在我们要发布的仓库里（`node_modules/` 已 ignore），
但它们会随运行环境出现在使用者的机器上 —— 常规做法是在 README 里点明"依赖均为宽松许可（MIT/BSD/ISC）"。

## 三、运行时与外壳

| 组件 | 版本 | 许可 | 是否入库 |
|---|---|---|---|
| **Electron** | 44.5.1（`app/package.json` devDependency） | MIT | 否（`app/node_modules/` 379.9 MB，已 ignore） |
| **Node.js** | 本机备了两个：`runtime/node-v22.23.3-win-x64`（引擎用它跑）、`runtime/node-v20.20.2-win-x64` | MIT（含若干第三方声明，见发行版内 `LICENSE`） | 否（`runtime/` 已 ignore） |
| **Eclipse Temurin JRE** | `runtime/jdk-21.0.12.1+1-jre`（本地测试服要它） | GPLv2 + Classpath Exception | 否（同上） |

上面这三样都**不随仓库分发**，而是由使用者第一次启动时按需下载：
Node 走 `tools\install-node.ps1`（nodejs.org，下不到时退到 npmmirror 镜像，并校验 `SHASUMS256.txt`），
Electron 走 `app/package.json` 的 devDependency（npm 官方源，失败时退到 npmmirror 的 electron 镜像，
`tools\bootstrap.mjs` 里管这两条回退路线）。下载下来的都是**原版发行物**，我们没有改。

## 四、Minecraft 本身

- 我们**不分发** Minecraft 客户端、服务端 jar 或任何 Mojang 资源。
  `testserver/`、`testserver2/`（各 189 MB，含 `server.jar`）已列入 `.gitignore`；
  本项目的"多服务器自检"需要它们，但那是**开发期本机的东西**，不是发布物。
- 使用者需要**自己拥有** Minecraft（正版账号，或在允许离线登录的服务器上玩）。
  项目里 `auth: "offline"` 是给"自己搭的服务器 / 允许离线登录的服"用的，
  这条边界请在使用说明里写清楚，别让人以为可以拿它绕过正版验证。

## 五、我们自己的代码

`app/`、`runner/`、`tools/`、`devtools/`、`docs/` 这些是我们写的，**已选择 MIT 许可**
（与引擎一致，最省事的组合）：仓库根目录的 `LICENSE` 是完整原文，README 顶部也写了这一行。

如果你（后来接手这份代码的人）想换成别的许可，注意两点：
- 想让"改了必须开源" → GPL-3.0 / AGPL-3.0。和 MIT 的引擎一起分发时整体可以是 GPL，
  但 `vendor/mindcraft-develop/` 那部分**仍然只保留它自己的 MIT 声明**（MIT 允许这么做）。
- 无论换成什么，`vendor/mindcraft-develop/LICENSE` 与这份文件都要留着 —— 那是 MIT 的硬要求。
