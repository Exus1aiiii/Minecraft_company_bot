# Mindcraft 引擎能力速查（`develop` 分支）

> 用途：设计与实现时的对照表。**本项目所有技能层设计都要以这份表为准**。
> 取证方式：全部直接取自 `raw.githubusercontent.com/mindcraft-bots/mindcraft/develop`。
> ⚠️ 取证过程说明：`src/agent/commands/actions.js` 曾抓取两次并逐行核对——第一次解析出的 `!goToPosition` / `!giveToPlayer` 是**错的**，实际命令名是 `!goToCoordinates` / `!givePlayer`。**凡是要写进代码的命令名，都必须以本表为准再核一次。**
> ❌ 不存在的路径（不要按它们去写代码）：`src/agent/memory.js`（实为 `memory_bank.js` + `history.js`）、`bots/andy/prompts/*.md`、`profiles/assistant.json`；`src/agent/settings.js` 只是 get/set 桩，**真实默认值在根 `settings.js`**。

---

## 一、命令全集

命令注册表在 `src/agent/commands/actions.js` 的 `actionsList`，每项形如 `{name, description, params{name:{type, description, domain?}}, perform}`。
**所有参数都是位置参数、且全部必填** —— `!cmd("str", 1, 2.5, true)`。
参数类型：`int` / `float` / `boolean` / `string` / `BlockName` / `ItemName` / `BlockOrItemName`（后三类由注册表校验合法性）。
多数动作经 `runAsAction(fn, resume, timeout)` 执行。`src/agent/commands/index.js` 把 `actionsList` 与只读的 `queries.js` 合并；`settings.blocked_actions` 会把命令从提示词文档里摘掉（但 `!stop` / `!stats` / `!inventory` / `!goal` **不可屏蔽**）。

### 移动 / 跟随（9）
| 命令 | 说明 |
|---|---|
| `!goToPlayer(player_name: string, closeness: float)` | 寻路到指定玩家 |
| `!followPlayer(player_name: string, follow_dist: float)` | 无限跟随（可恢复） |
| `!goToCoordinates(x: float, y: float, z: float, closeness: float)` | 寻路到精确坐标 |
| `!moveAway(distance: float)` | 朝任意方向远离当前位置 |
| `!goToRememberedPlace(name: string)` | 前往已保存的地点 |
| `!goToBed()` | 走到最近的床并睡觉 |
| `!goToSurface()` | 移动到上方最高方块处（通常即地表） |
| `!searchForBlock(type: BlockName, search_range: float)` | 找最近的目标方块并过去（范围最小 32） |
| `!searchForEntity(type: string, search_range: float)` | 找最近的实体并过去 |

### 采集 / 挖掘（3）
| 命令 | 说明 |
|---|---|
| `!collectBlocks(type: BlockName, num: int)` | 采集数量为 N 的目标方块（**10 分钟超时**） |
| `!digDown(distance: int)` | 垂直下挖；遇岩浆/水/坠落 ≥4 格会停 |
| `!useOn(tool_name: string, target: string)` | 对最近实体/方块/空气右键使用工具 |

### 合成 / 熔炼（3）
| 命令 | 说明 |
|---|---|
| `!craftRecipe(recipe_name: ItemName, num: int)` | 合成 N 次（会自行寻找/放置工作台） |
| `!smeltItem(item_name: ItemName, num: int)` | 在最近的或自建的熔炉里熔炼。⚠️ **成功后它会故意 `cleanKill('Safely restarting to update inventory.')`，500 ms 后重启进程** |
| `!clearFurnace()` | 清空最近熔炉的产物、原料与燃料 |

### 背包 / 箱子 / 物品（7）
| 命令 | 说明 |
|---|---|
| `!equip(item_name: ItemName)` | 装备到主手 |
| `!consume(item_name: ItemName)` | 吃 / 喝 |
| `!discard(item_name: ItemName, num: int)` | 走开 5 格、丢 N 个、再走回来 |
| `!putInChest(item_name: ItemName, num: int)` | 存入最近的箱子 N 个 |
| `!takeFromChest(item_name: ItemName, num: int)` | 从最近箱子取出 N 个 |
| `!viewChest()` | 打印最近箱子的内容与数量 |
| `!givePlayer(player_name: string, item_name: ItemName, num: int)` | 给玩家 N 个物品 |

### 战斗（2）
| 命令 | 说明 |
|---|---|
| `!attack(type: string)` | 攻击/击杀最近的该类实体（**`kill` 被硬编码为 `true`**） |
| `!attackPlayer(player_name: string)` | 攻击指定玩家直到死亡或逃走 |

### 建造 / 改世界（2）
| 命令 | 说明 |
|---|---|
| `!placeHere(type: BlockOrItemName)` | 在当前位放置**一个**方块（**不是用来搭结构的**） |
| `!newAction(prompt: string)` | 🔴 **让模型写 JS 并在宿主进程执行** —— 见第七节 |

### 任务控制 / 自我提示 / 社交（12）
| 命令 | 说明 |
|---|---|
| `!goal(selfPrompt: string)` | 设定自主目标（处于 bot 间对话时会挂起） |
| `!endGoal()` | 结束自我提示（目标达成） |
| `!stop()` | **强制停止所有正在执行的动作**（自我提示继续） |
| `!stfu()` | 停止所有聊天与自我提示，但保留当前动作 |
| `!restart()` | 重启 agent 进程（`cleanKill()`） |
| `!clearChat()` | 清空聊天历史 |
| `!stay(type: int)` | 原地待命并暂停全部模式；`-1` = 永久 |
| `!setMode(mode_name: string, on: boolean)` | **开关某个自动模式** —— 见第三节 |
| `!startConversation(player_name: string, message: string)` | 仅用于 bot 与 bot 之间 |
| `!endConversation(player_name: string)` | 结束该对话 |
| `!lookAtPlayer(player_name: string, direction: string)` | `"at"`=看向他 / `"with"`=同向看 |
| `!lookAtPosition(x: int, y: int, z: int)` | 看向坐标（视觉解释器，需视觉模型） |

