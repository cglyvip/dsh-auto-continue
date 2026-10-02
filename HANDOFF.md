# dsh-auto-continue 开发交接文档

> 写给在任何一台电脑上继续开发本插件的人（包括未来的自己和 AI 助手）。
> 读完这篇，不需要重新逆向 dsh 就能上手改代码。
> 最后更新：2026-10-01 · 插件版本 v0.5.2 · 新机已实测成功闭环（跨中转切换 + 任务完成 + 选择器联动）

---

## 0. 一页速览

| 项 | 内容 |
|---|---|
| 这是什么 | DeepSeek Harness (dsh) 桌面版插件：模型请求失败把整轮打断后，先留在原模型重试 N 次，再沿兜底链循环切换并注入「继续」，免手动点继续 |
| 仓库 | https://github.com/cglyvip/dsh-auto-continue （公开，分支 main） |
| 技术底座 | dsh 整个应用构建在 cordis 插件框架上（`@deepseek-ai/cordis` 4.0.4，Koishi 系框架 fork），插件与官方功能同机制 |
| 运行环境 | dsh 桌面版 0.2.0-rc.2（nightly 通道，内置 node 24 / pnpm 11.7 / python 3.12） |
| 双机状态 | 主力机（`C:\Users\Admin`，dsh 0.2.0-rc.2 逆向基线）＋ 新机（`C:\Users\CGLY`，装的是更新的 nightly，含会话格式 v4）。两台都通过 profile 装本插件；新机 2026-10-01 实弹验证了完整循环 |
| 日志 | `~/.dsh/auto-continue/activity.log`（512KB 自动轮转 .old） |
| 会话指令 | `/autocont`（status / on / off / reset） |
| 测试 | `node test/simulate.mjs`（纯 mock，29 断言，不需要跑 dsh） |

---

## 1. 背景与原理

dsh 桌面版（安装目录形如 `D:\Program Files\deepseek-harness`）本体是 Electron 壳，真正的 agent 运行时在 `resources/app.asar`（可解开分析：`npx @electron/asar extract app.asar out`）。**整个 dsh 的功能（agent、聊天 UI、设置页）全部是 cordis 意义上的插件（bundle）**，所以外部插件和官方功能能力完全对等。

dsh 的用户数据根在 `~/.dsh/`（`DSH_HOME` 环境变量可覆盖）：

```
~/.dsh/
├── profiles/desktop/          ← 桌面 profile（一个 pnpm 工作区）
│   ├── package.json           ← 依赖 + dsh.profile.bundles 数组（启用哪些组合包）
│   ├── cordis.patch.yml       ← 用户 patch 层（按 id 覆盖配置/禁用/插入）
│   ├── pnpm-workspace.yaml    ← nodeLinker: hoisted
│   ├── node_modules/          ← 安装的插件包
│   └── .plugin-manager/       ← 插件管理器状态与安装日志
├── dsh-runtimes/              ← 运行时（bundled pnpm 等）
├── sessions/ attachments/ storages/
└── auto-continue/             ← 本插件日志目录（运行时创建）
```

**插件 = 一个普通 npm 包（ESM）**，但必须满足两点才能被 dsh 认可：

1. 导出 cordis 插件形态：`export const name`、`export const inject`（可空数组）、`export function apply(ctx, config)`、`export default { name, inject, apply }`；apply 返回的函数作为卸载清理。
2. package.json 声明组合包身份：`"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`。**缺这个字段，插件管理器报"这个包没有声明组合包，不能作为插件管理"**。指向的 YAML 是随包默认配置层，典型写法是用 `insert:` 把自己的配置条目注入 profile（见本仓库 cordis.patch.yml）。

## 2. 仓库文件

```
dsh-auto-continue/
├── package.json        # 含 dsh.bundle.patch 声明（必须保留）
├── cordis.patch.yml    # 随包默认配置：insert 一条 id=auto-continue 的配置
├── lib/index.js        # 插件全部逻辑（单文件，约 890 行）
├── test/simulate.mjs   # mock 测试套件（16 场景）
├── README.md           # 面向使用者的说明
├── HANDOFF.md          # 本文
├── LICENSE             # MIT
└── .gitignore
```

## 3. 运行机制（lib/index.js 的行为规范）

