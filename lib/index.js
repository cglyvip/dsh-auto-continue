/**
 * dsh-auto-continue — DeepSeek Harness 插件
 *
 * 模型请求失败（内置重试 5/5 耗尽后整轮失败）时：
 *   1. 记录失败的 provider/model，进入冷却期；
 *   2. 先留在当前模型重试 retriesPerModel 次（每次注入「继续」，不切换）；
 *   3. 重试额度用完 → 沿 [起点模型, ...兜底链] 前进一格切换（链尾绕回起点，循环往复，
 *      直到每会话预算用尽）。首次离开起点挑不在冷却期的兜底，之后按链顺序循环；
 *      写入 model/selection（dsh 会在下一轮自动附加"模型已切换"提示）；
 *   4. 以 plugin notice 形式注入「继续」消息并唤醒 agent，免手动点击。
 *
 * 事件面（与 @deepseek-ai/dsh-agent-loop 对齐）：
 *   - waterfall "agent/request-error"  payload {agent, turn, step, provider, failure, retryPolicy, signal}
 *   - emit      "agent/status"         payload {agent, status}
 *   - 会话事件流 turn/end.data.reason.kind: completed | blocked | error | aborted | interrupted | max-tokens
 *   - agents 服务（ApiSessionAgentController）: get(id) / selectForNextRequest(agent, {provider, model})
 *   - agent.followup(message) 注入下一轮 user 消息并唤醒
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import http from "node:http";

export const name = "dsh-auto-continue";
// sessionController 必须显式注入：selectForNextRequest 在它内部的 agents 控制器上，
// 不声明的话插件加载早于该服务启动，ctx.get 拿到 undefined，切换会静默失效
export const inject = ["sessionController"];

export const version = "0.5.0";

const DEFAULT_FALLBACKS = [
	{ provider: "fengwind", model: "deepseek-v4.1-flash" },
	{ provider: "fengwind", model: "kimi-k3" },
	{ provider: "fengwind", model: "mimo-v2.6-flash" },
	{ provider: "fengwind", model: "gemini-3.8-flash" },
	{ provider: "fengwind", model: "muse-spark-1.3-contributor" },
	{ provider: "fengwind", model: "space-bunny-alpha" },
];

/** 认证类失败码：key 坏了不会自愈，直接拉黑整个中转（冷却期内跳过它的全部模型） */
const AUTH_CODES = new Set(["AUTH", "UNAUTHORIZED", "FORBIDDEN", "401", "403"]);

const DEFAULTS = {
	enabled: true,
	autoContinue: true,
	continueText: "继续",
	continueMax: 100,
	continueDelayMs: 1500,
	autoSwitchModel: true,
	fallbacks: DEFAULT_FALLBACKS,
	/** 轮换池 = fallbacks（优先前缀）+ 运行时从 llm 服务枚举的全部已配置中转×模型（去重追加）。
	 *  这样新增中转/模型无需改插件配置，失败会轮换到所有可用的自定义模型，而不是只盯着 fallbacks 里那几个。 */
	useAllConfiguredModels: true,
	/** 不进轮换池的中转：官方直连源的 key 失效是常态且不会自愈，默认排除 */
	excludeProviders: ["deepseek-official"],
	/** 同一模型连续重试多少次后才切到下一个兜底（0 = 失败立刻切换） */
	retriesPerModel: 1,
	/** 不同模型连续报同一错误达到该次数 → 熔断本轮放弃续跑（0 = 不熔断，默认关） */
	identicalFailuresLimit: 0,
	/** 失败后自动重试的随机退避下限（毫秒）：拉开重试间隔，避免快速重试烧配额/火上浇油 */
	retryBackoffMinMs: 10 * 1000,
	/** 随机退避上限（毫秒）：实际等待在 [min, max] 均匀随机；两者都为 0 时退回 continueDelayMs */
	retryBackoffMaxMs: 15 * 1000,
	/** 模型失败后的冷却时长（毫秒）：冷却期内每次切换都跳过它（持久化到磁盘，重启不丢） */
	modelCooldownMs: 5 * 60 * 60 * 1000,
	/** 同一中转在时间窗内连续失败多少次后整体拉黑（账户级网关故障的快速逃逸；0 = 关闭） */
	providerFailStreak: 3,
	/** 界面开关的本地控制端点端口（127.0.0.1，仅本机可访问；0 = 关闭端点） */
	uiPort: 49765,
	/** max-tokens 截断也自动续跑 */
	maxTokensContinue: true,
	verbose: false,
};

// ---------------------------------------------------------------- config

function clampInt(value, lo, hi, fallback) {
	const n = Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(lo, Math.min(hi, Math.trunc(n)));
}