### 记忆 / 村民（5）
| 命令 | 说明 |
|---|---|
| `!rememberHere(name: string)` | 把当前位置存进记忆库 |
| `!savedPlaces()` | 列出已保存的地点名（在 `queries.js`） |
| `!showVillagerTrades(id: int)` | 打开村民并列出交易 |
| `!tradeWithVillager(id: int, index: int, count: int)` | 执行第 index 项交易 count 次 |
| （只读查询） | `!stats`、`!inventory`、`!nearbyBlocks`、`!craftable`、`!entities`、`!modes`、`!savedPlaces`、`!getCraftingPlan`，以及 `!checkBlueprint` / `!checkBlueprintLevel` / `!getBlueprint` / `!getBlueprintLevel`（**这 4 个默认在 `settings.js` 的 `blocked_actions` 里**） |

### `collectBlock` 的别名规则（`skills.js`）
- `coal` / `diamond` / `emerald` / `iron` / `gold` / `lapis_lazuli` / `redstone` → 同时匹配 `<x>_ore`
- 任何 `*_ore` → 同时匹配 `deepslate_*_ore`
- `cobblestone` → `stone`；`dirt` → `grass_block`
- `lava` / `water` 只按源方块（source block）处理

> **仅技能层有、未暴露为命令的**（写代码时可直接调）：`pickupNearbyItems`、`activateNearestBlock`、`tillAndSow`、`useDoor`、`breakBlockAt`、`goToNearestBlock`、`moveAwayFromEntity`、`avoidEnemies`。

---

## 二、蓝图建造（`src/agent/tasks/construction_tasks.js`）

**蓝图结构**：
```js
blueprint = { name, levels: [ { name, placements: [[x,y,z,blockName], ...], adjacencies: [[x,y,z,x2,y2,z2,...], ...], type? }, ... ] }
```
- `placements`：该层要放的每一个方块；
- `adjacencies`：哪些邻居必须已存在 / 贴哪一面；
- 校验器**按层顺序推进**：一层完成的条件是**该层所有 placements 都已存在且 adjacencies 全部满足**。

**蓝图的四种来源**：`worldToBlueprint()`（扫描现实世界的某个区域转成蓝图）、`matrixToBlueprint()`（由方块矩阵生成）、`proceduralGeneration()`（程序化生成）、以及**任务 JSON**——注意**不是**从这个文件里的某个固定目录读的。
另有一种旧格式 `{blocks, offset}`，由 `src/agent/npc/controller.js` 从 `src/agent/npc/construction/` 下 `readdirSync` 读取。
关键 API：`getBlueprintLevel()`、`blueprint.explain()`（把目标建筑渲染成提示词文本：每层方块与数量）。

**🔴 任务只能进程启动，不能聊天启动**：
- **`!startTask` 这个命令不存在。**
- 流程是：`main.js --task_path <json> --task_id <id>` → `settings.task` → `src/agent/agent.js` 里 `new Task(this, settings.task, taskStart)`。
- `src/agent/tasks/tasks.js` 按类型分发：`construction` → `ConstructionTaskValidator`；`cooking` / `techtree` → `CookingCraftingTaskValidator.checkItemPresence(inventory)`；`hells_kitchen` 用 `task_id.endsWith('hells_kitchen')` 特判，进度持久化到 `./hells_kitchen_progress.json`。
- 建造任务会把 `blueprint.explain()` 追加进目标/对话，并**屏蔽 `!endGoal` / `!endConversation`** 直到建完。

---

## 三、自动模式（`src/agent/modes.js`）

`modes_list`，**按优先级排列**：

| 模式 | 作用 | 默认 |
|---|---|---|
| `self_preservation` | 逃跑/脱水上岸/离岩浆的反射，低血量时打断当前行为 | ✅ 开 |
| `unstuck` | 检测到无进展就重新寻路/跳跃 | ✅ 开 |
| `cowardice` | 遇敌对生物逃跑，而不是战斗 | ❌ 关 |
| `self_defense` | 自动攻击敌对生物 | ✅ 开 |
| `hunting` | 猎杀被动动物作食物 | ✅ 开 |
| `item_collecting` | 捡起附近掉落物 | ✅ 开 |
| `torch_placing` | 放火把保持光照 > 0 | ✅ 开 |
| `elbow_room` | 有人靠太近就后退 | ✅ 开 |
| `idle_staring` | 空闲时盯着附近的实体看 | ✅ 开 |
| `cheat` | `/setblock` 式捷径，仅 op/创造模式 | ❌ 关 |

默认值来自 `profiles/defaults/_default.json` 的 `"modes"` 键。模式可被技能 `pause`，并会被模型生成的代码读取（控制器明确警告该对象必须保持引用隔离，因为它"This object is accessible by LLM generated code"）。

> **对我们 GUI 的意义**：`!setMode(mode_name, on)` + 这 10 个模式，天然就是一套**"本能开关"面板**，可以直接做成 10 个复选态按钮，无需自研。

---

## 四、人格 / 提示词系统

**⚠️ 没有 per-bot 的 `.md` 提示词文件。提示词是 profile 里的 JSON 字符串键。**

`src/models/prompter.js` 按**三层合并**：
1. `profiles/defaults/_default.json`
2. `profiles/defaults/<base_profile>.json`（`base_profile` ∈ `survival` | `assistant` | `creative` | `god_mode`，`settings.js` 里默认 `"assistant"`）
3. **该 bot 自己的 profile**（默认 `./andy.json`）