**启动**：dsh 加载 bundles 时执行 `apply(ctx, config)`，config 来自随包 patch 的 insert 条目（用户可在 profile 的 cordis.patch.yml 用同 id 条目覆盖个别字段，按层合并）。apply 只挂两个全局事件监听 + 一个 `/autocont` 指令，然后返回清理函数。

**事件流**：

1. `agent/request-error`（cordis waterfall，全局）——dsh 内置对模型请求自动重试 5 次（截图上的"已重试模型请求 (5/5)"），每次失败都会流经此事件。本插件**只观察不改写**：记录 `{provider, model, code, message, at}` 到会话槽位，同时写入跨会话共享的模型冷却表 `modelFails`。`model` 取自 `agent.session.requestHeader()?.config`（兜底读最后一个 `model/selection` 事件）。
2. `agent/status`（emit，全局）——agent 状态机 `idle/running/...`。变 idle 时检查会话事件流（`agent.session.snapshotEvents()`）里最后一个 `turn/end` 的 `data.reason.kind`：
   - `completed` / `blocked` → 一切归零（继续计数、observedError、轮换状态 rot）
   - `error` → 主战场。前置守卫全过之后进入**轮换决策**（会话槽位维护 rot：起点模型 + 链位置 pos + 已重试次数 count）：
     - **随机退避**：所有失败重试（同模型重试、切换后的继续）的等待都在 `retryBackoffMinMs`~`retryBackoffMaxMs`（默认 60s~90s）均匀随机，拉开间隔避免烧配额；429 限流**不再单独停止**（正文标注"触发限流"，照常走重试→切换循环）；max-tokens 续跑仍用 `continueDelayMs` 快速注入；
     - 先**留在当前模型重试** `retriesPerModel` 次（默认 3）：只注入继续，不切换；但 `code === "INVALID_REQUEST"`（4xx 确定性拒绝，如同转网关拒收请求参数）同模型重试无意义，**首轮失败就直接切换**；
     - 额度用完 → 沿链 `[起点模型, ...fallbacks]` 前进到**下一个不在冷却期的模型**（冷却默认 5 小时，冷却期内每次切换都跳过它——包括绕回起点时；全链都在冷却才退回严格 +1，保持循环不停止，冷却到期后自动恢复跳过）；切换 `agents.selectForNextRequest(agent, {provider, model})`（写入持久 `model/selection` 事件，dsh 会自动在下一轮提示词里加"[model changed]"通知）；冷却记录持久化在 `~/.dsh/auto-continue/model-fails.json`，**重启 dsh 不丢**，`/autocont reset` 清空；
     - **同错熔断（默认关闭）**：`identicalFailuresLimit` > 0 时，不同模型连续报 code+message 完全相同的错误达阈值 → 判定网关级故障，本轮放弃续跑；同模型重复报错不计数，错误签名变化即重新计数。按"换到能用为止、中途不停止"的需求默认 0（关闭）；
     - 若失败的模型对不上当前循环位置（用户手动换过模型），以新模型为起点重开循环；
     - 随机退避结束后重新确认状态未变，`agent.followup(继续消息)` 唤起新一轮
   - **前台可见性**：注入消息正文把模型名放在第一眼位置——重试轮 `继续：<模型> 模型运行失败[（触发限流）]，N 秒后自动重试（i/N）`、切换轮 `继续：<旧模型> 模型连续 N 次运行失败，即将切换到 <新模型>，N 秒后自动重试`（模型名取自轮换状态 rot 的当前位置，比可能不刷新的 requestHeader 可靠）；`/autocont` 状态面板显示每个活动会话的轮换位置（当前模型 i/L）、本轮已切换次数、最近切到哪个模型。模型选择器的跟随见 §4「右下角模型选择器联动」；Toast 通知没有插件可用 API（client-ui-primitives 的 Toast 是组件内部 React 状态），要弹窗需走 client.js 注入 UI 的路子（未实现）
   - `max-tokens` → 只注入继续，不换模型
   - `aborted`（用户停止）/ `interrupted` / 未知 → 不碰

**守卫清单**（防误触的核心，改逻辑前先读懂）：

