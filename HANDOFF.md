# dsh-auto-continue 开发交接文档

> 写给在任何一台电脑上继续开发本插件的人（包括未来的自己和 AI 助手）。
> 读完这篇，不需要重新逆向 dsh 就能上手改代码。
> 最后更新：2026-09-30 · 插件版本 v0.2.0 · 已在作者主力机实测生效

---

## 0. 一页速览

| 项 | 内容 |
|---|---|
| 这是什么 | DeepSeek Harness (dsh) 桌面版插件：模型请求失败把整轮打断后，先留在原模型重试 N 次，再沿兜底链循环切换并注入「继续」，免手动点继续 |
| 仓库 | https://github.com/cglyvip/dsh-auto-continue （公开，分支 main） |
| 技术底座 | dsh 整个应用构建在 cordis 插件框架上（`@deepseek-ai/cordis` 4.0.4，Koishi 系框架 fork），插件与官方功能同机制 |
| 运行环境 | dsh 桌面版 0.2.0-rc.2（nightly 通道，内置 node 24 / pnpm 11.7 / python 3.12） |
| 本机状态 | 已通过插件管理器安装在 `C:\Users\Admin\.dsh\profiles\desktop`，实测触发过自动切换+续跑 |
| 日志 | `~/.dsh/auto-continue/activity.log`（512KB 自动轮转 .old） |
| 会话指令 | `/autocont`（status / on / off / reset） |
| 测试 | `node test/simulate.mjs`（纯 mock，11 场景，不需要跑 dsh） |

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
├── lib/index.js        # 插件全部逻辑（单文件，约 500 行）
├── test/simulate.mjs   # 7 场景 mock 测试
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
     - 先**留在当前模型重试** `retriesPerModel` 次（默认 3）：只注入继续，不切换；
     - 额度用完 → 沿链 `[起点模型, ...fallbacks]` 前进一格：**首次离开起点**挑第一个不在冷却期的兜底（全在冷却就取第一个兜底），之后严格 +1、链尾绕回起点，**循环往复直到预算用尽**（循环途中不再看冷却表）；每次切换 `agents.selectForNextRequest(agent, {provider, model})`（写入持久 `model/selection` 事件，dsh 会自动在下一轮提示词里加"[model changed]"通知）；
     - 若失败的模型对不上当前循环位置（用户手动换过模型），以新模型为起点重开循环；
     - 延时 1.5s 重新确认状态未变后 `agent.followup(继续消息)` 唤起新一轮
   - `max-tokens` → 只注入继续，不换模型
   - `aborted`（用户停止）/ `interrupted` / 未知 → 不碰

**守卫清单**（防误触的核心，改逻辑前先读懂）：

- `slot.lastContinueSeq === info.seq`：同一失败轮只续一次；新一轮失败 seq 会变，重新计
- `slot.observedError`：只处理本插件进程内亲眼见过的 `request-error`，**重启后不会去续跑历史遗留的失败轮**
- `hasFreshHumanTurn`：最后一个 turn/end 之后如果出现了真人消息，立刻收手（用户已接手；running 时出现真人消息还会重置计数）
- `agent.status === "running" || inboxBusy(agent)`：没闲着不插手
- `slot.continueUsed >= cfg.continueMax`（默认 8，1-20）：每会话继续预算，用完即停
- `modelFails` 冷却表：失败的模型 10 分钟（`modelCooldownMs`）内不再选，**跨会话共享**（一个模型挂了大概率都挂）