合并后创建 `./bots/<name>/` 目录，并写出 `bots/<name>/last_profile.json`。

`_default.json` 里的提示词键：`conversing`、`coding`、`saving_memory`、`bot_responder`、`image_analysis`、`speak_model`（`"openai/tts-1/echo"`）、`modes`、`conversation_examples`、`coding_examples`，以及 `cooldown: 3000`。

提示词文本占位符：`$NAME` `$STATS` `$INVENTORY` `$ACTION` `$COMMAND_DOCS` `$CODE_DOCS` `$EXAMPLES` `$MEMORY` `$TO_SUMMARIZE` `$CONVO` `$SELF_PROMPT` `$LAST_GOALS` `$BLUEPRINTS`。

`num_examples`（默认 2）条示例是由 profile 的 `embedding` 键所配的嵌入模型**动态挑选**的。

> **对我们"人格面具编辑器"的意义**：可编辑面就是这些 JSON 键 + 占位符。`conversing` 是聊天人格的主入口，`bot_responder` 控制 bot 之间怎么互相应答。编辑器要能做三层覆盖关系（默认 → 基础档案 → 本 bot 覆盖）。

---

## 五、记忆系统（两层，都很薄）

**1. 地点记忆库**（`src/agent/memory_bank.js`）
- 就是一个 `name → [x, y, z]` 的字典：`rememberPlace()` / `recallPlace()`。
- `getKeys()` = `Object.keys(this.memory).join(', ')` —— **`!savedPlaces` / `!goToRememberedPlace` 的全部实现就这一个名字列表**。
- **这里没有任何向量检索。**

**2. 散文记忆**（`src/agent/history.js`）
- 每 `max_messages`（默认 **15**）轮之后，把 `summary_chunk_size = 5` 轮切片塞进 `saving_memory` 提示词让模型总结。
- 总结结果**被截断到 500 字符**，后缀原文：`...(Memory truncated to 500 chars. Compress it more next time)`。
- 嵌入只用于**示例/技能文档检索**（`SkillLibrary`，`relevant_docs_count: 5`）。

**持久化**：`./bots/<name>/memory.json`（memory、turns、self_prompting_state、self_prompt、taskStart、last_sender）+ 会话记录 `./bots/<name>/histories/<timestamp>.json`；由 `settings.load_memory`（**默认 `false`**）控制是否重载。

> **结论：Mindcraft 的"长期记忆"实际上只有"地名坐标表 + 每 15 轮压缩到 500 字的散文摘要"，且默认不加载。** 文档 01 里 R9（记忆缺失）不仅成立，而且比预想更弱——**要做真正的陪伴记忆（"上次我们一起找到的矿洞"），这一层必须我们自研**。这是本项目一个真实且明显的差异化机会。

---

## 六、开箱可行性判定

| 能力 | 判定 | 依据 |
|---|---|---|
| (a) 跟随玩家 | ✅ 可以 | `!followPlayer(player_name, follow_dist)` |
| (b) 前往坐标 | ✅ 可以 | `!goToCoordinates(x,y,z,closeness)`、`!goToRememberedPlace(name)` |
| (c) 挖 N 个指定方块 | ✅ 可以 | `!collectBlocks(type, num)`，且别名规则已处理 |
| (d) 给玩家物品 | ✅ 可以 | `!givePlayer(player_name, item_name, num)` |
| (e) 按配方合成 | ✅ 可以 | `!craftRecipe(recipe_name, num)` |
| (f) **按蓝图建房** | ⚠️ **仅部分** | 只能由**进程启动时**的任务文件驱动（`--task_path/--task_id`，type=`construction`）；**LLM 只能查看不能校验**（`!checkBlueprint` 默认被屏蔽）；自由建造只能靠 `!newAction` |
| (g) 打怪 | ✅ 可以 | `!attack(type)`（kill 恒为 true）、`!attackPlayer(name)` |
| (h) 箱子存取 | ✅ 可以 | `!putInChest` / `!takeFromChest` / `!viewChest` |

**"帮忙建造房屋"的准确现状**：蓝图机制**存在且是分层结构，设计正确**，但它是**"启动时下发一个建筑任务"**的模型，不是**"玩家在聊天框说'帮我盖个房子'然后 bot 就盖"**的模型。要满足用户需求，**必须由我们的应用层补上这一段**：把聊天里的建造请求 → 转成蓝图/任务 JSON → 以任务参数重启该 bot 进程（或另起一个专职建造的 bot 进程）。这是一个**明确的、可估量的自研工作量**，不是现成功能。

---

## 七、🔴 安全红线：`!newAction` = 宿主进程内的任意代码执行

这是本次调研发现的**最高等级风险**，直接关系文档 01 的 R13（提示注入）与 R14（模型写代码）：