- `slot.lastContinueSeq === info.seq`：同一失败轮只续一次；新一轮失败 seq 会变，重新计
- `slot.observedError`：只处理本插件进程内亲眼见过的 `request-error`，**重启后不会去续跑历史遗留的失败轮**
- `hasFreshHumanTurn`：最后一个 turn/end 之后如果出现了真人消息，立刻收手（用户已接手；running 时出现真人消息还会重置计数）
- `agent.status === "running" || inboxBusy(agent)`：没闲着不插手
- `slot.continueUsed >= cfg.continueMax`（默认 8，1-20）：每会话继续预算，用完即停
- `modelFails` 冷却表：失败的模型 10 分钟（`modelCooldownMs`）内不再选，**跨会话共享**（一个模型挂了大概率都挂）

**配置键**（cordis.patch.yml，均可省略用默认）：`enabled` / `autoContinue` / `continueText`(默认"继续") / `continueMax`(100，1-500，重试与切换的继续都计入，按 1~1.5 分钟间隔约 2 小时) / `continueDelayMs`(1500，仅在随机退避被禁用时生效) / `retriesPerModel`(3，同一模型失败后先重试的次数，0=失败立刻切换) / `identicalFailuresLimit`(0=关闭，不同模型连续同错的熔断阈值) / `retryBackoffMinMs`(10000) / `retryBackoffMaxMs`(15000，失败重试的实际等待在 [min,max] 均匀随机——开发阶段 10~15 秒，上线可改回 60000/90000；都为 0 时退回 continueDelayMs) / `modelCooldownMs`(18000000，失败模型冷却 5 小时，冷却期内每次切换都跳过，持久化在 model-fails.json) / `useAllConfiguredModels`(true，轮换池=fallbacks 优先前缀+全部已配置中转×模型动态枚举) / `excludeProviders`(["deepseek-official"]) / `providerFailStreak`(3，同一中转连败 N 次整体拉黑，0=关) / `autoSwitchModel`(true) / `modelCooldownMs`(600000) / `maxTokensContinue`(true) / `verbose`(false，开详细日志) / `fallbacks`（默认 fengwind 的 6 个模型，不含 glm-5.3-flash；**换机器/换中转必须改成本中转真实存在的模型**）。

## 4. dsh 内部 API 速查（逆向自 app.asar 0.2.0-rc.2，改动风险自担）

