# dsh-auto-continue

DeepSeek Harness (dsh) 插件：自定义模型/中转在开发过程中请求失败（内置重试 5/5 耗尽、显示"本轮运行失败"）时，**先留在原模型重试数次，再沿兜底链循环切换并注入「继续」**，不用再手动点继续。

> 继续开发请先读 [HANDOFF.md](HANDOFF.md)——含 dsh 内部 API 速查、环境搭建、发布流程与踩坑记录。

## 行为

- 监听 `agent/request-error`（只观察，不改写内置重试）：记录失败的 `provider/model`，进入冷却期（**默认 5 小时**，冷却期内每次切换都跳过它；记录持久化在 `~/.dsh/auto-continue/model-fails.json`，重启 dsh 不丢）。
- 本轮以 `error` 结束、agent 空闲后（默认延迟 1.5 秒）：
  1. 先**留在当前模型重试** `retriesPerModel` 次（默认 3，间隔 10~15 秒随机——上线可改回 1~1.5 分钟，每次只注入「继续」，不换模型）；
  2. 重试额度用完才切换：沿「起点模型 → 兜底链」前进到**下一个不在冷却期的模型**（失败模型冷却 5 小时，冷却期内每次切换都跳过它，记录持久化重启不丢；全链都在冷却才退回顺序循环），**循环往复，直到换到能用的模型**；
  3. 切换通过 `agents.selectForNextRequest` 写入会话（dsh 会自动在下一轮附加"模型已切换"提示），并同步 `agentDefaultModel.saveSelection` 让**右下角模型选择器跟着变**，随后注入「继续」唤醒。
- 期间用户手动换了模型再失败：以新模型为起点重开一轮循环。
- `max-tokens` 截断：只注入「继续」，不换模型。
- 用户主动停止（abort）不动；用户已经自己发了新消息不插手，并重置循环状态。
- 每会话继续上限默认 100 次（按 1~1.5 分钟间隔约连续尝试 2 小时），正常完成后自动清零。失败重试间隔 1~1.5 分钟随机，429 限流也照常走重试→切换循环。
- 只处理本插件亲眼观察到的失败，重启后不会去续跑历史遗留的失败轮。

## 配置

默认配置随包自带（`cordis.patch.yml`，经 package.json 的 `dsh.bundle.patch` 声明加载——**插件管理器要求包声明这个字段，否则报"这个包没有声明组合包"**）。要覆盖个别字段（比如改兜底链），在 profile 的 `cordis.patch.yml` 里加同 id 条目即可，按层合并：

```yaml
- id: auto-continue
  config:
    retriesPerModel: 2
    continueMax: 24
    fallbacks:
      - { provider: fengwind, model: deepseek-v4.1-flash }
      - { provider: fengwind, model: kimi-k3 }
```

各字段：`enabled` 总开关；`autoContinue` 自动续跑；`continueText` 注入的文本；`continueMax` 每会话继续次数上限（1-500，默认 100，重试与切换都计入）；`continueDelayMs` 失败后等待毫秒数（仅在随机退避禁用时生效）；`retriesPerModel` 同一模型失败后先重试的次数（0-10，默认 1，0 = 失败立刻切换）；`retryBackoffMinMs`/`retryBackoffMaxMs` 重试随机退避区间毫秒（默认 10000/15000）；`identicalFailuresLimit` 同错熔断阈值（默认 0 关闭）；`autoSwitchModel` 自动换模型；`modelCooldownMs` 失败模型冷却毫秒（默认 18000000 = 5 小时，冷却期内每次切换都跳过并持久化）；`maxTokensContinue` max-tokens 也续；`fallbacks` 兜底链（provider+model 列表，按优先级排序）；`useAllConfiguredModels` 轮换池是否自动纳入 profile 里全部已配置中转×模型（默认 true：fallbacks 作优先前缀，llm 服务枚举出的其余模型去重追加到链尾，新加中转/模型免配置自动进轮换）；`excludeProviders` 不进轮换池的中转列表（默认 `[deepseek-official]`，官方直连 key 失效不会自愈；AUTH 类失败还会把整个中转拉黑一个冷却周期）；`providerFailStreak` 同一中转短时间连败 N 次（默认 3）即整体拉黑一个冷却期——账户级网关故障（整体 5xx/并发超限）不用逐个模型试完；轮换池按中转交错排序（fw→qq214→fw→…），账户级故障第 2 顺位就能切到另一家。

## 界面开关与设置

会话标题栏右侧有「自动重试 开/关」按钮和「⚙」设置按钮（经插件 client.js 注入）：

- **开关**：点一下暂停/恢复自动重试，等同 `/autocont off|on`（本次运行内生效，重启恢复配置值）。
- **⚙ 设置**：弹层里直接改**每模型重试次数**与**重试间隔上下限（秒）**，保存后即时生效并持久化到 `~/.dsh/auto-continue/settings.json`（重启不丢；该文件的优先级高于 profile 配置，想完全回到 profile 值就删掉这个文件）。
- 按钮通过插件在本机 127.0.0.1:49765（`uiPort` 可配）的控制端点通信；若显示"不可用"，说明端点未启动（端口被占或 uiPort=0），此时仍可用会话指令。

## 会话内指令

- `/autocont` — 查看状态（兜底链健康/冷却情况、日志路径）
- `/autocont on|off` — 临时开关（本次运行内有效）
- `/autocont reset` — 清空冷却与计数

## 日志

`~/.dsh/auto-continue/activity.log`（超过 512KB 自动轮转为 `.old`）。启动加载、换模型、注入继续、失败事件都记在这里——**装完重启 dsh 后先看这个文件确认插件已加载**。

## 安装 / 卸载

**插件管理器安装**：在 dsh 插件管理界面输入 `github:cglyvip/dsh-auto-continue`（或仓库地址）安装即可。**机器没装 Git 的话**改用版本标签 tarball 地址（纯 HTTPS 无需 Git）：`https://github.com/cglyvip/dsh-auto-continue/archive/refs/tags/v0.5.2.tar.gz`。前提：包必须声明 `dsh.bundle.patch`（本仓库已声明），否则管理器报"这个包没有声明组合包，不能作为插件管理"。

**手动安装**（desktop profile）：在 `~/.dsh/profiles/desktop/package.json` 的 `dependencies` 加 `"dsh-auto-continue": "github:cglyvip/dsh-auto-continue"`、`dsh.profile.bundles` 数组加 `"dsh-auto-continue"`，然后在 profile 目录 `pnpm install`，重启 dsh。默认配置由随包 `cordis.patch.yml` 自动注入，无需改 profile 的 patch 文件。

卸载：在插件管理器卸载，或反向删除上述两处后 `pnpm install`。