- `!newAction(prompt)` **默认被拒绝**，除非 `settings.allow_insecure_coding === true`（根 `settings.js` 默认 **`false`**）。但 `main.js` 里有环境变量开关：**`INSECURE_CODING`** 一设即开。
- 一旦开启，它会调用 `agent.coder.generateCode(agent.history)` —— **模型写出一段 JS 代码块，在 agent 进程内直接执行**，作用域里带着 `Vec3`、`skills`、`world` 和**活的 mineflayer `bot` 对象**。
- **沙箱实况（一手读 `src/agent/coder.js` 补正）**：执行前先 `lockdown()`（SES），再用 `makeCompartment({ skills, log: skills.log, world, Vec3 })` 建**隔离仓**，`compartment.evaluate(src)` 后调用 `main(bot)`。也就是说代码**拿不到 `fs`/`process`/`require`**，只能经 `skills`/`world` 这两个库操作游戏世界 —— 比我原先的描述**略好**，但**仍然能对世界做任意改变**（挖、放、攻击、聊天），且生成的代码会被**落盘到 `./bots/<name>/action-code/<n>.js`**（相对进程工作目录）。
- ⚠️ **门禁位置存疑（M1 必须实测确认）**：`coder.js` **自身没有任何 `allow_insecure_coding` 检查**——唯一的门禁只可能在 `src/agent/commands/actions.js` 的 `newAction` 实现里。且 `agent.js` 显示**玩家直接在聊天框敲 `!newAction(...)` 会绕过 LLM 被立即执行**。因此这条红线**不能只靠"默认值"保证**，必须叠加我们自己的 owner 权限门 + 强制关旗标 + 运行时实测。
- 这条链路还叠加了 `MAX_ATTEMPTS = 5` 与 `MAX_NO_CODE = 3` 的重试，即**一次调用最多向模型发 5 轮**——成本上也是炸弹。
- 这等于**任意模型撰写的本地代码执行**。约束只有两点，而且都是"请求"而非"强制"：`coding` 提示词只是**请求**它不要 `import` 库、不要用 `setTimeout`/`setInterval`；而 `code_timeout_mins` 默认 **`-1`（无超时）**。
- `ModeController` 里带着一条显式警告：该对象必须保持引用隔离，因为它"This object is accessible by LLM generated code"。

**工程结论（必须写进设计）**：
1. 我们的应用**默认且强制保持 `allow_insecure_coding = false`**，并且**在代码层拒绝把 `INSECURE_CODING` 环境变量透传给子进程**；即便未来作为"高级开关"开放，也必须满足：默认关闭、清晰的危险提示、独立的探针/超时、以及把该 bot 进程视为**宿主级信任边界**（不可与用户主目录、密钥文件同权限）。
2. **密钥（`keys.json`）绝不能与该进程同权限可达** —— 因为一旦模型能执行任意 JS，它就能读文件。这直接印证了 `.gitignore` 里"密钥不入库"之外还需要一层**运行时隔离**。
3. 文档 01 的 D 系列决策里"是否允许模型写代码"应当**默认否决**，改为由我们自己的固定技能表覆盖需求（L3 技能层），只有在沙箱隔离方案落地后才考虑开放。

---

## 八、工程地雷清单（实现时必踩的坑）

| 地雷 | 事实 | 应对 |
|---|---|---|
| `!smeltItem` 成功后自杀重启 | 熔炼成功 → `cleanKill('Safely restarting to update inventory.')` → 500 ms 后重启进程 | 壳必须把"引擎进程重启"当作**正常状态**，会话/日志/UI 不能因此断开 |
| `!restart()` 同上 | 命令层可直接让进程退出 | 同上；需要有进程守护与自动重连 |
| `!attack` 的 kill 恒为 true | 没有"打一下就走"的选项 | 若要"驱赶而非杀死"，需我们在技能层自己实现 |
| `!placeHere` 只能放一个方块 | 不是搭结构的工具 | 结构必须走蓝图/任务路径 |
| `!checkBlueprint` 默认被屏蔽 | LLM 看不到建造进度 | 若要在聊天里汇报进度，需我们在应用层自行读取并在 UI 呈现 |
| `profiles` 多份时需 `/msg` 每个 bot | `settings.js` 注释原文："using more than 1 profile requires you to /msg each bot indivually" | 与"聊天框限定称谓唤醒"需求冲突处，由我们的路由层解决 |
| `postinstall` 跑 `patch-package` | 依赖 `patches/` 目录 | 打包/克隆时**绝不能丢 `patches/`** |

---

## 九、聊天入口 / 唤醒 / 权限 / 生命周期（一手读 `src/agent/agent.js`、`src/agent/coder.js`）

> 本节是**决定 M1 架构的一节**：它回答"用户要求的'聊天框限定称谓唤醒'引擎能不能给"——答案是**不能，且引擎的行为与我们的需求正面冲突**。

### 9.1 引擎**完全没有**唤醒称谓机制

`agent.js` 的 `_setupEventHandlers()` 里定义 `respondFunc(username, message)`，并同时挂在 `bot.on('whisper')` 和 `bot.on('chat')` 上。它的全部过滤条件只有四个：

```js
const respondFunc = async (username, message) => {
    if (message === "") return;
    if (username === this.name) return;
    if (settings.only_chat_with.length > 0 && !settings.only_chat_with.includes(username)) return;
    try {
        if (ignore_messages.some((m) => message.startsWith(m))) return;
        ...
```

其中 `ignore_messages` 是系统消息前缀黑名单：`"Set own game mode to"`、`"Set the time to"`、`"Set the difficulty to"`、`"Teleported "`、`"Set the weather to"`、`"Gamerule "`。

**结论**：过滤维度只有"**谁说的**"（`only_chat_with` 玩家白名单），**没有"说的是什么"**。也就是说，只要没开白名单，**公屏上任何人说的任何一句话都会触发一次大模型调用**。用户需求里"对 bot 的一切指示都依托于玩家在聊天框内出现对 bot 限定称谓的语句"，**引擎一丝一毫都没有实现，是本项目必须自研的一等功能**。

### 9.2 🔴 多 agent 时引擎会整体关闭公屏聊天

```js
this.bot.on('chat', (username, message) => {
    if (serverProxy.getNumOtherAgents() > 0) return;
    // only respond to open chat messages when there are no other agents
    respondFunc(username, message);
});
```

即：**同一个 Mindserver 下只要多于 1 个 agent，所有 bot 都忽略公屏聊天，只响应私聊（whisper）**。这与用户决策 4（每服 1–2 个 bot）**正面冲突**——两个 bot 共存时，公屏喊话全部失效。