| API | 说明 |
|---|---|
| `ctx.on(event, handler, {global: true})` | 全局事件监听（第三参失败时降级两参，本插件已做兼容） |
| `ctx.on("agent/request-error", async (payload, next))` | **waterfall**：payload `{agent(框架自动注入), turn, step, provider, failure:{code,message}, retryPolicy, signal}`；返回 `{kind:"retry"}` 可强制再重试（覆盖内置 5 次上限）——本插件未用，留作扩展点 |
| `ctx.on("agent/status", ({agent, status}))` | 状态机事件 |
| `agent.session.snapshotEvents()` | 会话事件流数组；`turn/end` 的 `data.reason.kind` ∈ completed/blocked/error/aborted/interrupted/max-tokens |
| `agent.session.requestHeader()?.config` | 最近一次请求的 `{provider, model}`。注意：**请求失败时 header 可能不更新**，读到的可能是上一次成功的模型（日志里 plan 行的"from"偶发不准就是这个原因，无害） |
| `ctx.get("agents")` | ApiSessionAgentController：`get(id)` / `resolveAgent(id)` / `selectForNextRequest(agent, {provider, model, reasoningEffort?})` |
| `ctx.get("llm").resolveCallConfig({provider, model})` | 校验并解析模型（async）；失败说明模型不在目录里 |
| `agent.followup({id, role:"user", content:[{type:"text",text}], source:{kind, ...}})` | 注入下一轮 user 消息并唤醒 agent；`agent.steer()` 是注入当前步。⚠️ 三个坑（都实测过）：① 会话格式 v4 持久化层**拒收 `source.kind === "plugin"`**（v3 旧写法，报 "format v4 message requires a producer-owned source kind"，轮次 UNKNOWN 失败）；② `kind: "plugin:<包名>"` 能落盘但**聊天界面不渲染**（气泡只给 kind:"user" 的消息）——所以本插件 v0.2.5 起注入用 `kind: "user"` + `producer: "dsh-auto-continue"` 署名字段（额外字段会被保留），"用户已接手"守卫按 `source.producer` 排除自己的消息；③ 真人消息的 source 是 `{kind:"user", rpcId, clientTimeZone}`，dsh 运行时注入的上下文消息用各自 producer kind（`runtime-context` / `skill-catalog` / `time-context` 等），都不算真人 |
| 持久化准入（dsh-session-persistence-jsonl worker） | 写入前校验每条消息：source 必须是对象、kind 非空且 ≠ `"plugin"`；不合规的行**不会落盘**（会话文件不损坏），但轮次以 UNKNOWN 失败。其他运行时包对 source.kind 没有白名单校验 |
| LLM 适配层（`@earendil-works/pi-ai` + `dsh-llm-pi-ai`） | 请求参数由 pi-ai 按模型 `compat` 开关拼装（如 openai-completions 的 `compat.supportsStore` 为真才发 `store:false`）。**中转网关拒收某参数（如 400 "property 'store' is unsupported"）时不用改插件**：profile 的 llm-pi-ai provider 条目支持 `compat: { supportsStore: false }`（route 级，对整条路由生效；`dsh-llm-pi-ai` 的 COMPAT_GATES 表定义了哪些字段可配，openai-completions 对 supportsStore 是 "offer"）。改完重启 dsh |
| 失败轮的模型归属 | `request-error` 时 `requestHeader` 可能不刷新（一直报上一次成功的模型）。插件用轮换状态 rot 的当前位置做冷却归属与熔断统计，header 原始值留给"用户手动换模型"检测（`syncRotation`）。 |
| 标题栏开关与设置弹层（v0.4.0/v0.5.0，v0.5.2 修正加载契约） | 界面开关 = 两半：**node 侧**本地控制端点（`http.createServer` 绑 127.0.0.1，`uiPort` 默认 49765，仅 GET /status 与 POST /toggle，带 CORS 头，端口被占则跳过）；**client 侧** `lib/client.js`（package.json `dsh.client: ["./lib/client.js"]` 声明，宿主经 `window.__ModuleLoader__.load({id, factory})` 注入浏览器），`inject:["slots"]` + `ctx.slots.inject("conversation.session.header.actions", ...)` 注册 React 按钮，fetch 本地端点读写状态。
      ⚠️ **client 声明契约（v0.5.1 的崩溃教训）**：package.json 的 `dsh.client` 是**对象** `{ platform: "web", inject?: [包名], external?: [包名], immediately?: bool }`（解析器 parseDshClient 要求 platform 必须是字符串；写成文件路径数组会在启动扫描时抛异常、炸掉 boot wire，client-hmr 等不到 clientModules，**整个应用无法启动**）。client 代码经 package.json **exports 的 `./client` 子路径**暴露（第一方同款约定），combo 路由按 `<id>/client.js` 提供文件。防崩溃铁律：client 入口里 require 失败或服务缺失时降级不注册（v0.5.2 的 try/catch react 守卫），绝不让客户端异常逃出；启动再炸就用崩溃对话框第三个按钮（禁用第三方插件+备份 profile patch）恢复。v0.5.0 起端点增加 GET/POST `/config`（retriesPerModel、retryBackoffMinMs/MaxMs、continueMax），标题栏 ⚙ 弹层可直接改重试次数与间隔，修改即时生效并持久化到 `~/.dsh/auto-continue/settings.json`（**优先级高于 profile 配置**，`/autocont reset` 不清它，删文件或界面改回即可）。参考实现：dsh-client-ui-jobs 的 header action 与 dsh-cordis-client-runner 的槽位自述文档 |
| 右下角模型选择器联动 | 选择器绑定 `agentDefaultModel` 服务（默认模型，对应 profile 的 `agent-default-model` 条目）。界面手动换模型走的远程命令 `sessionController.selectModel` = `agents.selectForNextRequest` + `ctx.agentDefaultModel.saveSelection(selected)` 两步（逆向自 dsh-api-session-controller lib/index.js:720）。**v0.3.1 实测**：插件两步都做后，持久层即时更新（profile 条目 06:57 被改写为实际切换的模型 ✓），但**已打开会话的选择器不会实时重绘**——界面组件自己持有快照，只在重新挂载时读取（web-frontend 两个 bundle 里无 selectModel/agentDefaultModel 字面量，无可订阅的刷新钩子）。会话切换/重开/重启后选择器即显示真实模型。要选中途实时刷新需走 client.js 注入 renderer 的路子（未实现） |
| `ctx.get("commands").register({name, description, input:{hint}, handler})` | 注册斜杠指令；handler 返回 `{kind:"success", text}` |
| 插件管理器判定 | `bundleManifest()` 只认 package.json 的 `dsh.bundle.patch`；管理器 install/reconcile 会把**没有**该声明的依赖从 bundles 数组剔除 |

