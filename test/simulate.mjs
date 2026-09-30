/**
 * dsh-auto-continue 逻辑模拟测试（不依赖 dsh 运行）：
 *   node test/simulate.mjs
 * 用 mock ctx + mock agent 走完整事件流，验证 15 个场景。
 */
import { pathToFileURL, fileURLToPath } from "node:url";

const mod = await import(pathToFileURL(fileURLToPath(new URL("../lib/index.js", import.meta.url))).href);

function makeHarness({ selection = { provider: "fengwind", model: "glm-5.3-flash" }, cfg }) {
	const listeners = new Map();
	const calls = { selections: [], followups: [], errors: [] };
	const agent = {
		id: "sess-1",
		status: "idle",
		inbox: { hasPending: () => false },
		followup(msg) { calls.followups.push(msg); },
		session: {
			snapshotEvents: () => [],
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
	// 测试默认关闭随机长退避（0/0 → 退回 continueDelayMs），需要测退避的场景自行覆盖
	const dispose = mod.apply(ctx, { retryBackoffMinMs: 0, retryBackoffMaxMs: 0, ...cfg });
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

/** 走一轮完整失败流程：request-error → 本轮以 error 结束 → agent 空闲 */
async function failRound(h, n, model = "glm-5.3-flash", provider = "fengwind", code = "SERVER", message) {
	const base = (n - 1) * 2;
	h.agent.session.snapshotEvents = () => [
		{ type: "user/message", seq: base + 1, data: { source: { kind: "user" } } },
		{ type: "turn/end", seq: base + 2, data: { turn: n, reason: { kind: "error", code } } },
	];
	h.agent.session.requestHeader = () => ({ config: { provider, model } });
	await h.fire("agent/request-error", { agent: h.agent, provider, failure: { code, message: message ?? `503 from ${model}` } });
	await h.fire("agent/status", { agent: h.agent, status: "idle" });
	await sleep(60);
}

/** 只喂一次 request-error（给模型记冷却，不触发决策） */
async function markFailed(h, model, provider = "fengwind") {
	h.agent.session.requestHeader = () => ({ config: { provider, model } });
	await h.fire("agent/request-error", { agent: h.agent, provider, failure: { code: "SERVER", message: "503" } });
}

// --- 场景1: 首次失败先留在原模型重试，不切换
{
	const h = makeHarness({ cfg: { continueDelayMs: 30, verbose: true } });
	await failRound(h, 1);
	check("首次失败留在原模型重试（不切换）", h.calls.followups.length === 1 && h.calls.selections.length === 0);
	check("注入了可见且署名的继续消息", h.calls.followups[0]?.content?.[0]?.text?.startsWith("继续") === true && h.calls.followups[0].source.kind === "user" && h.calls.followups[0].source.producer === "dsh-auto-continue");
	h.dispose();
}

// --- 场景2: 同模型重试额度用完后切换到第一个兜底
{
	const h = makeHarness({ cfg: { continueDelayMs: 30, retriesPerModel: 2 } });
	for (let n = 1; n <= 3; n += 1) await failRound(h, n);
	check("重试 2 次后切到 deepseek-v4.1-flash", h.calls.selections.length === 1 && h.calls.selections[0].model === "deepseek-v4.1-flash");
	check("共注入 3 次继续", h.calls.followups.length === 3);
	check("切换提示写进消息正文", h.calls.followups[2]?.content?.[0]?.text?.startsWith("继续（已自动切换到 deepseek-v4.1-flash") === true);
	h.dispose();
}

// --- 场景3: 链尾绕回起点，循环往复
{
	const h = makeHarness({ cfg: { continueDelayMs: 30, retriesPerModel: 1, fallbacks: [
		{ provider: "fengwind", model: "deepseek-v4.1-flash" },
		{ provider: "fengwind", model: "kimi-k3" },
	] } });
	// 按轮传实际生效的模型：插件切换后，真实请求（及其报错）跟着切换走
	const models = ["glm-5.3-flash", "glm-5.3-flash", "deepseek-v4.1-flash", "deepseek-v4.1-flash", "kimi-k3", "kimi-k3"];
	for (let n = 1; n <= 6; n += 1) await failRound(h, n, models[n - 1]);
	check("切换顺序 deepseek→kimi→glm 循环往复", JSON.stringify(h.calls.selections.map((s) => s.model)) === JSON.stringify(["deepseek-v4.1-flash", "kimi-k3", "glm-5.3-flash"]));
	h.dispose();
}

// --- 场景4: 所有兜底都在冷却 → 首切忽略冷却，仍切到第一个兜底开始循环
{
	const h = makeHarness({ cfg: { continueDelayMs: 30, retriesPerModel: 1, fallbacks: [
		{ provider: "fengwind", model: "deepseek-v4.1-flash" },
		{ provider: "fengwind", model: "kimi-k3" },
	] } });
	await markFailed(h, "deepseek-v4.1-flash");
	await markFailed(h, "kimi-k3");
	await failRound(h, 1);
	await failRound(h, 2);
	check("兜底全冷却时仍切到第一个兜底", h.calls.selections.length === 1 && h.calls.selections[0].model === "deepseek-v4.1-flash");
	h.dispose();
}

// --- 场景5: 冷却中的兜底被跳过，选下一个健康的
{
	const h = makeHarness({ cfg: { continueDelayMs: 30, retriesPerModel: 1, fallbacks: [
		{ provider: "fengwind", model: "deepseek-v4.1-flash" },
		{ provider: "fengwind", model: "kimi-k3" },
	] } });
	await markFailed(h, "deepseek-v4.1-flash");
	await failRound(h, 1);
	await failRound(h, 2);
	check("首切跳过冷却中的 deepseek 选 kimi-k3", h.calls.selections.length === 1 && h.calls.selections[0].model === "kimi-k3");
	h.dispose();
}

// --- 场景6: 中途手动换模型 → 以新模型为起点重开循环
{
	const h = makeHarness({ cfg: { continueDelayMs: 30, retriesPerModel: 1, fallbacks: [
		{ provider: "fengwind", model: "deepseek-v4.1-flash" },
		{ provider: "fengwind", model: "kimi-k3" },
	] } });
	await failRound(h, 1);                            // glm 失败 → 留在 glm 重试
	await failRound(h, 2);                            // glm 额度用完 → 切到 deepseek
	await failRound(h, 3, "deepseek-v4.1-flash");     // deepseek 首败 → 留下重试
	await failRound(h, 4, "mimo-v2.6-flash");         // 用户手动换成 mimo 后失败 → 重开循环，留在 mimo
	check("手动换模型后留在新模型不立刻切", h.calls.selections.length === 1 && h.calls.followups.length === 4);
	await failRound(h, 5, "mimo-v2.6-flash");         // mimo 额度用完 → 沿新链切换（deepseek 冷却中 → kimi）
	check("新循环首切跳过冷却的 deepseek", h.calls.selections.length === 2 && h.calls.selections[1].model === "kimi-k3");
	h.dispose();
}

// --- 场景7: 用户主动停止不续跑
{
	const events = [
		{ type: "user/message", seq: 1, data: { source: { kind: "user" } } },
		{ type: "turn/end", seq: 2, data: { turn: 1, reason: { kind: "aborted", reason: "user" } } },
	];
	const h = makeHarness({ cfg: { continueDelayMs: 30 } });
	h.agent.session.snapshotEvents = () => events;
	await h.fire("agent/request-error", { agent: h.agent, provider: "fengwind", failure: { code: "SERVER" } });
	await h.fire("agent/status", { agent: h.agent, status: "idle" });
	await sleep(80);
	check("用户停止不触发", h.calls.followups.length === 0 && h.calls.selections.length === 0);
	h.dispose();
}

// --- 场景8: 没观察到 request-error 的历史失败轮不碰（重启后不翻旧账）
{
	const events = [
		{ type: "user/message", seq: 1, data: { source: { kind: "user" } } },
		{ type: "turn/end", seq: 2, data: { turn: 1, reason: { kind: "error", code: "SERVER" } } },
	];
	const h = makeHarness({ cfg: { continueDelayMs: 30 } });
	h.agent.session.snapshotEvents = () => events;
	await h.fire("agent/status", { agent: h.agent, status: "idle" });
	await sleep(80);
	check("未观察到的失败不触发", h.calls.followups.length === 0);
	h.dispose();
}

// --- 场景9: 预算上限生效（含重试消耗）
{
	const h = makeHarness({ cfg: { continueDelayMs: 30, continueMax: 2 } });
	for (let n = 1; n <= 4; n += 1) await failRound(h, n);
	check("预算上限 2 次生效", h.calls.followups.length === 2 && h.calls.selections.length === 0);
	h.dispose();
}

// --- 场景10: 用户在失败后自己发了消息 → 不插手
{
	const events = [
		{ type: "user/message", seq: 1, data: { source: { kind: "user" } } },
		{ type: "turn/end", seq: 2, data: { turn: 1, reason: { kind: "error", code: "SERVER" } } },
		{ type: "user/message", seq: 3, data: { source: { kind: "user" } } },
	];
	const h = makeHarness({ cfg: { continueDelayMs: 30 } });
	h.agent.session.snapshotEvents = () => events;
	await h.fire("agent/request-error", { agent: h.agent, provider: "fengwind", failure: { code: "SERVER" } });
	h.agent.status = "running";
	await h.fire("agent/status", { agent: h.agent, status: "running" });
	h.agent.status = "idle";
	await h.fire("agent/status", { agent: h.agent, status: "idle" });
	await sleep(80);
	check("用户已接手则不触发", h.calls.followups.length === 0);
	h.dispose();
}

// --- 场景11: max-tokens 截断 → 只续跑不换模型
{
	const events = [
		{ type: "user/message", seq: 1, data: { source: { kind: "user" } } },
		{ type: "turn/end", seq: 2, data: { turn: 1, reason: { kind: "max-tokens" } } },
	];
	const h = makeHarness({ cfg: { continueDelayMs: 30 } });
	h.agent.session.snapshotEvents = () => events;
	await h.fire("agent/status", { agent: h.agent, status: "idle" });
	await sleep(80);
	check("max-tokens 续跑且不换模型", h.calls.followups.length === 1 && h.calls.selections.length === 0);
	h.dispose();
}

// --- 场景12: 会话流里插件自己注入的消息（user 形态 + producer 署名）不算"真人接手"
{
	const h = makeHarness({ cfg: { continueDelayMs: 30, retriesPerModel: 3 } });
	await failRound(h, 1); // 失败 → 注入继续（lastContinueSeq = 2）
	// 下一轮事件流：上一条注入消息已落盘（v4 producer kind），随后同一轮再次失败
	h.agent.session.snapshotEvents = () => [
		{ type: "user/message", seq: 1, data: { source: { kind: "user" } } },
		{ type: "turn/end", seq: 2, data: { turn: 1, reason: { kind: "error", code: "SERVER" } } },
		{ type: "user/message", seq: 3, data: { source: { kind: "user", producer: "dsh-auto-continue", form: "notice" } } },
		{ type: "turn/end", seq: 4, data: { turn: 2, reason: { kind: "error", code: "SERVER" } } },
	];
	h.agent.session.requestHeader = () => ({ config: { provider: "fengwind", model: "glm-5.3-flash" } });
	await h.fire("agent/request-error", { agent: h.agent, provider: "fengwind", failure: { code: "SERVER", message: "503" } });
	await h.fire("agent/status", { agent: h.agent, status: "idle" });
	await sleep(80);
	check("插件自己的消息不触发真人接手守卫", h.calls.followups.length === 2);
	h.dispose();
}

// --- 场景13: INVALID_REQUEST（确定性拒绝）不烧同模型重试，立刻切换
{
	const h = makeHarness({ cfg: { continueDelayMs: 30, retriesPerModel: 3, fallbacks: [
		{ provider: "api029", model: "deepseek-v4.1-flash" },
		{ provider: "api029", model: "kimi-k3" },
	] } });
	await failRound(h, 1, "cb/qwen-3.8-27b", "api029", "INVALID_REQUEST", "400: property 'store' is unsupported");
	await failRound(h, 2, "cb/qwen-3.8-27b", "api029", "INVALID_REQUEST", "400: property 'store' is unsupported");
	check("INVALID_REQUEST 连续快切不重试", JSON.stringify(h.calls.selections.map((s) => s.model)) === JSON.stringify(["deepseek-v4.1-flash", "kimi-k3"]) && h.calls.followups.length === 2);
	h.dispose();
}

// --- 场景14: 不同模型报完全相同的错误 → 熔断，不再空转预算
{
	const h = makeHarness({ cfg: { continueDelayMs: 30, retriesPerModel: 3, fallbacks: [
		{ provider: "api029", model: "deepseek-v4.1-flash" },
		{ provider: "api029", model: "kimi-k3" },
	] } });
	for (let n = 1; n <= 10; n += 1) await failRound(h, n, "cb/qwen-3.8-27b", "api029", "SERVER", "503 gateway down");
	check("同错熔断后停止续跑", h.calls.followups.length === 8 && h.calls.selections.length === 2);
	h.dispose();
}

// --- 场景15: 429 限流 → 随机退避后重试同一模型，超过次数上限则放弃
{
	const h = makeHarness({ cfg: { continueDelayMs: 30, retryBackoffMinMs: 40, retryBackoffMaxMs: 80, rateLimitMaxRetries: 3, fallbacks: [
		{ provider: "api029", model: "deepseek-v4.1-flash" },
		{ provider: "api029", model: "kimi-k3" },
	] } });
	for (let n = 1; n <= 5; n += 1) {
		await failRound(h, n, "cb/qwen-3.8-27b", "api029", "CONTEXT_WINDOW_EXCEEDED", '429: {"message":"Tokens per minute limit exceeded - too many tokens processed."}');
	}
	await sleep(200);
	check("429 限流退避重试且不换模型", h.calls.followups.length === 3 && h.calls.selections.length === 0);
	check("限流重试的消息正文带提示", h.calls.followups[0]?.content?.[0]?.text?.includes("限流") === true);
	h.dispose();
}

console.log(failed === 0 ? "\n全部通过 ✅" : `\n${failed} 项失败 ❌`);
process.exit(failed === 0 ? 0 : 1);