**M1 必做项**：在 Runner 里接管这两个事件，用我们自己的唤醒判定替换引擎的 handler。

**零源码改动即可接管的关键技术点**：`agent.js` 里把这行闭包**同时存成了实例属性**——`this.respondFunc = respondFunc;`（就在 `respondFunc` 定义之后）。因此 Runner 可以在 agent 启动后直接做：

```js
const bot = agent.bot;
bot.removeAllListeners('chat');
bot.removeAllListeners('whisper');
bot.on('chat',    (u, m) => { if (gate(u, m)) agent.respondFunc(u, m); });
bot.on('whisper', (u, m) => { if (gate(u, m)) agent.respondFunc(u, m); });
```

`gate(u, m)` 依次做三件事：① **owner 校验**（决策 8）；② **唤醒称谓匹配**（决策 2，中文称谓）；③ **限流 / 预算检查**（决策 5）。
"公屏 vs 私聊"的差异、多 agent 屏蔽、非唤醒消息一律丢弃——**全部由我们决定**。这是本项目对引擎的**第一个必要补丁**，也是"聊天框限定称谓"这个核心需求唯一的落点。

### 9.3 玩家直接敲 `!命令` 会被立即执行，且**没有任何权限检查**

```js
if (!self_prompt && !from_other_bot) { // from user, check for forced commands
    const user_command_name = containsCommand(message);
    if (user_command_name) {
        if (!commandExists(user_command_name)) { this.routeResponse(source, `Command '${user_command_name}' does not exist.`); return false; }
        this.routeResponse(source, `*${source} used ${user_command_name.substring(1)}*`);
        if (user_command_name === '!newAction') { this.history.add(source, message); }
        let execute_res = await executeCommand(this, message);
```

- **好消息（成本）**：`!followPlayer("Alice")`、`!collectBlocks("oak_log",10)` 这类**直接执行的命令完全不经过大模型，零 token**。这是"预置技能表"落地的最佳载体——**高级用户/房主可以直接敲命令，只有自然语言才需要走模型**。
- **坏消息（安全）**：**服务器上任何人都能敲** `!stop`、`!givePlayer`、`!collectBlocks`，乃至 `!newAction`。引擎**没有 owner 概念**。→ 直接印证决策 8 的必要性：**owner 门必须抢在 `respondFunc` 之前**。
- 注意注释原文 "all user-initiated commands are ignored by the bot except for this one" 指的是**是否写入 `history`**（只有 `!newAction` 写），**不是"不执行"**。

### 9.4 唤醒之后的两条通路与"每条消息的固定成本"

用户消息 → `handleEnglishTranslation(message)` → `handleMessage(source, message)`。

`handleMessage` 先用 `containsCommand` 判断是否为命令（是则直接执行并返回），否则走对话：

1. `self_prompt = source === 'system' || source === this.name`
2. **`this.bot.modes.flushBehaviorLog()` 的行为日志以 system 消息塞进 `history`**（截断到 500 字符，超出则保留尾部）← **每一条用户消息都要付这笔 token**
3. `history.add(source, message)` + `history.save()`
4. 循环 `max_responses` 次（= `settings.max_commands`，默认 `-1` → `Infinity`）：`prompter.promptConvo(history)`
   - 回复里含 `!命令` → `truncCommandMessage` 截断掉命令之后的内容 → 执行 → 结果作为 system 消息**继续循环**
   - 不含命令 → 当作对话答复 `routeResponse` 后 `break`
5. `routeResponse` → `openChat`：把**非命令部分**经 `handleTranslation` 翻成 `settings.language`；**换行被替换成空格**（注释原文："newlines are interpreted as separate chats, which triggers spam filters"）；若 `only_chat_with` 非空则改为**逐个私聊名单里的玩家**，否则 `bot.chat` + `settings.speak` 语音 + `sendOutputToServer`

→ **"提示词瘦身"的三个具体落点**：命令表（`show_command_syntax`）、行为日志（500 字符/条）、`max_messages`(15) + `relevant_docs_count`(5) 的检索注入。

### 9.5 皮肤：引擎**已有挂点**（修正文档 02 的"所有项目皮肤空白"结论）

```js
this.bot.on('login', () => {
    console.log(this.name, 'logged in!');
    serverProxy.login();
    // Set skin for profile, requires Fabric Tailor. (https://modrinth.com/mod/fabrictailor)
    if (this.prompter.profile.skin)
        this.bot.chat(`/skin set URL ${this.prompter.profile.skin.model} ${this.prompter.profile.skin.path}`);
    else
        this.bot.chat(`/skin clear`);
});
```

- 即 **profile 里写 `skin: { model, path }`**，每次登录就会发这条命令；注释指明目标 mod 是 **Fabric Tailor**（`https://modrinth.com/mod/fabrictailor`）。
- ⚠️ 但我们的 bot 是 **mineflayer 无头客户端，装不了客户端 mod**，所以这条命令**只有服务端存在能识别该语法的插件时才有意义**（SkinsRestorer 是另一套语法，需另行适配）。
- **结论不变**（皮肤仍是本项目自研项），但**多了一个可直接改写的引擎挂点**——我们 vendor 了源码，把这里换成我们需要的语法即可。这比从零实现便宜得多。

### 9.6 生命周期：引擎会主动杀自己，壳必须守护并重连

| 触发 | 行为 |
|---|---|
| `validateNameFormat(this.name)` 不通过 | `log` 后 **`process.exit(1)`** |
| `spawn_timeout`（默认 30 秒）内未 spawn | `log` 后 **`process.exit(1)`** |
| `kicked` / `end` / `error` 含 `Duplicate`\|`ECONNREFUSED` | `handleDisconnection()` 后 **`process.exit(1)`**（日志带 `[LoginGuard]` 前缀） |
| `!smeltItem` 成功 / `!restart` / 任务完成 | `cleanKill(...)` → **`process.exit(1)`**，退出前会 `bot.chat('Restarting.'\|'Exiting.')` 并保存 history |