逆向方法：`npx @electron/asar extract "D:\Program Files\deepseek-harness\resources\app.asar" out`，然后重点看 `out/dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js`（事件源头）、`dsh-agent/lib/index.js`（dispatch/model-selection）、`dsh-api-session-controller/lib/index.js`（selectModel/selectForNextRequest）、`dsh-plugin-manager/lib/index.js`（bundleManifest/reconcile）。现成参考实现：本机 `~/.dsh/profiles/desktop/node_modules/` 下的 `dsh-purge`（它的 continue-retry.js 就是本插件的祖宗，但主入口里被作者注释掉了）和 `@xmanrui/dsh-im`。

## 5. 新电脑环境搭建

1. 装 DeepSeek 桌面版（下载渠道同原机）、Git、Node.js（≥20 即可，测试脚本用）。
2. `git clone https://github.com/cglyvip/dsh-auto-continue`（需要 cglyvip 账号权限的机器直接用 HTTPS + Git Credential Manager 登录）。
3. 先跑 `node test/simulate.mjs` 确认全绿。
4. 装进 dsh（二选一）：
   - **插件管理器**（推荐）：dsh 插件管理界面输入 `https://github.com/cglyvip/dsh-auto-continue` 安装。注意：如果之前手动装过同包，先删干净，否则报"无法从依赖变更中确定安装了哪一个包"。
   - **手动**：编辑 `~/.dsh/profiles/desktop/package.json`，dependencies 加 `"dsh-auto-continue": "github:cglyvip/dsh-auto-continue"`，`dsh.profile.bundles` 数组加 `"dsh-auto-continue"`，然后 `cd ~/.dsh/profiles/desktop && pnpm install`（dsh 自带 pnpm，Windows 下：`node ~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.cjs install`）。
5. 重启 dsh，看 `~/.dsh/auto-continue/activity.log` 出现 `vX.Y.Z loaded`（且 fallbacks 是本机中转的真实模型），会话里 `/autocont` 有输出即成。
6. 兜底链默认是 fengwind 中转的模型清单。**换中转/换机器时改 `fallbacks`**：在 profile 的 `cordis.patch.yml` 里加同 id 覆盖条目（示例见 README），别直接改仓库里的默认值。**链里的模型必须本 key 真实可用**——实测 key 上未开通的模型统一报 503『当前模型暂不可用』，循环会在它们身上白烧重试额度。判别办法：看日志里哪些模型报过非 model_unavailable 的错误（说明到达过模型）。
6.5. **没有装 Git 的机器**：`github:` 依赖需要 pnpm 调 `git ls-remote` 解析——没 Git 会在 dsh 启动装配时报 `'git' 不是内部或外部命令`。两种解决：
   - 装 Git（git-scm.com，装完重启 dsh 即可）；
   - 或把 profile 的 package.json 里依赖改成**版本标签 tarball 地址**（纯 HTTPS，无需 Git）：
     `"dsh-auto-continue": "https://github.com/cglyvip/dsh-auto-continue/archive/refs/tags/v0.5.2.tar.gz"`
     （每次发新版要更新标签与该地址；标签 tarball 无 GitHub 分支缓存问题）。
7. **已装机机器的插件更新命令**（Windows，用 dsh 自带 pnpm；github 依赖锁着 commit，要 update 才会重解析）：
   ```
   cd ~/.dsh/profiles/desktop
   node "<dsh安装目录>/resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.cjs" update dsh-auto-continue
   ```
   然后重启 dsh。新机（CGLY）的 profile 另有两个实测必要覆盖：`llm-pi-ai` 的 api029/api773 加 `compat: { supportsStore: false }`（中转拒收 store 参数），`auto-continue` 的 `fallbacks` 按实证可用性排序（MiniMax-M3 优先）。