function normalizeFallbacks(raw) {
	const list = Array.isArray(raw) ? raw : [];
	const seen = new Set();
	const out = [];
	for (const item of list) {
		const provider = String(item?.provider || "").trim();
		const model = String(item?.model || "").trim();
		if (!provider || !model) continue;
		const key = `${provider}/${model}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ provider, model });
	}
	return out;
}

function normalizeConfig(raw = {}) {
	const src = raw && typeof raw === "object" ? raw : {};
	return {
		enabled: src.enabled !== false,
		autoContinue: src.autoContinue !== false,
		continueText: typeof src.continueText === "string" && src.continueText.trim() ? src.continueText.trim() : DEFAULTS.continueText,
		continueMax: clampInt(src.continueMax, 1, 500, DEFAULTS.continueMax),
		continueDelayMs: clampInt(src.continueDelayMs, 0, 30000, DEFAULTS.continueDelayMs),
		retriesPerModel: clampInt(src.retriesPerModel, 0, 10, DEFAULTS.retriesPerModel),
		identicalFailuresLimit: clampInt(src.identicalFailuresLimit, 0, 10, DEFAULTS.identicalFailuresLimit),
		retryBackoffMinMs: clampInt(src.retryBackoffMinMs, 0, 10 * 60 * 1000, DEFAULTS.retryBackoffMinMs),
		retryBackoffMaxMs: clampInt(src.retryBackoffMaxMs, 0, 10 * 60 * 1000, DEFAULTS.retryBackoffMaxMs),
		autoSwitchModel: src.autoSwitchModel !== false,
		fallbacks: normalizeFallbacks(src.fallbacks?.length ? src.fallbacks : DEFAULTS.fallbacks),
		useAllConfiguredModels: src.useAllConfiguredModels !== false,
		excludeProviders: Array.isArray(src.excludeProviders)
			? src.excludeProviders.map((x) => String(x).trim()).filter(Boolean)
			: DEFAULTS.excludeProviders,
		modelCooldownMs: clampInt(src.modelCooldownMs, 0, 24 * 60 * 60 * 1000, DEFAULTS.modelCooldownMs),
		providerFailStreak: clampInt(src.providerFailStreak, 0, 20, DEFAULTS.providerFailStreak),
		uiPort: clampInt(src.uiPort, 0, 65535, DEFAULTS.uiPort),
		maxTokensContinue: src.maxTokensContinue !== false,
		verbose: src.verbose === true,
	};
}

// ---------------------------------------------------------------- logging

function findDshHome() {
	const env = String(process.env.DSH_HOME || "").trim();
	return env || path.join(os.homedir(), ".dsh");
}

const LOG_DIR = path.join(findDshHome(), "auto-continue");
const LOG_FILE = path.join(LOG_DIR, "activity.log");
const LOG_MAX = 512 * 1024;

function logLine(verboseOnly, ...args) {
	if (verboseOnly && !logLine.verbose) return;
	const line = `[${new Date().toISOString()}] ${args.join(" ")}\n`;
	try {
		fs.mkdirSync(LOG_DIR, { recursive: true });
		try {
			const size = fs.statSync(LOG_FILE).size;
			if (size > LOG_MAX) fs.renameSync(LOG_FILE, `${LOG_FILE}.old`);
		} catch { /* 首次写入前没有文件 */ }
		fs.appendFileSync(LOG_FILE, line, "utf8");
	} catch { /* 日志失败绝不影响宿主 */ }
}

// ---------------------------------------------------------------- session helpers

function sessionEventsOf(agent) {
	const session = agent?.session;
	if (!session) return [];
	try {
		if (typeof session.snapshotEvents === "function") return session.snapshotEvents() || [];
	} catch { /* ignore */ }
	try {
		if (Array.isArray(session.events)) return session.events;
	} catch { /* ignore */ }
	return [];
}

function lastTurnEnd(events) {
	const list = Array.isArray(events) ? events : [];
	for (let i = list.length - 1; i >= 0; i -= 1) {
		if (list[i]?.type === "turn/end") return list[i];
	}
	return null;
}

function isUserAbort(reason) {
	if (!reason || reason.kind !== "aborted") return false;
	const cause = reason.reason;
	if (cause === "user" || cause === "cancel") return true;
	if (cause && typeof cause === "object") return cause.kind === "user" || cause.kind === "cancel";
	return false;
}

function inspectTurn(events) {
	const end = lastTurnEnd(events);
	const reason = end?.data?.reason || null;
	return {
		seq: end?.seq || 0,
		turn: end?.data?.turn || 0,
		reason,
		kind: reason?.kind || "",
		userAbort: isUserAbort(reason),
	};
}

/** 会话最近一次请求头里记录的 provider/model */
function currentSelectionOf(agent) {
	try {
		const header = agent?.session?.requestHeader?.();
		const cfg = header?.config;
		if (cfg?.provider && cfg?.model) return { provider: String(cfg.provider), model: String(cfg.model) };
	} catch { /* ignore */ }
	const events = sessionEventsOf(agent);
	for (let i = events.length - 1; i >= 0; i -= 1) {
		const event = events[i];
		if (event?.type === "model/selection" && event.data?.provider && event.data?.model) {
			return { provider: String(event.data.provider), model: String(event.data.model) };
		}
	}
	return null;
}

function hasFreshHumanTurn(events) {
	const list = Array.isArray(events) ? events : [];
	const end = lastTurnEnd(list);
	const after = end ? list.filter((event) => (event?.seq || 0) > end.seq) : list;
	// 真人消息：kind === "user" 且不是本插件注入的（本插件署名在 source.producer）；
	// dsh 运行时注入的上下文消息用各自 producer kind（runtime-context 等），都不算真人
	return after.some((event) => {
		if (event?.type !== "user/message") return false;
		const source = event?.data?.source;
		if (!source) return true;
		if (source.producer === "dsh-auto-continue") return false;
		return source.kind === "user";
	});
}

function inboxBusy(agent) {
	try {
		const inbox = agent?.inbox;
		if (!inbox) return false;
		if (typeof inbox.hasPending === "function" && inbox.hasPending()) return true;
		if (typeof inbox.size === "number" && inbox.size > 0) return true;
		if (typeof inbox.length === "number" && inbox.length > 0) return true;
	} catch { /* ignore */ }
	return false;
}

/** 429/限流类失败：配额按 key 共享，换模型无解，应当退避而不是重试或切换 */
function isRateLimitFailure(failure) {
	return failure.code === "RATE_LIMIT" || /\b429\b/.test(failure.message) || /rate limit|per minute|too many requests/i.test(failure.message);
}

function makeContinueMessage(text, summary) {
	return {
		id: `dsh-auto-continue-${randomUUID()}`,
		role: "user",
		content: [{ type: "text", text }],
		source: {
			// 聊天界面只把 kind:"user" 的消息渲染成对话气泡（plugin:* 的会被吞掉不显示），
			// 所以注入用 kind:"user"，插件署名放在 producer 字段里；
			// hasFreshHumanTurn 靠 producer 排除自己的消息，避免误判"用户已接手"
			kind: "user",
			producer: "dsh-auto-continue",
			form: "notice",
			summary,
		},
	};
}

// ---------------------------------------------------------------- apply

export function apply(ctx, config) {
	const cfg = normalizeConfig(config);
	logLine.verbose = cfg.verbose;
	if (!cfg.enabled) {
		logLine(false, `v${version} loaded but disabled by config`);
		return;
	}
	logLine(false, `v${version} loaded; autoSwitch=${cfg.autoSwitchModel} useAllConfiguredModels=${cfg.useAllConfiguredModels} fallbacks=${cfg.fallbacks.map((f) => `${f.provider}/${f.model}`).join(", ") || "(无)"}`);
	setImmediate(() => { void refreshCatalog(); });
	setImmediate(() => {
		const viaSession = ctx.get?.("sessionController")?.agents;
		const viaAgents = ctx.get?.("agents");
		const which = viaSession?.selectForNextRequest ? "sessionController.agents" : viaAgents?.selectForNextRequest ? "agents" : "不可用";
		logLine(false, `selection API: ${which}${which === "不可用" ? " —— 模型切换将不会生效！" : ""}`);
	});

	/** sessionId → { continueUsed, lastContinueSeq, observedError, lastFailure } */
	const sessions = new Map();
	/** "provider/model" → 上次失败时间戳（跨会话共享：一个模型挂了大概率都挂）；持久化到磁盘，重启不丢 */
	const modelFails = new Map();
	/** 中转连败计数（跨会话共享）：账户级网关故障的快速逃逸依据，内存态即可 */
	const providerStreak = new Map();
	/** 失败冷却持久化文件（5 小时黑名单，重启 dsh 依然有效） */
	const FAILS_FILE = path.join(LOG_DIR, "model-fails.json");

	/** 界面设置（重试次数/间隔）持久化：用户在标题栏弹层里改的值，重启不丢 */
	const SETTINGS_FILE = path.join(LOG_DIR, "settings.json");
	const SETTING_KEYS = ["retriesPerModel", "retryBackoffMinMs", "retryBackoffMaxMs", "continueMax"];

	function loadSettings() {
		try {
			const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
			for (const key of SETTING_KEYS) {
				if (Number.isFinite(raw?.[key])) cfg[key] = clampInt(raw[key], key === "continueMax" ? 1 : 0, key === "continueMax" ? 500 : 10 * 60 * 1000, cfg[key]);
			}
			if (cfg.retryBackoffMaxMs < cfg.retryBackoffMinMs) cfg.retryBackoffMaxMs = cfg.retryBackoffMinMs;
			if (Object.keys(raw || {}).length) logLine(false, `restored UI settings from ${SETTINGS_FILE}: retries/model=${cfg.retriesPerModel}, backoff=${cfg.retryBackoffMinMs}~${cfg.retryBackoffMaxMs}ms, budget=${cfg.continueMax}`);
		} catch { /* 没有设置文件，正常 */ }
	}

	function saveSettings() {
		try {
			fs.mkdirSync(LOG_DIR, { recursive: true });
			const out = {};
			for (const key of SETTING_KEYS) out[key] = cfg[key];
			fs.writeFileSync(SETTINGS_FILE, JSON.stringify(out, null, 2), "utf8");
		} catch { /* 写失败不影响主流程 */ }
	}

	function loadModelFails() {
		try {
			const raw = JSON.parse(fs.readFileSync(FAILS_FILE, "utf8"));
			const now = Date.now();
			for (const [key, at] of Object.entries(raw || {})) {
				if (typeof at === "number" && now - at < cfg.modelCooldownMs) modelFails.set(key, at);
			}
			if (modelFails.size) logLine(false, `restored ${modelFails.size} model cooldown entries from ${FAILS_FILE}`);
		} catch { /* 没有记录文件，正常 */ }
	}

	function saveModelFails() {
		try {
			fs.mkdirSync(LOG_DIR, { recursive: true });
			const now = Date.now();
			const out = {};
			for (const [key, at] of modelFails) {
				if (now - at < cfg.modelCooldownMs) out[key] = at;
			}
			fs.writeFileSync(FAILS_FILE, JSON.stringify(out, null, 2), "utf8");
		} catch { /* 写失败不影响主流程 */ }
	}

	const timers = new Set();
	const disposers = [];
	let running = true;
	loadSettings();
	loadModelFails();

	function slotOf(id) {
		let slot = sessions.get(id);
		if (!slot) {
			slot = { continueUsed: 0, lastContinueSeq: 0, observedError: false, lastFailure: null, rot: null, lastSig: "", lastSigModel: "", sameSigCount: 0, switchCount: 0, lastSwitchModel: "" };
			sessions.set(id, slot);
		}
		return slot;
	}

	/** 失败重试的随机退避：[min, max] 均匀取值；两者都为 0 时退回 continueDelayMs */
	function randomBackoffMs() {
		const lo = Math.max(0, cfg.retryBackoffMinMs);
		const hi = Math.max(cfg.retryBackoffMaxMs, lo);
		if (hi === 0) return cfg.continueDelayMs;
		return lo + Math.floor(Math.random() * (hi - lo + 1));
	}

	function agentIdOf(agent) {
		return String(agent?.id || agent?.session?.id || "");
	}

	function listen(event, handler) {
		if (typeof ctx?.on !== "function") return null;
		try {
			return ctx.on(event, handler, { global: true });
		} catch {
			try {
				return ctx.on(event, handler);
			} catch {
				return null;
			}
		}
	}

	function schedule(fn, ms) {
		const timer = setTimeout(() => {
			timers.delete(timer);
			fn();
		}, ms);
		timers.add(timer);
	}

	// ---- 1. 观察请求失败（只记录，不改写内置重试决策）

	disposers.push(listen("agent/request-error", async (payload, next) => {
		try {
			const agent = payload?.agent;
			const id = agentIdOf(agent);
			if (id) {
				const slot = slotOf(id);
				const sel = currentSelectionOf(agent);
				const provider = String(payload?.provider || sel?.provider || "");
				const headerModel = String(sel?.model || "");
				// 失败轮的请求头可能不刷新（一直报上一次成功的模型），
				// 轮换状态里的"当前模型"对冷却归属更可靠；header 原始值仍留给
				// syncRotation 做"用户手动换模型"检测，两者职责不同
				const rotModel = slot.rot ? rotationChainOf(slot.rot)[slot.rot.pos] : null;
				const model = String(rotModel?.model || headerModel);
				const code = String(payload?.failure?.code || "");
				const message = String(payload?.failure?.message || "").slice(0, 200);
				slot.observedError = true;
				slot.lastFailure = { provider, model: headerModel, code, message, at: Date.now() };
				if (provider && model) {
						modelFails.set(`${provider}/${model}`, Date.now());
						saveModelFails();
					}
				// 认证类失败（key 无效/被拒）不会自愈：把该中转整体拉黑（provider/*），
				// 冷却期内轮换跳过它的全部模型，不再一个一个模型地试
				if (provider && AUTH_CODES.has(code.toUpperCase())) {
					modelFails.set(`${provider}/*`, Date.now());
					saveModelFails();
					logLine(false, `auth-class failure (${code}): blacklisting whole provider ${provider} for ${Math.round(cfg.modelCooldownMs / 60000)} min`);
				}
				// 中转连败逃逸：同一中转短时间内连续失败 N 次（网关整体 5xx/并发超限是账户级故障，
				// 换它的模型没有意义），整体拉黑一个冷却期，让轮换立即落到别家中转
				if (provider && cfg.providerFailStreak > 0 && !modelFails.get(`${provider}/*`)) {
					const now = Date.now();
					const cur = providerStreak.get(provider);
					const streak = cur && now - cur.lastAt < 15 * 60 * 1000 ? cur.count + 1 : 1;
					providerStreak.set(provider, { count: streak, lastAt: now });
					if (streak >= cfg.providerFailStreak) {
						modelFails.set(`${provider}/*`, now);
						saveModelFails();
						providerStreak.delete(provider);
						logLine(false, `provider escalation: ${provider} failed ${streak} times in a row — blacklisting whole provider for ${Math.round(cfg.modelCooldownMs / 60000)} min`);
					} else {
						logLine(cfg.verbose, `provider streak ${provider}: ${streak}/${cfg.providerFailStreak}`);
					}
				}
				logLine(cfg.verbose, `request-error session=${id} provider=${provider} model=${model} code=${code} :: ${message}`);
			}
		} catch (error) {
			logLine(false, "request-error handler failed:", String(error));
		}
		return typeof next === "function" ? await next() : undefined;
	}));

	// ---- 2. 空闲时检查上一轮结局：失败 → 换模型 + 注入继续

	disposers.push(listen("agent/status", (payload) => {
		try {
			onStatus(payload?.agent, payload?.status);
		} catch (error) {
			logLine(false, "status handler failed:", String(error));
		}
	}));

	function onStatus(agent, status) {
		if (!agent || !running) return;
		const id = agentIdOf(agent);
		if (!id) return;
		const events = sessionEventsOf(agent);
		const slot = slotOf(id);

		if (status === "running") {
			if (hasFreshHumanTurn(events)) {
				slot.continueUsed = 0;
				slot.lastContinueSeq = 0;
				slot.rot = null;
				slot.lastSig = "";
				slot.lastSigModel = "";
				slot.sameSigCount = 0;
				slot.switchCount = 0;
				slot.lastSwitchModel = "";
			}
			return;
		}
		if (status !== "idle") return;

		const info = inspectTurn(events);
		if (info.kind === "completed" || info.kind === "blocked") {
			slot.continueUsed = 0;
			slot.lastContinueSeq = 0;
			slot.observedError = false;
			slot.rot = null;
			slot.lastSig = "";
			slot.lastSigModel = "";
			slot.sameSigCount = 0;
			slot.switchCount = 0;
			providerStreak.clear(); // 有会话跑通了：各中转的连败计数清零
			slot.lastSwitchModel = "";
			return;
		}
		if (!cfg.autoContinue) return;
		if (agent.status === "running" || inboxBusy(agent)) return;
		if (hasFreshHumanTurn(events)) return;
		if (!info.seq || slot.lastContinueSeq === info.seq) return;

		let pending = null;
		if (info.kind === "error") {
			// 只处理本插件亲眼观察到的失败，避免启动时翻旧账
			if (!slot.observedError || !slot.lastFailure) return;
			const backoffMs = randomBackoffMs();
			const waitSec = Math.max(1, Math.round(backoffMs / 1000));
			// 429 限流不再单独停止：和其他失败一样走"重试→切换→循环"，
			// 退避间隔（默认 1~1.5 分钟）本身就能等配额窗口重置
			const rateLimited = isRateLimitFailure(slot.lastFailure);
			if (cfg.autoSwitchModel && (cfg.fallbacks.length || (cfg.useAllConfiguredModels && catalogExtras.length))) {
				void refreshCatalog();
				syncRotation(slot, id);
				const chain = rotationChainOf(slot.rot);
				const failingModel = keyOf(chain[slot.rot.pos]);
				// 熔断统计（默认关闭）：不同模型连续报同 code+message 的错达阈值才停止
				if (cfg.identicalFailuresLimit > 0) {
					const sig = `${slot.lastFailure.code}::${slot.lastFailure.message}`;
					if (sig !== slot.lastSig) {
						slot.lastSig = sig;
						slot.lastSigModel = failingModel;
						slot.sameSigCount = 1;
					} else if (failingModel !== slot.lastSigModel) {
						slot.lastSigModel = failingModel;
						slot.sameSigCount += 1;
					}
					if (slot.sameSigCount >= cfg.identicalFailuresLimit) {
						slot.lastContinueSeq = info.seq;
						logLine(false, `circuit breaker: identical error ×${slot.sameSigCount} across models (${sig.slice(0, 120)}) — gateway-wide failure suspected, stopping auto-continue for this episode (session=${id})`);
						return;
					}
				}
				// 请求被确定性拒绝（4xx 类，如参数不兼容）：同模型重试没有意义，直接切下一个
				const deterministic = slot.lastFailure.code === "INVALID_REQUEST";
				if (chain.length > 1 && (deterministic || slot.rot.count >= cfg.retriesPerModel)) {
					// 当前模型重试额度用完（或确定性失败）→ 沿链前进一格（链尾绕回起点，循环往复，直到换到能用的模型）
					const from = chain[slot.rot.pos];
					const switchTo = advanceRotation(slot);
					slot.switchCount += 1;
					slot.lastSwitchModel = `${switchTo.provider}/${switchTo.model}`;
					logLine(false, `plan: switch ${keyOf(from)} -> ${slot.lastSwitchModel} (cycle ${slot.rot.pos + 1}/${rotationChainOf(slot.rot).length}${deterministic ? ", deterministic" : ""}, session=${id})`);
					pending = {
						switchTo,
						text: `${cfg.continueText}：${from.model} 模型连续 ${cfg.retriesPerModel} 次运行失败，即将切换到 ${switchTo.model}，${waitSec} 秒后自动重试`,
						summary: `自动继续 · ${from.model} → ${switchTo.model}`,
					};
				} else {
					// 还在重试额度内：留在当前模型，只注入继续
					slot.rot.count += 1;
					logLine(cfg.verbose, `plan: retry ${keyOf(chain[slot.rot.pos])} (session=${id})`);
					pending = {
						sentNote: `, retry ${slot.rot.count}/${cfg.retriesPerModel} on ${keyOf(chain[slot.rot.pos])}`,
						text: `${cfg.continueText}：${chain[slot.rot.pos].model} 模型运行失败${rateLimited ? "（触发限流）" : ""}，${waitSec} 秒后自动重试（${slot.rot.count}/${cfg.retriesPerModel}）`,
						summary: cfg.verbose ? `auto-continue retry ${slot.rot.count}/${cfg.retriesPerModel}` : "继续",
					};
				}
				pending.delayMs = backoffMs;
			} else {
				pending = { delayMs: backoffMs };
			}
		} else if (info.kind === "max-tokens") {
			if (!cfg.maxTokensContinue) return;
			pending = {};
		} else {
			return; // aborted / interrupted / 未知：不碰
		}

		dispatchContinue(agent, slot, id, info, pending);
	}

	/** 统一的继续注入：预算检查 → 延时 → 复核状态 → （切换）→ followup */
	function dispatchContinue(agent, slot, id, info, { switchTo = null, text = cfg.continueText, summary, sentNote = "", delayMs = cfg.continueDelayMs }) {
		if (slot.continueUsed >= cfg.continueMax) {
			logLine(false, `continue budget exhausted (session=${id}, used=${slot.continueUsed}/${cfg.continueMax})`);
			return;
		}
		slot.continueUsed += 1;
		slot.lastContinueSeq = info.seq;

		schedule(() => {
			(async () => {
				try {
					// 等待期间用户可能已经自己发了消息：重新确认还是同一个停住的状态
					if (!running || agent.status === "running" || inboxBusy(agent) || hasFreshHumanTurn(sessionEventsOf(agent))) {
						slot.continueUsed -= 1;
						return;
					}
					if (switchTo) await applySelection(agent, switchTo);
					agent.followup(makeContinueMessage(text, summary ?? (cfg.verbose ? "auto-continue" : "继续")));
					logLine(false, `auto-continue sent (session=${id}, used=${slot.continueUsed}/${cfg.continueMax}${switchTo ? `, switched to ${switchTo.provider}/${switchTo.model}` : sentNote})`);
				} catch (error) {
					slot.continueUsed -= 1;
					logLine(false, "followup failed:", String(error));
				}
			})();
		}, delayMs);
	}

	function keyOf(f) {
		return `${f.provider}/${f.model}`;
	}

	// ---- 轮换池扩充：从 llm 服务枚举全部已配置中转×模型（TTL 缓存，60 秒）
	// 适配器未注册/未实现时静默跳过，轮换池退化为 fallbacks 本身。

	let catalogExtras = [];
	let catalogAt = 0;
	let catalogRefreshing = false;
	const CATALOG_TTL_MS = 60 * 1000;

	async function refreshCatalog() {
		if (catalogRefreshing || Date.now() - catalogAt < CATALOG_TTL_MS) return;
		catalogRefreshing = true;
		try {
			const llm = ctx.get?.("llm");
			if (llm && typeof llm.listProviders === "function" && typeof llm.listModels === "function") {
				const out = [];
				for (const p of llm.listProviders() || []) {
					const pid = String(p?.id || "");
					if (!pid || cfg.excludeProviders.includes(pid)) continue;
					try {
						const models = await llm.listModels(pid);
						for (const m of Array.isArray(models) ? models : []) {
							const mid = String(m?.id || "");
							if (mid) out.push({ provider: pid, model: mid });
						}
					} catch { /* 单个中转枚举失败不拖垮整体 */ }
				}
				catalogExtras = out;
				catalogAt = Date.now();
				logLine(cfg.verbose, `catalog refreshed: ${out.length} models from llm service`);
			} else {
				catalogAt = Date.now(); // 服务不在（如测试环境）就别反复空转
			}
		} finally {
			catalogRefreshing = false;
		}
	}

	/** 轮换链：起点模型在前，其余按"中转交错"排序（fw→qq214→fw→qq214…）——
	 *  账户级故障（网关整体 5xx/并发超限）在第 2 顺位就能切到另一家中转，
	 *  而不是把同一家中转的模型全试完才轮到。excludeProviders 全程不进池。 */
	function rotationChainOf(rot) {
		const originKey = keyOf(rot.origin);
		const usable = (f) => !cfg.excludeProviders.includes(f.provider);
		const base = cfg.fallbacks.filter((f) => keyOf(f) !== originKey && usable(f));
		const rest = cfg.useAllConfiguredModels
			? [...base, ...catalogExtras.filter((f) => !base.some((b) => keyOf(b) === keyOf(f)) && usable(f))]
			: base;
		return [rot.origin, ...interleaveByProvider(rest)];
	}

	function interleaveByProvider(list) {
		const groups = new Map();
		for (const f of list) {
			if (!groups.has(f.provider)) groups.set(f.provider, []);
			groups.get(f.provider).push(f);
		}
		const out = [];
		for (let added = true; added; ) {
			added = false;
			for (const arr of groups.values()) {
				if (arr.length) {
					out.push(arr.shift());
					added = true;
				}
			}
		}
		return out;
	}

	/** 初始化/校准轮换状态：失败模型对不上当前位置（用户手动换过模型）→ 以新模型为起点重开循环 */
	function syncRotation(slot, id) {
		const last = slot.lastFailure;
		const reportedKey = last.provider && last.model ? keyOf(last) : "";
		if (!slot.rot) {
			slot.rot = { origin: { provider: last.provider, model: last.model }, pos: 0, count: 0 };
			return;
		}
		const chain = rotationChainOf(slot.rot);
		if (reportedKey && reportedKey !== keyOf(chain[slot.rot.pos]) && reportedKey !== keyOf(slot.rot.origin)) {
			logLine(cfg.verbose, `rotation restart at ${reportedKey} (session=${id})`);
			slot.rot = { origin: { provider: last.provider, model: last.model }, pos: 0, count: 0 };
			slot.switchCount = 0;
			slot.lastSwitchModel = "";
		}
	}

	/** 某模型是否在冷却期：模型级失败，或它所在中转被整体拉黑（AUTH 类失败连 key 都是坏的，跳过整个中转） */
	function coolingUntil(f) {
		return modelFails.get(keyOf(f)) || modelFails.get(`${f.provider}/*`) || 0;
	}

	/**
	 * 沿轮换链前进到下一个不在冷却期的模型（冷却 = 近期失败过，默认 5 小时内每次切换都跳过它）。
	 * 全链都在冷却期时退回严格 +1，保持循环不停止；冷却逐个到期后又会自动跳回"跳过"模式。
	 */
	function advanceRotation(slot) {
		const rot = slot.rot;
		const chain = rotationChainOf(rot);
		const now = Date.now();
		for (let step = 1; step <= chain.length; step += 1) {
			const idx = (rot.pos + step) % chain.length;
			if (!(cfg.modelCooldownMs > 0 && now - coolingUntil(chain[idx]) < cfg.modelCooldownMs)) {
				rot.pos = idx;
				rot.count = 0;
				return chain[idx];
			}
		}
		const idx = (rot.pos + 1) % chain.length;
		rot.pos = idx;
		rot.count = 0;
		return chain[idx];
	}

	async function applySelection(agent, selection) {
		let selected = { provider: selection.provider, model: selection.model };
		try {
			const llm = ctx.get?.("llm");
			const resolved = await llm?.resolveCallConfig?.({ provider: selection.provider, model: selection.model });
			if (resolved?.provider && resolved?.model) {
				selected = { provider: resolved.provider, model: resolved.model };
				if (resolved.reasoningEffort !== undefined) selected.reasoningEffort = resolved.reasoningEffort;
			}
		} catch { /* 配置对不进目录就按原样下发，失败会被 request-error 记录并进入冷却 */ }
		// ⚠️ 关键路径：selectForNextRequest 在 SessionController 内部的 agents 控制器上
		// （sessionController.agents）。ctx.get("agents") 是底层 agent 注册表，没有这个
		// 方法——此前用可选链调用被静默吞掉，模型切换从未写入会话：界面上的模型名
		// 变了（agentDefaultModel 默认值），但请求的 provider（即 URL/key）纹丝不动。
		const controller = ctx.get?.("sessionController")?.agents ?? ctx.get?.("agents");
		if (typeof controller?.selectForNextRequest === "function") {
			try {
				controller.selectForNextRequest(agent, selected);
				logLine(cfg.verbose, `selection written: ${selected.provider}/${selected.model}`);
			} catch (error) {
				logLine(false, "selectForNextRequest failed:", String(error));
			}
		} else {
			logLine(false, `⚠️ selectForNextRequest 不可用（sessionController.agents 缺失）——本次切换不会生效，请求仍走原 provider`);
		}
		// 同步右下角模型选择器：选择器绑定的是 agentDefaultModel（默认模型），
		// selectForNextRequest 只改会话内的下一轮请求、不动选择器；
		// 界面手动换模型走的就是 selectModel = selectForNextRequest + saveSelection 两步
		try {
			await ctx.get?.("agentDefaultModel")?.saveSelection?.(selected);
		} catch { /* 选择器联动失败不影响切换本身 */ }
	}

	// ---- 3. /autocont 指令：查看状态 / 开关 / 清冷却

	const commands = ctx.get?.("commands");
	let commandDisposer = null;
	if (commands && typeof commands.register === "function") {
		try {
			commandDisposer = commands.register({
				name: "autocont",
				description: "自动继续/自动换模型插件：status | on | off | reset",
				input: { hint: "status | on | off | reset" },
				handler: (invocation) => handleCommand(String(invocation?.rawInput || "").trim().toLowerCase()),
			});
		} catch (error) {
			logLine(false, "command register failed:", String(error));
		}
	}

	function handleCommand(arg) {
		const first = arg.split(/\s+/)[0] || "status";
		if (first === "on") {
			running = true;
			logLine(false, "enabled via /autocont on");
			return { kind: "success", text: "dsh-auto-continue 已启用（本次运行内生效）" };
		}
		if (first === "off") {
			running = false;
			logLine(false, "disabled via /autocont off");
			return { kind: "success", text: "dsh-auto-continue 已停用（本次运行内生效，重启恢复配置值）" };
		}
		if (first === "reset") {
			modelFails.clear();
			try { fs.rmSync(path.join(LOG_DIR, "model-fails.json"), { force: true }); } catch { /* ignore */ }
			sessions.clear();
			return { kind: "success", text: "已清空失败冷却与继续计数" };
		}
		const now = Date.now();
		const seenPool = new Set();
		const pool = [];
		for (const f of [...cfg.fallbacks, ...(cfg.useAllConfiguredModels ? catalogExtras : [])]) {
			const key = keyOf(f);
			if (seenPool.has(key) || cfg.excludeProviders.includes(f.provider)) continue;
			seenPool.add(key);
			pool.push(f);
		}
		const lines = [
			`dsh-auto-continue v${version}：${running ? "运行中" : "已停用"}；自动换模型 ${cfg.autoSwitchModel ? "开" : "关"}；轮换池 ${cfg.useAllConfiguredModels ? `全部已配置模型（当前 ${pool.length} 个，其中动态枚举 ${catalogExtras.length} 个${catalogAt ? "" : "，尚未枚举"}）` : "仅 fallbacks"}；排除中转 ${cfg.excludeProviders.join(", ") || "无"}；中转连败 ${cfg.providerFailStreak > 0 ? `${cfg.providerFailStreak} 次整体拉黑` : "关"}；每模型重试 ${cfg.retriesPerModel} 次后切换；同错熔断 ${cfg.identicalFailuresLimit > 0 ? `${cfg.identicalFailuresLimit} 次` : "关"}；重试间隔随机 ${Math.round(cfg.retryBackoffMinMs / 1000)}~${Math.round(cfg.retryBackoffMaxMs / 1000)} 秒；继续上限 ${cfg.continueMax} 次/会话；冷却 ${Math.round(cfg.modelCooldownMs / 60000)} 分钟`,
			`轮换池（✓ 可用，⏳ 冷却中，● = fallbacks 优先位，○ = 动态枚举，‼ = 整个中转认证失败）：`,
			...pool.map((f) => {
				const key = keyOf(f);
				const inFallbacks = cfg.fallbacks.some((x) => keyOf(x) === key);
				const failedAt = coolingUntil(f);
				const providerDead = Boolean(modelFails.get(`${f.provider}/*`));
				const remain = cfg.modelCooldownMs - (now - failedAt);
				return `  ${remain > 0 ? (providerDead ? "‼" : "⏳") : "✓"}${inFallbacks ? "●" : "○"} ${key}${remain > 0 ? `（冷却剩 ${remain > 90 * 60000 ? `${Math.ceil(remain / 3600000)} 小时` : `${Math.ceil(remain / 60000)} 分钟`}${providerDead ? "，认证失败整个中转跳过" : ""}）` : ""}`;
			}),
		];
		// 每个活动会话的轮换状态：切到哪了、切了几次，一目了然
		for (const [sid, slot] of sessions) {
			if (!slot.rot && !slot.switchCount) continue;
			const chain = slot.rot ? rotationChainOf(slot.rot) : null;
			const current = chain ? `${keyOf(chain[slot.rot.pos])}（${slot.rot.pos + 1}/${chain.length}）` : "（本轮已结束）";
			lines.push(`会话 ${sid.slice(0, 8)}…：当前模型 ${current}；本轮已切换 ${slot.switchCount} 次${slot.lastSwitchModel ? `，最近切到 ${slot.lastSwitchModel}` : ""}；继续已用 ${slot.continueUsed}/${cfg.continueMax}`);
		}
		lines.push(`日志（每次切换都有 plan: switch 记录）：${LOG_FILE}`);
		return { kind: "success", text: lines.join("\n") };
	}

	// ---- 3.5 本地控制端点：给标题栏开关（lib/client.js）读取与切换运行状态
	// 只绑 127.0.0.1，仅 GET /status 与 POST /toggle 两个接口；端口被占用则跳过（按钮显示不可用）

	let uiServer = null;
	if (cfg.uiPort > 0) {
		try {
			uiServer = http.createServer((req, res) => {
				res.setHeader("Access-Control-Allow-Origin", "*");
				res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
				if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
				if (req.method === "GET" && req.url === "/status") {
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ running }));
					return;
				}
				if (req.method === "POST" && req.url === "/toggle") {
					running = !running;
					logLine(false, running ? "enabled via UI toggle" : "disabled via UI toggle");
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ running }));
					return;
				}
				if (req.method === "GET" && req.url === "/config") {
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify({
						retriesPerModel: cfg.retriesPerModel,
						retryBackoffMinMs: cfg.retryBackoffMinMs,
						retryBackoffMaxMs: cfg.retryBackoffMaxMs,
						continueMax: cfg.continueMax,
					}));
					return;
				}
				if (req.method === "POST" && req.url === "/config") {
					let body = "";
					req.on("data", (chunk) => { body += chunk; if (body.length > 4096) req.destroy(); });
					req.on("end", () => {
						try {
							const patch = JSON.parse(body || "{}");
							if (Number.isFinite(patch.retriesPerModel)) cfg.retriesPerModel = clampInt(patch.retriesPerModel, 0, 10, cfg.retriesPerModel);
							if (Number.isFinite(patch.retryBackoffMinMs)) cfg.retryBackoffMinMs = clampInt(patch.retryBackoffMinMs, 0, 10 * 60 * 1000, cfg.retryBackoffMinMs);
							if (Number.isFinite(patch.retryBackoffMaxMs)) cfg.retryBackoffMaxMs = clampInt(patch.retryBackoffMaxMs, 0, 10 * 60 * 1000, cfg.retryBackoffMaxMs);
							if (cfg.retryBackoffMaxMs < cfg.retryBackoffMinMs) cfg.retryBackoffMaxMs = cfg.retryBackoffMinMs;
							if (Number.isFinite(patch.continueMax)) cfg.continueMax = clampInt(patch.continueMax, 1, 500, cfg.continueMax);
							saveSettings();
							logLine(false, `UI config updated: retries/model=${cfg.retriesPerModel}, backoff=${cfg.retryBackoffMinMs}~${cfg.retryBackoffMaxMs}ms, budget=${cfg.continueMax}`);
							res.writeHead(200, { "Content-Type": "application/json" });
							res.end(JSON.stringify({
								retriesPerModel: cfg.retriesPerModel,
								retryBackoffMinMs: cfg.retryBackoffMinMs,
								retryBackoffMaxMs: cfg.retryBackoffMaxMs,
								continueMax: cfg.continueMax,
							}));
						} catch (error) {
							res.writeHead(400, { "Content-Type": "application/json" });
							res.end(JSON.stringify({ error: String(error).slice(0, 120) }));
						}
					});
					return;
				}
				res.writeHead(404);
				res.end();
			});
			uiServer.on("error", (error) => {
				logLine(false, `ui toggle endpoint unavailable: ${String(error).slice(0, 90)}`);
				uiServer = null;
			});
			uiServer.listen(cfg.uiPort, "127.0.0.1");
			logLine(cfg.verbose, `ui toggle endpoint on http://127.0.0.1:${cfg.uiPort}`);
		} catch (error) {
			logLine(false, `ui toggle endpoint failed: ${String(error).slice(0, 90)}`);
		}
	}

	// ---- cleanup

	return function dispose() {
		running = false;
		try { uiServer?.close(); } catch { /* ignore */ }
		for (const timer of timers) clearTimeout(timer);
		timers.clear();
		try { commandDisposer?.(); } catch { /* ignore */ }
		for (const off of disposers) {
			try { typeof off === "function" && off(); } catch { /* ignore */ }
		}
		logLine(false, "disposed");
	};
}

const plugin = {
	name,
	inject,
	apply,
};

export default plugin;