`handleDisconnection` 来自 `src/agent/connection_handler.js`。
→ **M1 必须实现**：进程守护 + 指数退避自动重连 + 重启不丢会话上下文；UI 上要让用户看到"**正在重启**"而不是"掉线了"。

### 9.7 其它影响成本 / 体验的硬编码

- `bot.autoEat.options` 硬编码：`priority: 'foodPoints'`、`startAt: 14`、`bannedFood: ["rotten_flesh","spider_eye","poisonous_potato","pufferfish","chicken"]`
- **`addBrowserViewer(this.bot, count_id)` 在 `spawn` 时无条件调用**（与 `VisionInterpreter` 一同初始化）——即使不用 3D 预览，渲染相关依赖也会被拉起。**这正是 Node 24 原生依赖崩栈的实际触发点**，也是我们换 Node 时首先要验证的地方。
- `update()` 主循环 `INTERVAL = 300` ms，串行执行 `bot.modes.update()` + `self_prompter.update()` + `checkTaskDone()`
- **`SelfPrompter` 提供"自我提示"长期运行模式**（`self_prompter.isActive()`）→ **默认必须关闭**，否则持续烧 token
- 死亡时自动把死亡点存为 `last_death_position` 记忆，并向自己发一条 system 消息 → **会再触发一次大模型调用**（成本上的隐性支出）

### 9.8 本节对 M1 的直接结论

1. **唤醒称谓是我们自研的第一等功能**，落点是替换 `bot` 的 `chat`/`whisper` 监听器（见 9.2 的 `this.respondFunc` 技巧）。
2. **owner 权限门是安全前提而非附加项**——引擎允许任何玩家直接执行 `!命令`。
3. **多 bot 共存必须绕过引擎的"多于 1 个 agent 就忽略公屏"逻辑**。
4. **"零 token 通路"是真实存在的**：房主直接敲 `!命令` → 不经模型。这是决策 5（成本优先）下最有力的杠杆。
5. **进程会被引擎自己杀掉**，守护与重连是 M1 的硬需求，不是打磨项。

---

## 十、采集与探险：`!collectBlocks` 的真实边界（M1 实测补记）

> 取证方式：直接读 `vendor/mindcraft-develop/src/agent/commands/actions.js` 与
> `src/agent/library/skills.js:417 collectBlock()`，并**在真实 1.21.1 服上跑通**。

### 10.1 命令签名（与第一节一致，这里补上参数域）

| 命令 | 参数域 | 备注 |
|---|---|---|
| `!collectBlocks(type: BlockName, num: int)` | `num ∈ [1, MAX_SAFE_INTEGER]` | `runAsAction(..., timeout = 10)` → **10 分钟** |
| `!searchForBlock(type: BlockName, search_range: float)` | `[10, 512]`，**小于 32 会被夹到 32** | 找到后会自动走过去 |
| `!moveAway(distance: float)` | `[0, Infinity]` | 朝任意方向走开 |
| `!goToCoordinates(x, y, z, closeness)` | `y ∈ [-64, 320]` | |
| `!searchForEntity(type: string, search_range: float)` | `[32, 512]` | |

### 10.2 🔴 `BlockName` 校验是**精确匹配英文 id**，中文进去必报错

`src/agent/commands/index.js` 用 `getBlockId(arg)` 校验，`getBlockId`（`src/utils/mcdata.js`）=
`mcdata.blocksByName[blockName]?.id ?? null`。**唯一的宽容**是：参数结尾是 `plank` 或 `seed`
时补一个 `s`。所以"砍点木头"这种中文必须由**我们这一层**翻译成 `oak_log`，
引擎侧没有任何中文能力。

### 10.3 🔴 `collectBlock()` 的别名展开（会静默改变你的意图）

`skills.js:432-440`，`blocktypes` 是数组，`getNearestBlocksWhere` 匹配其中任意一个：

| 你给的 | 引擎实际会找 |
|---|---|
| `coal` / `diamond` / `emerald` / `iron` / `gold` / `lapis_lazuli` / `redstone` | 再加 `<x>_ore` |
| 任何以 `ore` 结尾的 | 再加 `deepslate_<x>_ore` |
| `dirt` | 再加 `grass_block` |
| `cobblestone` | 再加 `stone` ← **"挖圆石"会退化成挖石头** |

### 10.4 🔴 硬门槛：石头与矿物**必须**有镐子，木头/泥土/沙子用手即可

`skills.js:480-493`：

```js
await bot.tool.equipForBlock(block);          // 自动换最合适的工具
const itemId = bot.heldItem ? bot.heldItem.type : null
if (!block.canHarvest(itemId)) {
    log(bot, `Don't have right tools to harvest ${blockType}.`);
    return false;                              // ★ 直接放弃，不是重试
}
```

实测（bot 空手出生）：
- `!collectBlocks("oak_log", 10)` → ✅ 真的砍回 10 个橡木（还顺带捡到树苗和木棍）
- `!collectBlocks("stone", 5)` → ❌ 聊天框回一句英文 `Don't have right tools to harvest stone.` 就结束
- `!searchForBlock("iron_ore", 64)` → ⚠️ **能定位**（`Found iron_ore at (-4, 108, 2)`），但走过去要挖开石头，
  于是 `Pathfinding stopped: Cannot break stone with current tools`