## 6. 开发与发布流程

```
改 lib/index.js
  → node test/simulate.mjs                     # mock 全绿
  → （真机验证）把包拷进 profile node_modules 或改版本后 pnpm install，重启 dsh
  → tail ~/.dsh/auto-continue/activity.log     # loaded / plan: switch / auto-continue sent
  → package.json 与 lib/index.js 顶部同步 bump 版本
  → git commit && git push
  → 其他机器：插件管理器里对这个包点"更新"（重新 pnpm add），重启 dsh
```

调试技巧：`verbose: true` 打开后日志会记录每次 request-error 与状态变化；`/autocont off|on` 可临时停开（仅本次运行）；`/autocont reset` 清冷却与计数。

## 7. 已知问题与改进方向

- **护栏策略（v0.2.6 定稿）**：作者明确要求"换到能用为止、中途不停止"，熔断默认关闭（`identicalFailuresLimit: 0` 可开）、429 限流不再单独停止；防空转靠**随机退避间隔**（默认 1~1.5 分钟，快速重试曾 2 分钟烧掉 5.5 万 token 触发全局限流）与**继续预算**（默认 100 次 ≈ 2 小时）。`INVALID_REQUEST` 类确定性拒绝仍直接快切不重试。
- **v0.2.2 的教训（2026-09-30 实测）**：用户中转（api029/029.cc.cd）所有模型统一报 `400 "store: property 'store' is unsupported"`——dsh 底层 pi-ai 的 openai-completions 适配器按 compat 开关给请求体加 `store:false`，中转后端拒收该参数。这不是模型问题，换模型无解（当时整条兜底链空转 30 次预算）。正解是 profile 的 llm-pi-ai provider 条目加 `compat: { supportsStore: false }`（见第 4 节）。排查路径：解包 app.asar → `@earendil-works/pi-ai/dist/api/openai-completions.js` 搜 `store` → `dsh-llm-pi-ai/lib/index.js` 看 `COMPAT_GATES` 白名单。
- `plan: switch` 日志里的"from 模型"取自 requestHeader，请求失败时 header 不刷新，可能显示旧模型（无害，可改为读 `slot.lastFailure` 前先比对 payload.provider）。
- 未实现：waterfall 返回 `{kind:"retry"}` 做插件级重试（dsh-purge 有现成写法可抄）；client.js 设置页（`dsh.bundle` 下还有 `client` 声明可挂 UI，参考 dsh-purge 的 client.js 的 `window.__ModuleLoader__.load` 模式）。
- ⚠️ dsh 桌面版是 **nightly 强制更新**通道（package.json 里有 dshMandatoryUpdatePolicy），升级后本插件如果失灵，先重新逆向确认第 4 节的 API 签名是否变化。
- **v0.2.1 的教训（2026-09-30 实测）**：新机器装了更新的 dsh nightly（内置会话格式 v3→v4 迁移），v0.2.0 注入的 `source.kind:"plugin"` 消息被持久化层当场拒收，每轮以 "format v4 message requires a producer-owned source kind"（UNKNOWN）失败——插件自身轮换逻辑完全正常（日志可见 retry 1/3→2/3→3/3→switch），但注入永不落盘，等于空转预算。排查路径：解包 `app.asar` → `dsh-session-format-v3-to-v4` 与 `dsh-session-persistence-jsonl/lib/worker.cjs` 搜 "producer-owned"。会话文件是多帧 zstd（`session.v4.jsonl.zstd`），Node 流式解压只出第一帧，要按 magic `28b52ffd` 切帧逐帧 `zstdDecompressSync`。

## 7.5 实弹验证记录（2026-10-01 凌晨，新机 CGLY）

v0.2.7 全流程实测，日志为证（session-dc090d5e，起点 gpt-5.6-luna）：

```
00:11:14  重试 1/3          00:15:17  ★切换 gpt-5.6-luna → MiniMax-M3
00:12:56  重试 2/3（65s）   00:20:24  MiniMax-M3 重试 2/3
00:14:37  重试 3/3（61s）   00:22:52  MiniMax-M3 重试 3/3
                            00:23:29  ★切换 MiniMax-M3 → MiniMax-M2.7-highspeed
                            00:26:56  M2.7 重试 1/3（已用 9/100）
```

