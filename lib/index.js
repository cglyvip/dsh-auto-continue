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

export const name = "dsh-auto-continue";
export const inject = [];

export const version = "0.2.0";

const DEFAULT_FALLBACKS = [
	{ provider: "fengwind", model: "deepseek-v4.1-flash" },
	{ provider: "fengwind", model: "kimi-k3" },
	{ provider: "fengwind", model: "mimo-v2.6-flash" },
	{ provider: "fengwind", model: "gemini-3.8-flash" },
	{ provider: "fengwind", model: "muse-spark-1.3-contributor" },
	{ provider: "fengwind", model: "space-bunny-alpha" },
];

const DEFAULTS = {
	enabled: true,
	autoContinue: true,
	continueText: "继续",
	continueMax: 30,
	continueDelayMs: 1500,
	autoSwitchModel: true,
	fallbacks: DEFAULT_FALLBACKS,
	/** 同一模型连续重试多少次后才切到下一个兜底（0 = 失败立刻切换） */
	retriesPerModel: 3,
	/** 模型失败后多久内不再选它（毫秒）；只约束"首次离开起点"的那次切换 */
	modelCooldownMs: 10 * 60 * 1000,
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
		continueMax: clampInt(src.continueMax, 1, 50, DEFAULTS.continueMax),
		continueDelayMs: clampInt(src.continueDelayMs, 0, 30000, DEFAULTS.continueDelayMs),
		retriesPerModel: clampInt(src.retriesPerModel, 0, 10, DEFAULTS.retriesPerModel),
		autoSwitchModel: src.autoSwitchModel !== false,
		fallbacks: normalizeFallbacks(src.fallbacks?.length ? src.fallbacks : DEFAULTS.fallbacks),
		modelCooldownMs: clampInt(src.modelCooldownMs, 0, 60 * 60 * 1000, DEFAULTS.modelCooldownMs),
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
	return after.some((event) => event?.type === "user/message" && event.data?.source?.kind !== "plugin");
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

function makeContinueMessage(text, verbose) {
	return {
		id: `dsh-auto-continue-${randomUUID()}`,
		role: "user",
		content: [{ type: "text", text }],
		source: {
			kind: "plugin",
			plugin: "dsh-auto-continue",
			form: "notice",
			summary: verbose ? "auto-continue" : "继续",
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
	logLine(false, `v${version} loaded; autoSwitch=${cfg.autoSwitchModel} fallbacks=${cfg.fallbacks.map((f) => `${f.provider}/${f.model}`).join(", ") || "(无)"}`);

	/** sessionId → { continueUsed, lastContinueSeq, observedError, lastFailure } */
	const sessions = new Map();
	/** "provider/model" → 上次失败时间戳（跨会话共享：一个模型挂了大概率都挂） */
	const modelFails = new Map();
	const timers = new Set();
	const disposers = [];
	let running = true;

	function slotOf(id) {
		let slot = sessions.get(id);
		if (!slot) {
			slot = { continueUsed: 0, lastContinueSeq: 0, observedError: false, lastFailure: null, rot: null };
			sessions.set(id, slot);
		}
		return slot;
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
				const sel = currentSelectionOf(agent);
				const provider = String(payload?.provider || sel?.provider || "");
				const model = String(sel?.model || "");
				const code = String(payload?.failure?.code || "");
				const message = String(payload?.failure?.message || "").slice(0, 200);
				const slot = slotOf(id);
				slot.observedError = true;
				slot.lastFailure = { provider, model, code, message, at: Date.now() };
				if (provider && model) modelFails.set(`${provider}/${model}`, Date.now());
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
			return;
		}
		if (!cfg.autoContinue) return;
		if (agent.status === "running" || inboxBusy(agent)) return;
		if (hasFreshHumanTurn(events)) return;
		if (!info.seq || slot.lastContinueSeq === info.seq) return;

		let switchTo = null;
		let sentNote = "";
		if (info.kind === "error") {
			// 只处理本插件亲眼观察到的失败，避免启动时翻旧账
			if (!slot.observedError || !slot.lastFailure) return;
			if (cfg.autoSwitchModel && cfg.fallbacks.length) {
				syncRotation(slot, id);
				const chain = rotationChainOf(slot.rot);
				if (chain.length > 1 && slot.rot.count >= cfg.retriesPerModel) {
					// 当前模型重试额度用完 → 沿链前进一格（链尾绕回起点，循环往复）
					const from = chain[slot.rot.pos];
					switchTo = advanceRotation(slot);
					logLine(false, `plan: switch ${keyOf(from)} -> ${keyOf(switchTo)} (cycle ${slot.rot.pos + 1}/${rotationChainOf(slot.rot).length}, session=${id})`);
				} else {
					// 还在重试额度内：留在当前模型，只注入继续
					slot.rot.count += 1;
					sentNote = `, retry ${slot.rot.count}/${cfg.retriesPerModel} on ${keyOf(chain[slot.rot.pos])}`;
					logLine(cfg.verbose, `plan: retry ${keyOf(chain[slot.rot.pos])} (session=${id})`);
				}
			}
		} else if (info.kind === "max-tokens") {
			if (!cfg.maxTokensContinue) return;
		} else {
			return; // aborted / interrupted / 未知：不碰
		}

		if (slot.continueUsed >= cfg.continueMax) {
			logLine(false, `continue budget exhausted (session=${id}, used=${slot.continueUsed}/${cfg.continueMax})`);
			return;
		}
		slot.continueUsed += 1;
		slot.lastContinueSeq = info.seq;

		schedule(() => {
			(async () => {
				try {
					// 1.5s 内用户可能已经自己发了消息：重新确认还是同一个停住的状态
					if (!running || agent.status === "running" || inboxBusy(agent) || hasFreshHumanTurn(sessionEventsOf(agent))) {
						slot.continueUsed -= 1;
						return;
					}
						if (switchTo) await applySelection(agent, switchTo);
						agent.followup(makeContinueMessage(cfg.continueText, cfg.verbose));
						logLine(false, `auto-continue sent (session=${id}, used=${slot.continueUsed}/${cfg.continueMax}${switchTo ? `, switched to ${switchTo.provider}/${switchTo.model}` : sentNote})`);
				} catch (error) {
					slot.continueUsed -= 1;
					logLine(false, "followup failed:", String(error));
				}
			})();
		}, cfg.continueDelayMs);
	}

	function keyOf(f) {
		return `${f.provider}/${f.model}`;
	}

	/** 轮换链：起点模型在前，兜底链随后（去掉与起点重复的项） */
	function rotationChainOf(rot) {
		const originKey = keyOf(rot.origin);
		return [rot.origin, ...cfg.fallbacks.filter((f) => keyOf(f) !== originKey)];
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
		}
	}

	/** 沿轮换链前进一格：首次离开起点挑第一个不在冷却期的兜底，之后严格 +1、链尾绕回起点 */
	function advanceRotation(slot) {
		const rot = slot.rot;
		const chain = rotationChainOf(rot);
		let idx;
		if (rot.pos === 0) {
			const now = Date.now();
			idx = chain.findIndex((f, i) => {
				if (i === 0) return false;
				const failedAt = modelFails.get(keyOf(f)) || 0;
				return !(cfg.modelCooldownMs > 0 && now - failedAt < cfg.modelCooldownMs);
			});
			if (idx < 0) idx = 1; // 兜底全在冷却：忽略冷却，从第一个兜底开始循环
		} else {
			idx = (rot.pos + 1) % chain.length;
		}
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
		const agents = ctx.get?.("agents");
		agents?.selectForNextRequest?.(agent, selected);
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
			sessions.clear();
			return { kind: "success", text: "已清空失败冷却与继续计数" };
		}
		const now = Date.now();
		const lines = [
			`dsh-auto-continue v${version}：${running ? "运行中" : "已停用"}；自动换模型 ${cfg.autoSwitchModel ? "开" : "关"}；每模型重试 ${cfg.retriesPerModel} 次后切换；继续上限 ${cfg.continueMax} 次/会话；冷却 ${Math.round(cfg.modelCooldownMs / 60000)} 分钟`,
			`兜底链（✓ 可用，⏳ 冷却中）：`,
			...cfg.fallbacks.map((f) => {
				const key = `${f.provider}/${f.model}`;
				const failedAt = modelFails.get(key) || 0;
				const remain = cfg.modelCooldownMs - (now - failedAt);
				return `  ${remain > 0 ? "⏳" : "✓"} ${key}${remain > 0 ? `（剩 ${Math.ceil(remain / 60000)} 分钟）` : ""}`;
			}),
			`日志：${LOG_FILE}`,
		];
		return { kind: "success", text: lines.join("\n") };
	}

	// ---- cleanup

	return function dispose() {
		running = false;
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