→ **这是 Minecraft 的游戏规则，不是引擎缺陷，也不是我们的 bug**。产品上必须把它翻译成人话，
我们在 `runner/mcbot-gate.mjs` 的 `preflightCollect()` 里做了采集前预检，缺镐时直接用中文回话
（实测回的是「我手里没有镐子，石头挖不动呀。你先给我做一把木镐（三个木板加两根木棍），我马上就去。」），
而不是把引擎那句英文原样丢给用户。

### 10.5 直接透传命令前必须先过 `commandExists()`

`executeCommand(agent, message)`（`commands/index.js`）**自己不看 `blocked_actions`** ——
封锁发生在 `commandMap` 构造时。所以：

- `commandExists(name)` 天然会对被禁命令返回 `false`（`!newAction` 等）；
- 但如果你绕过 `commandExists` 直接 `executeCommand`，**封锁就被绕过了**。

`runner/mcbot-gate.mjs` 在"主人直接敲 `!命令`"这条通路上先 `commandExists(head)`，正是为此。

### 10.6 🔴「探索」引擎里一个原语都没有 —— 而且 `!moveAway` 不等于探索

全部 55 条命令里跟"探索"沾边的只有 `!moveAway(distance)`。看实现（`skills.js:1397`）：

```js
export async function moveAway(bot, distance) {
    const pos = bot.entity.position;
    let goal = new pf.goals.GoalNear(pos.x, pos.y, pos.z, distance);
    let inverted_goal = new pf.goals.GoalInvert(goal);      // 反过来 = 离这里越远越好
    bot.pathfinder.setMovements(new pf.Movements(bot));
    ...
}
```

**它就是"朝任意方向离开当前位置直到至少 N 格远"**，返回一个布尔值，
走完不返回任何环境信息、也不说一句话。
对"陪玩家一起探索"这个需求，它连起点都算不上 —— 我们把 `四处走走` 改成走
`runner/explorer.mjs` 自己的流程（见 `docs/08` §七·补三）。

### 10.7 🔴 寻路：`GoalNear` 在野外会把你耗死在高度差上

`skills.goToGoal(bot, goal)` 对 `GoalNear` 的判定是**三维距离**。野外目标点的实际
地面高度无从得知（远处区块还没加载，`blockAt` 返回 null，读不到 y），于是 pathfinder
会为了"差 8 格高度"反复重算路径，直到超时。

**要往某个水平坐标走，用 `pf.goals.GoalXZ(x, z)`**：它只约束 x/z，高度由寻路自己解决。

### 10.8 🔴 一次 `GoalXZ` 别拉太远：复杂地形下几乎原地打转

实测（`runner/explorer.mjs`）：一次 `GoalXZ` 拉 **48 格**穿过森林，**150 秒只挪了 26 格**。
切成 **≤16 格一段、段间重新算路**之后，**同样 32 格只要 9 秒**。

**结论：长距离移动要自己分段（hop），不要指望一次 `goto` 走到底。**
分段还有个额外好处 —— 任一段走不通时可以停下，用**已走过的实际距离**如实汇报，
而不是"转了两分半然后说没走到"。

### 10.9 🔴 被 `pathfinder.stop()` 之后，`goto` 不一定抛错

有的版本是**安静地停下、`goto` 照常 resolve**。所以判断"是不是被叫停了"不能只看
有没有抛异常 —— 那样会把"半路停下"报成"走完了"，**等于跟玩家撒谎**。
正确做法：自己记 `bot.interrupt_code`，置位后无论走没走完都判为 `interrupted`。

### 10.10 🟡 `bot.blockAt()` 只认 Vec3 实例

传普通 `{x,y,z}` 会炸在 `prismarine-world/src/worldsync.js:102`：

```
TypeError: pos.floored is not a function
```

世界层要调 `pos.floored()`。所以自己算坐标时必须借一个真 Vec3：
`new (bot.entity.position.constructor)(x, y, z)`。
（这个坑在 `runner/builder.mjs` 与 `runner/explorer.mjs` 里都踩过，现在统一走
`builder.mjs` 导出的 `vecAt(bot,x,y,z)`。）

---

## 十一、合成：`!craftRecipe` 只做一步（M1 实测补记）

一手读自 `vendor\mindcraft-develop\src\agent\library\skills.js:36-113`。

### 11.1 命令与签名

| 命令 | 签名 | 说明 |
|---|---|---|
| `!craftRecipe` | `(recipe_name: ItemName, num: int)` | **`num` 是"合成次数"不是产出件数**（`!craftRecipe("stick", 2)` 得 8 根木棍） |
| `!craftable` | `(item_name: string)`（可选） | 查询能合成什么 |
| `!smeltItem` | `(item_name, num)` | ⚠️ **成功后 500ms 会 `cleanKill('Safely restarting to update inventory.')` 自杀重启进程** |

### 11.2 `craftRecipe()` 的完整流程

```js
// skills.js:47
if (mc.getItemCraftingRecipes(itemName).length == 0) { log(`X is either not an item, or it does not have a crafting recipe!`); return false; }
// skills.js:53  先试不用工作台的配方
let recipes = bot.recipesFor(mc.getItemId(itemName), null, 1, null);
// skills.js:56-57  没有就假设有台子再试一次
placeTable: if (!recipes || recipes.length === 0) recipes = bot.recipesFor(mc.getItemId(itemName), null, 1, true);
// skills.js:61  找 16 格内最近的台子
craftingTable = world.getNearestBlock(bot, 'crafting_table', 16);
// skills.js:65-73  没有台子但背包里有 → getNearestFreeSpace(bot,1,6) 找块空地 placeBlock 放下去
// skills.js:76  两样都没有
if (!craftingTable) { log(`Crafting X requires a crafting table.`); return false; }
// skills.js:103  ★★★
await bot.craft(recipe, Math.min(craftLimit.num, num), craftingTable);
// skills.js:104
if (craftLimit.num < num) log(`Not enough X to craft N, crafted M.`);
// skills.js:106-108  自己放下的台子用完收回来
// skills.js:112
bot.armorManager.equipAll();
```