**配置键**（cordis.patch.yml，均可省略用默认）：`enabled` / `autoContinue` / `continueText`(默认"继续") / `continueMax`(30，1-50，重试与切换的继续都计入) / `continueDelayMs`(1500) / `retriesPerModel`(3，同一模型失败后先重试的次数，0=失败立刻切换) / `autoSwitchModel`(true) / `modelCooldownMs`(600000) / `maxTokensContinue`(true) / `verbose`(false，开详细日志) / `fallbacks`（默认 fengwind 的 6 个模型，不含 glm-5.3-flash）。

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
| `agent.followup({id, role:"user", content:[{type:"text",text}], source:{kind:"plugin", plugin, form:"notice", summary}})` | 注入下一轮 user 消息并唤醒 agent；`agent.steer()` 是注入当前步 |
| `ctx.get("commands").register({name, description, input:{hint}, handler})` | 注册斜杠指令；handler 返回 `{kind:"success", text}` |
| 插件管理器判定 | `bundleManifest()` 只认 package.json 的 `dsh.bundle.patch`；管理器 install/reconcile 会把**没有**该声明的依赖从 bundles 数组剔除 |

逆向方法：`npx @electron/asar extract "D:\Program Files\deepseek-harness\resources\app.asar" out`，然后重点看 `out/dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js`（事件源头）、`dsh-agent/lib/index.js`（dispatch/model-selection）、`dsh-api-session-controller/lib/index.js`（selectModel/selectForNextRequest）、`dsh-plugin-manager/lib/index.js`（bundleManifest/reconcile）。现成参考实现：本机 `~/.dsh/profiles/desktop/node_modules/` 下的 `dsh-purge`（它的 continue-retry.js 就是本插件的祖宗，但主入口里被作者注释掉了）和 `@xmanrui/dsh-im`。

## 5. 新电脑环境搭建

1. 装 DeepSeek 桌面版（下载渠道同原机）、Git、Node.js（≥20 即可，测试脚本用）。
2. `git clone https://github.com/cglyvip/dsh-auto-continue`（需要 cglyvip 账号权限的机器直接用 HTTPS + Git Credential Manager 登录）。
3. 先跑 `node test/simulate.mjs` 确认 7 个场景全绿。
4. 装进 dsh（二选一）：
   - **插件管理器**（推荐）：dsh 插件管理界面输入 `https://github.com/cglyvip/dsh-auto-continue` 安装。注意：如果之前手动装过同包，先删干净，否则报"无法从依赖变更中确定安装了哪一个包"。
   - **手动**：编辑 `~/.dsh/profiles/desktop/package.json`，dependencies 加 `"dsh-auto-continue": "github:cglyvip/dsh-auto-continue"`，`dsh.profile.bundles` 数组加 `"dsh-auto-continue"`，然后 `cd ~/.dsh/profiles/desktop && pnpm install`（dsh 自带 pnpm，Windows 下：`node ~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.cjs install`）。
5. 重启 dsh，看 `~/.dsh/auto-continue/activity.log` 出现 `v0.1.1 loaded`，会话里 `/autocont` 有输出即成。
6. 兜底链默认是 fengwind 中转的模型清单。**换中转/换机器时改 `fallbacks`**：在 profile 的 `cordis.patch.yml` 里加同 id 覆盖条目（示例见 README），别直接改仓库里的默认值。

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

- **网关级故障会空转预算**：2026-09-30 实测 fengwind 网关整体 503 时，换到哪个模型都失败。v0.2.0 起每模型先重试 `retriesPerModel`（默认 3）次再沿链循环，默认预算 30 次，快速失败下约 1 分钟量级烧完才停。护栏没破，但可优化：连续 N 次快速失败时指数退避 `continueDelayMs` 或提前放弃本轮。
- `plan: switch` 日志里的"from 模型"取自 requestHeader，请求失败时 header 不刷新，可能显示旧模型（无害，可改为读 `slot.lastFailure` 前先比对 payload.provider）。
- 未实现：waterfall 返回 `{kind:"retry"}` 做插件级重试（dsh-purge 有现成写法可抄）；client.js 设置页（`dsh.bundle` 下还有 `client` 声明可挂 UI，参考 dsh-purge 的 client.js 的 `window.__ModuleLoader__.load` 模式）。
- ⚠️ dsh 桌面版是 **nightly 强制更新**通道（package.json 里有 dshMandatoryUpdatePolicy），升级后本插件如果失灵，先重新逆向确认第 4 节的 API 签名是否变化。

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
