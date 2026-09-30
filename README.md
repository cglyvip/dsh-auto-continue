# dsh-auto-continue

DeepSeek Harness (dsh) 插件：自定义模型/中转在开发过程中请求失败（内置重试 5/5 耗尽、显示"本轮运行失败"）时，**自动切换到兜底模型并注入「继续」**，不用再手动点继续。

## 行为

- 监听 `agent/request-error`（只观察，不改写内置重试）：记录失败的 `provider/model`，进入冷却期（默认 10 分钟，冷却期内不再选它）。
- 本轮以 `error` 结束、agent 空闲后（默认延迟 1.5 秒）：
  1. 从兜底链挑第一个健康模型，调用 `agents.selectForNextRequest` 写入会话（dsh 会自动在下一轮附加"模型已切换"提示）；
  2. 以 plugin notice 注入「继续」并唤醒。
- `max-tokens` 截断：只注入「继续」，不换模型。
- 用户主动停止（abort）不动；用户已经自己发了新消息不插手。
- 每会话继续上限默认 8 次，正常完成后自动清零，防止无限循环。
- 只处理本插件亲眼观察到的失败，重启后不会去续跑历史遗留的失败轮。

## 配置（cordis.patch.yml）

```yaml
- id: auto-continue
  name: dsh-auto-continue
  config:
    enabled: true
    autoContinue: true        # 总开关
    continueText: "继续"
    continueMax: 8            # 每会话继续次数上限 (1-20)
    continueDelayMs: 1500     # 失败后等待多久再续跑 (0-30000)
    autoSwitchModel: true     # 失败后自动换兜底模型
    modelCooldownMs: 600000   # 失败模型冷却 10 分钟
    maxTokensContinue: true   # max-tokens 截断也自动续
    verbose: false
    fallbacks:                # 兜底链，按优先级排序
      - { provider: fengwind, model: deepseek-v4.1-flash }
      - { provider: fengwind, model: kimi-k3 }
```

不写 `fallbacks` 时使用内置默认链（fengwind 的 6 个模型，不含 glm-5.3-flash）。

## 会话内指令

- `/autocont` — 查看状态（兜底链健康/冷却情况、日志路径）
- `/autocont on|off` — 临时开关（本次运行内有效）
- `/autocont reset` — 清空冷却与计数

## 日志

`~/.dsh/auto-continue/activity.log`（超过 512KB 自动轮转为 `.old`）。启动加载、换模型、注入继续、失败事件都记在这里——**装完重启 dsh 后先看这个文件确认插件已加载**。

## 安装 / 卸载

安装（desktop profile）：把本目录复制到 `~/.dsh/local-plugins/`，在 `~/.dsh/profiles/desktop/package.json` 的 `dependencies` 加 `"dsh-auto-continue": "file:../local-plugins/dsh-auto-continue"`、`dsh.profile.bundles` 数组加 `"dsh-auto-continue"`，然后在 profile 目录 `pnpm install`，重启 dsh。

卸载：反向删除上述三处 + `cordis.patch.yml` 里的配置段，profile 目录再跑一次 `pnpm install`。