### 11.3 🔴 三条必须记住的行为

1. **`:103` 材料不够就少合几次，不报错。** `craftLimit.num` 是当前材料能支撑的次数，
   `Math.min` 之后 `bot.craft` 就按这个数做。所以"调用返回了"**不等于**"东西做出来了" ——
   唯一的判定方式是**做完自己再数一遍背包**。
2. **`:61-76` 工作台由引擎自己解决**：先找 16 格内现成的，再试背包里的，两样都没有才失败。
   我们算材料账时要记得"3×3 的配方会额外吃掉 4 块木板（做一个台子）"。
3. **`:106-108` 台子会用完收回来**：自己放下的工作台会 `collectBlock` 回到背包，
   所以下一轮 `planFor` 能把库存里的 `crafting_table` 直接抵掉。

### 11.4 🔴 引擎没有任何"工具链"概念

`!craftRecipe` 不会替你想"做石镐得先有木镐去挖圆石"。**多级合成链必须长在我们这一层**
（`runner\workshop.mjs` 的 `planFor` / `runPlan` / 门禁里的 `ensurePickaxe`）。
同理，引擎也不知道"挖铁矿需要石镐"—— `PICKAXE_FOR` 这张表是我们自己维护的。

### 11.5 🟡 `mineflayer` 的合成配方在 `mcData.recipes[itemId]`

引擎的 `mc.getItemCraftingRecipes(name)` 是它自己 `src/utils/mcdata.js` 里的包装函数，
**原始 minecraft-data 对象上没有这个方法**。自己写测试要校验配方时用
`mcData.recipes[mcData.itemsByName[name].id]`。
另外 `mcData.items` 是按**数字 id** 索引的，按名字查要用 `mcData.itemsByName`。

---

## 十二、烧炼、回执与"引擎会说的每一句话"（M1 实测补记）

### 12.1 🔴🔴 `!smeltItem` 成功之后会**自杀重启**

`commands\actions.js:284-291`：

```js
if (success) {
    setTimeout(() => { agent.cleanKill('Safely restarting to update inventory.'); }, 500);
}
```

烧成功 500 毫秒后，引擎**主动杀掉自己的进程**（理由是"重启一下刷新背包"）。
对用户来说，面板上就是每烧一次熔炉多一条"意外退出"，`supervisor` 还要按退避策略重连。

**而库函数 `skills.js:142 smeltItem(bot, itemName, num)` 做完是正常返回的。**
→ 凡是需要烧炼的地方，**直接调库函数，绝不走 `!smeltItem` 命令**。

顺带：`utils\mcdata.js:284 isSmeltable(name)` 的口径是
`name.includes('raw') || name.includes('log') || misc_smeltables.includes(name)`
—— **只能烧 `raw_iron`，不能烧 `iron_ore`**。燃料热值在
`utils\mcdata.js:299 getFuelSmeltOutput()`：coal/charcoal = **8**、blaze_rod = 12、
`*log`/`*planks` = 1.5、coal_block = 80、lava_bucket = 100。

### 12.2 回执是怎么攒出来、怎么发出去的

| 环节 | 位置 | 事实 |
|---|---|---|
| 累积 | `library\skills.js:10-12` | `export function log(bot, message) { bot.output += message + '\n'; }` —— **是逐行累加的，一回执可能是多行** |
| 加前缀 | `action_manager.js:158-162` | `output = 'Action output:\n' + output.toString();` —— 前缀后面跟的是**换行**，不是空格 |
| 发送 | `agent.js:384-402` `routeResponse(to_player, msg)` | `if (this.shut_up) return;`；`to_player` 是自己或 `'system'` 时改用 `this.last_sender` |
| 洗换行 | `agent.js:404-429` `openChat(msg)` | `message = message.replaceAll('\n', ' ')`（注释说：换行会被当成多条聊天、触发刷屏过滤） |

→ **翻译要按行做，一行正好对上 `skills.js` 里的一处 `log()`。**
按整段撞一条正则必然失效（我们第一版就是这么写的，真机上完全没生效）。

`skills.js` 里一共 **143 句**带字面量的 `log(bot, ...)`，其中 **115 句**与玩家可能
看到的东西有关，已经在 `runner\engine-speak.mjs` 里翻成中文。

### 12.3 🔴 正则规则的顺序会咬人

`RULES` 是从上往下第一条命中就停。写通用规则时一定要排在具体规则**后面**：

```js
[/^Used \/setblock to place (.+?) at (.+?)\.$/i, ...],   // ← 必须在前
[/^Used (.+?)\.$/i, ...],                                // ← 在后，否则把上面整句吞掉
```

同样被咬过的还有 `(.+?) received (.+?)\.` 把
`Cleared furnace, received A, B, and C.` 整句吞了。
**把说话人收紧成 `(\w+)` 就好了 —— 通用规则要用"形状约束"而不是"什么都吃"。**

### 12.4 怎么保证"没有漏掉的话"

`tools\check-speak-coverage.mjs`：**从引擎源码里反着抠**。
它把 `skills.js` 里所有 `log(bot, ...)` 的字面量（含 `` `${}` `` 插值和 `+` 拼接）
抠出来，给每个插值塞一个像样的样本，再喂给 `translateEngineReply()` ——
翻完还剩英文的就是漏网的。

剩下 28 句（种地 8 + 村民交易 20）写在 `OUT_OF_SCOPE` 表里，**标明"我们没开放这个能力"**。
哪天开了，从表里删掉那一行，检查就会立刻逼着我们补翻译。