- 所有间隔落在 61~87 秒（1~1.5 分钟随机区间 ✓）；熔断关闭后循环不停 ✓；预算计数正常 ✓。
- ⚠️ **本节结论后经 v0.3.6 修正**：当时日志里的"切换"（plan: switch / switched to X）是插件轮换状态的自我引用，`selectForNextRequest` 因走错服务（ctx.get("agents") 无此方法 + 可选链静默吞掉）从未生效——真实请求始终打在起点模型上。铁证：request-error 的 payload.provider 两天里始终是 api029，即使轮换链已排到 freeapi/elysiver 的模型。教训：**验证切换必须看 payload.provider 是否变化，不能信插件自己的日志**。
- 当时 key 整体故障期：连 MiniMax-M3 都报 model_unavailable，插件按要求持续循环不停手——『换到能用为止』的行为定稿依据。
- **界面渲染确认**：`kind:"user"` 的注入消息以普通用户气泡显示（作者原话『看到了，是我发出的文字』），模型名提示完全可见；`plugin:<包名>` 形态的旧结论（能落盘但界面不渲染）保持有效。

## 7.6 版本历史

| 版本 | 要点 |
|---|---|
| v0.1.0 | 首版：失败即切兜底 + 注入「继续」 |
| v0.1.1 | 声明 dsh.bundle.patch 修复插件管理器安装 |
| v0.2.0 | 同模型先重试 N 次（retriesPerModel）再沿链循环切换（循环往复） |
| v0.2.1 | 适配会话格式 v4：source.kind 弃 "plugin" 改 "plugin:<包名>"；真人判定正向匹配 |
| v0.2.2 | INVALID_REQUEST 快切；同错熔断（后默认关）；冷却归属用轮换状态 |
| v0.2.3 | 429 限流退避；切换提示进消息正文 |
| v0.2.4 | 重试间隔随机化；/autocont 显示会话轮换状态 |
| v0.2.5 | 注入改 kind:"user"+producer 署名（界面可见）；兜底链按实证可用性排序 |
| v0.2.6 | **行为定稿**：熔断默认关、429 不单独停止、退避 60~90s、预算 100——换到能用为止，中途不停止 |
| v0.2.7 | 提示文案带模型名（失败的是谁、切到谁，一眼可见） |
| v0.3.0 | 失败模型 5 小时冷却全程生效 + 磁盘持久化（model-fails.json，重启不丢）；退避改 10~15 秒（开发期） |
| v0.3.1 | 切换时同步 agentDefaultModel.saveSelection——右下角模型选择器跟随自动更新 |
| v0.3.2 | 每模型重试 1 次即切换（5 小时黑名单不变） |
| v0.3.3 | 轮换池动态化：fallbacks 作优先前缀 + 运行时枚举全部已配置中转×模型（新加中转免配置） |
| v0.3.4 | excludeProviders 默认排除官方源；AUTH 类失败拉黑整个中转一个冷却周期 |
| v0.3.5 | 轮换池按中转交错排序；同一中转连败 3 次（providerFailStreak）整体拉黑——账户级故障快速逃逸 |
| v0.3.6 | **切换失效根因修复**：selectForNextRequest 在 sessionController.agents 上，ctx.get("agents") 无此方法导致可选链静默空转两天；不可用时响亮报错 |
| v0.3.7 | sessionController 显式 inject（插件加载早于服务启动时 ctx.get 拿到 undefined） |
| v0.4.0 | 会话标题栏「自动重试」开关：client.js（slots 注入 header 按钮）+ node 本地控制端点（127.0.0.1:uiPort） |
| v0.5.0 | 标题栏 ⚙ 设置弹层：重试次数/间隔上下限界面直改，即时生效 + 持久化（settings.json，优先级高于 profile） |
| v0.5.1 | 回退 dsh.client 声明（格式错误炸启动），恢复可用 |
| v0.5.2 | 按正确契约（dsh.client 对象 + exports ./client 子路径）重新提供界面开关，react 不可用时降级 |

## 7.7 「从来没成功过」的最终诊断（2026-10-01 早晨）

插件机制全部正常（日志实锤），失败全是**中转通道本身的问题**。诊断方法：绕过 dsh 直接 curl 网关——
key 在 `~/.dsh/.credentials.yaml` 的 refs 里，`GET /v1/models` 列真实模型，`POST /v1/chat/completions`
逐模型实测。结论（api029 key）：

