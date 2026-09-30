/**
 * dsh-auto-continue 逻辑模拟测试（不依赖 dsh 运行）：
 *   node test/simulate.mjs
 * 用 mock ctx + mock agent 走完整事件流，验证 7 个场景。
 */
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const mod = await import(pathToFileURL(fileURLToPath(new URL("../lib/index.js", import.meta.url))).href);

function makeHarness({ events, selection = { provider: "fengwind", model: "glm-5.3-flash" }, cfg }) {
	const listeners = new Map();
	const calls = { selections: [], followups: [], errors: [] };
	const agent = {
		id: "sess-1",
		status: "idle",
		inbox: { hasPending: () => false },
		followup(msg) { calls.followups.push(msg); },
		session: {
			snapshotEvents: () => events,
			requestHeader: () => ({ config: selection }),
		},
	};
	const ctx = {
		on(event, handler) {
			if (!listeners.has(event)) listeners.set(event, []);
			listeners.get(event).push(handler);
			return () => listeners.delete(event);
		},
		get(name) {
			if (name === "agents") return { selectForNextRequest(a, sel) { calls.selections.push(sel); } };
			if (name === "llm") return { resolveCallConfig: async (r) => ({ provider: r.provider, model: r.model }) };
			if (name === "commands") return { register() { return () => {}; } };
			return undefined;
		},
	};
	const dispose = mod.apply(ctx, cfg);
	return {
		agent, calls, dispose,
		async fire(event, payload) {
			for (const handler of listeners.get(event) || []) {
				const result = handler(payload, async () => undefined);
				if (result && typeof result.then === "function") await result;
			}
		},
	};
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
function check(label, cond) {
	console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
	if (!cond) failed += 1;
}

const turnError = [
	{ type: "user/message", seq: 1, data: { source: { kind: "user" } } },
	{ type: "turn/end", seq: 2, data: { turn: 1, reason: { kind: "error", code: "SERVER", message: "503 gateway" } } },
];

// --- 场景1:失败 → 自动切到第一个兜底模型并注入继续
{
	const h = makeHarness({ events: turnError, cfg: { continueDelayMs: 50, verbose: true } });
	await h.fire("agent/request-error", { agent: h.agent, provider: "fengwind", failure: { code: "SERVER", message: "503" } });
	h.agent.status = "idle";
	await h.fire("agent/status", { agent: h.agent, status: "idle" });
	await sleep(120);
	check("切换到 deepseek-v4.1-flash", h.calls.selections.length === 1 && h.calls.selections[0].model === "deepseek-v4.1-flash");
	check("注入了继续消息", h.calls.followups.length === 1 && h.calls.followups[0].content[0].text === "继续" && h.calls.followups[0].source.kind === "plugin");
	h.dispose();
}

// --- 场景2:用户主动停止不续跑
{
	const events = [
		{ type: "user/message", seq: 1, data: { source: { kind: "user" } } },
		{ type: "turn/end", seq: 2, data: { turn: 1, reason: { kind: "aborted", reason: "user" } } },
	];
	const h = makeHarness({ events, cfg: { continueDelayMs: 30 } });
	await h.fire("agent/request-error", { agent: h.agent, provider: "fengwind", failure: { code: "SERVER" } });
	await h.fire("agent/status", { agent: h.agent, status: "idle" });
	await sleep(80);
	check("用户停止不触发", h.calls.followups.length === 0 && h.calls.selections.length === 0);
	h.dispose();
}

// --- 场景3:没观察到 request-error 的历史失败轮不碰(重启后不翻旧账)
{
	const h = makeHarness({ events: turnError, cfg: { continueDelayMs: 30 } });
	await h.fire("agent/status", { agent: h.agent, status: "idle" });
	await sleep(80);
	check("未观察到的失败不触发", h.calls.followups.length === 0);
	h.dispose();
}

// --- 场景4:同一失败轮不重复续跑;新失败轮重新计数;预算上限生效
{
	const h = makeHarness({ events: turnError, cfg: { continueDelayMs: 30, continueMax: 2 } });
	for (let round = 0; round < 3; round += 1) {
		const base = round * 2;
		const events = [
			{ type: "user/message", seq: base + 1, data: { source: { kind: "user" } } },
			{ type: "turn/end", seq: base + 2, data: { turn: round + 1, reason: { kind: "error", code: "SERVER" } } },
		];
		h.agent.session.snapshotEvents = () => events;
		await h.fire("agent/request-error", { agent: h.agent, provider: "fengwind", failure: { code: "SERVER" } });
		await h.fire("agent/status", { agent: h.agent, status: "idle" });
		await sleep(80);
	}
	check("预算上限 2 次生效", h.calls.followups.length === 2);
	h.dispose();
}

// --- 场景5:冷却中的模型被跳过,选下一个健康兜底
{
	const h = makeHarness({ events: turnError, cfg: { continueDelayMs: 30, fallbacks: [
		{ provider: "fengwind", model: "deepseek-v4.1-flash" },
		{ provider: "fengwind", model: "kimi-k3" },
	] } });
	await h.fire("agent/request-error", { agent: h.agent, provider: "fengwind", failure: { code: "SERVER" } });
	// 模拟"切过去之后又失败":把 selection 换成 deepseek 再失败一次
	h.agent.session.requestHeader = () => ({ config: { provider: "fengwind", model: "deepseek-v4.1-flash" } });
	await h.fire("agent/request-error", { agent: h.agent, provider: "fengwind", failure: { code: "SERVER" } });
	h.agent.session.requestHeader = () => ({ config: { provider: "fengwind", model: "glm-5.3-flash" } });
	// 重置会话计数,模拟新一轮失败
	const events2 = [
		{ type: "user/message", seq: 3, data: { source: { kind: "user" } } },
		{ type: "turn/end", seq: 4, data: { turn: 2, reason: { kind: "error", code: "SERVER" } } },
	];
	h.agent.session.snapshotEvents = () => events2;
	await h.fire("agent/request-error", { agent: h.agent, provider: "fengwind", failure: { code: "SERVER" } });
	await h.fire("agent/status", { agent: h.agent, status: "idle" });
	await sleep(80);
	check("冷却跳过失败模型选 kimi-k3", h.calls.selections.at(-1)?.model === "kimi-k3");
	h.dispose();
}

// --- 场景6:用户在失败后自己发了消息 → 不插手
{
	const events = [
		{ type: "user/message", seq: 1, data: { source: { kind: "user" } } },
		{ type: "turn/end", seq: 2, data: { turn: 1, reason: { kind: "error", code: "SERVER" } } },
		{ type: "user/message", seq: 3, data: { source: { kind: "user" } } },
	];
	const h = makeHarness({ events, cfg: { continueDelayMs: 30 } });
	await h.fire("agent/request-error", { agent: h.agent, provider: "fengwind", failure: { code: "SERVER" } });
	h.agent.status = "running";
	await h.fire("agent/status", { agent: h.agent, status: "running" });
	h.agent.status = "idle";
	await h.fire("agent/status", { agent: h.agent, status: "idle" });
	await sleep(80);
	check("用户已接手则不触发", h.calls.followups.length === 0);
	h.dispose();
}

// --- 场景7:max-tokens 截断 → 只续跑不换模型
{
	const events = [
		{ type: "user/message", seq: 1, data: { source: { kind: "user" } } },
		{ type: "turn/end", seq: 2, data: { turn: 1, reason: { kind: "max-tokens" } } },
	];
	const h = makeHarness({ events, cfg: { continueDelayMs: 30 } });
	await h.fire("agent/status", { agent: h.agent, status: "idle" });
	await sleep(80);
	check("max-tokens 续跑且不换模型", h.calls.followups.length === 1 && h.calls.selections.length === 0);
	h.dispose();
}

console.log(failed === 0 ? "\n全部通过 ✅" : `\n${failed} 项失败 ❌`);
process.exit(failed === 0 ? 0 : 1);
