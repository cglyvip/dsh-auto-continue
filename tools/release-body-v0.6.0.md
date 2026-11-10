# dsh-auto-continue v0.6.0 —— 适配 DeepSeek Harness 0.2.2-rc.1

## 本版核心：模型选择 API 更名适配

Harness 0.2.2-rc.1 删除了 `sessionController.agents.selectForNextRequest`，改为 per-agent 视图 `agent.model.select({provider, model})`（写入 model/selection 事件并自动附 "[model changed]" 提示）。不更新此版插件的话，模型切换在新版上会静默失效（界面显示切换、请求永远走原 provider）。

本插件改为三层兜底：`agent.model.select`（0.2.2+）→ `selectForNextRequest`（0.2.0~0.2.1）→ `agents.select`，全部不可用时响亮报警。其余 12 项依赖 API 已逐一核验，全部在位。

## 既有功能（v0.5.x 全保留）

- 失败后先在当前模型重试（次数可配），间隔随机退避
- 重试额度用完沿轮换链切换，链尾绕回起点循环往复，直到换到能用的模型
- 轮换池动态枚举全部已配置中转 × 模型（fallbacks 作优先前缀），按中转交错排序
- 失败模型 5 小时冷却（持久化 model-fails.json，重启不丢）；AUTH 类失败与中转连败整体拉黑
- 会话标题栏「自动重试 开/关」+ ⚙ 设置弹层（重试次数/间隔界面直改，即时生效并持久化）
- 每条提示带模型名（失败的是谁、切到谁，一眼可见）；`/autocont status|on|off|reset`

## 安装

- 插件管理器：`github:cglyvip/dsh-auto-continue`（机器需装 Git）
- 无 Git 机器：依赖填 `https://github.com/cglyvip/dsh-auto-continue/archive/refs/tags/v0.6.0.tar.gz`

详见仓库 HANDOFF.md（含 dsh 内部 API 速查、踩坑记录、双机部署）。