- ✅ 实测可用：deepseek-v4.1-flash / minimax-m2.7 / qwen3.8-max / deepseek-v4-pro / kimi-k2.6 /
  deepseek-v4-flash / GLM-5.3-Flash / cb/qwen-3.8-27b
- ❌ 坏通道（各自死法不同）：MiniMax-M3 与 MiniMax-M2.7-highspeed（上游 insufficient balance）、
  gpt-5.6-luna（522）、kimi-k3（空响应）、gemini-3.8-flash（Gateway attempt budget exhausted）、
  grok-4.7（要求 CLI 版本）
- ⚠️ **大小写陷阱**：网关模型 id 区分大小写——`glm-5.3-flash` 小写返回 model_not_found
  （"No available channel"），只有 `GLM-5.3-Flash` 有通道。profile 目录里的 id 抄错大小写
  = 永远 model_unavailable。

兜底链已按实测重建（7 个全绿模型），从此"插件能不能成功"只取决于中转通道状态，
与插件代码无关。调链时先 curl 实测再加进 fallbacks。

### 7.7.1 全量探测工具（2026-10-01 补充）

`tools/probe-models.mjs`——自动读取 profile 的全部中转 × 全部模型（含凭据库 key），
逐个发最小真实请求，输出 ✅/❌ 矩阵与按响应延迟排序的可用清单。用法：

```
node tools/probe-models.mjs
```

支持 openai-completions 与 openai-responses 两种协议；25 秒超时。**模型可用性随时间
变化很大**（同一天早上 MiniMax-M3 报 insufficient balance、几小时后自愈），每次调兜底链
前先跑一遍。2026-10-01 全量结果：6 中转 49 模型，32 可用 / 17 不可用（freeapi-site 整站 502，
api029 的 grok 系与 space-bunny-alpha、ling（限流）等不可用）。兜底链已按实测延迟重建为
跨 4 中转的 10 模型混布链（cb/qwen-3.8-27b 1s 最快打头，claude/MiniMax/deepseek 多路冗余）。

## 8. 工具踩坑记录（Windows + Git Bash）

- 系统 `grep` 实为 ugrep：对 asar 解出的超长行会报 complexity limit，用 `node -e "indexOf"` 定位代替。
- `node -e` 内联含反斜杠/中文的脚本会被 bash 转义搞坏，一律写临时 .mjs 文件再执行；Windows ESM 绝对路径 import 必须走 `pathToFileURL()`。
- pnpm 的 `file:` 依赖路径相对**包所在目录**：profile 在 `~/.dsh/profiles/desktop`，引用 `~/.dsh/local-plugins` 要写 `file:../../local-plugins/...`（错一层报 `ERR_PNPM_LINKED_PKG_DIR_NOT_FOUND`）。
- nodeLinker: hoisted 下 pnpm 每次 install 会按 lockfile 精确清点 node_modules，出现 `Packages: -N` 是正常对账，不必慌。
- curl 直传含中文的 JSON 会被 Git Bash 编码搞坏（"Problems parsing JSON"），写 UTF-8 文件后 `--data-binary @file`。
- GitHub API 无需 gh CLI：Git Credential Manager 存有令牌时，`git credential fill` 可取出来直接调 REST API（建仓库/改可见性/挂 topics 都行）；含中文的仓库描述同理走文件。
- `pnpm add <GitHub URL>` 后插件管理器靠**依赖表 diff** 判断装了什么，目标包已在依赖表里时会报 ambiguousInstall——让管理器管理就从干净状态装。

## 9. 相关资料

- 开源仓库：https://github.com/deepseek-ai/deepseek-harness （MIT）
- 社区教程（含 `dsh --dump-config` 等调试命令）：https://dsh.deepseek404.com/tutorial/index.php?p=plugins
- 社区插件按 GitHub topic `dsh-plugin` 聚合；本仓库已挂 topics：dsh / dsh-plugin / deepseek-harness / auto-continue
- 装机现成参考：`dsh-purge`（提示词清洗，continue-retry 逻辑祖宗）、`@xmanrui/dsh-im`（IM 接入，client UI 写法范例）
