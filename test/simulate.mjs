/**
 * dsh-auto-continue 逻辑模拟测试（不依赖 dsh 运行）：
 *   node test/simulate.mjs
 * 用 mock ctx + mock agent 走完整事件流，验证 16 个场景。
 */
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

// 把 DSH_HOME 指到临时目录：隔离生产日志与冷却记录文件（model-fails.json），互不污染
process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-auto-continue-test-"));

const mod = await import(pathToFileURL(fileURLToPath(new URL("../lib/index.js", import.meta.url))).href);

function makeHarness({ selection = { provider: "fengwind", model: "glm-5.3-flash" }, cfg, llm }) {
	const listeners = new Map();
	const calls = { selections: [], followups: [], errors: [], defaultModelSaves: [] };
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
			if (name === "agents") return { /* 真实 dsh 里这是底层注册表，没有 selectForNextRequest */ };
			if (name === "sessionController") return { agents: { selectForNextRequest(a, sel) { calls.selections.push(sel); } } };
			if (name === "agentDefaultModel") return { saveSelection: async (sel) => { calls.defaultModelSaves.push(sel); } };
			if (name === "llm") return { resolveCallConfig: async (r) => ({ provider: r.provider, model: r.model }), ...(llm || {}) };
			if (name === "commands") return { register() { return () => {}; } };
			return undefined;
		},
	};
	// 每个场景独立的冷却状态：清掉上一个场景持久化的 model-fails.json
	try { fs.rmSync(path.join(process.env.DSH_HOME, "auto-continue", "model-fails.json"), { force: true }); } catch { /* ignore */ }
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
	check("切换提示写明前后模型名", h.calls.followups[2]?.content?.[0]?.text?.includes("glm-5.3-flash 模型连续 2 次运行失败") === true && h.calls.followups[2]?.content?.[0]?.text?.includes("即将切换到 deepseek-v4.1-flash") === true);
	check("切换同步更新界面选择器（agentDefaultModel）", h.calls.defaultModelSaves.at(-1)?.model === "deepseek-v4.1-flash");
	h.dispose();
}

// --- 场景3: 链尾绕回起点，循环往复
{
	const h = makeHarness({ cfg: { continueDelayMs: 30, retriesPerModel: 1, providerFailStreak: 0, fallbacks: [
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
	const h = makeHarness({ cfg: { continueDelayMs: 30, retriesPerModel: 1, providerFailStreak: 0, fallbacks: [
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
	const h = makeHarness({ cfg: { continueDelayMs: 30, retriesPerModel: 1, providerFailStreak: 0, fallbacks: [
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
	const h = makeHarness({ cfg: { continueDelayMs: 30, retriesPerModel: 1, providerFailStreak: 0, fallbacks: [
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
	const h = makeHarness({ cfg: { continueDelayMs: 30, continueMax: 2, retriesPerModel: 3 } });
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

// --- 场景14: 熔断默认关闭——不同模型报同样的错也继续循环，不停止
{
	const h = makeHarness({ cfg: { continueDelayMs: 30, retriesPerModel: 3, fallbacks: [
		{ provider: "api029", model: "deepseek-v4.1-flash" },
		{ provider: "api029", model: "kimi-k3" },
	] } });
	for (let n = 1; n <= 10; n += 1) await failRound(h, n, "cb/qwen-3.8-27b", "api029", "SERVER", "503 gateway down");
	// 10 轮 = 起点 3 次重试 + 切 deepseek（1 次切换继续 + 3 次重试）+ 切 kimi（1 次切换继续 + 2 次重试）
	check("熔断默认关：一直循环不停止", h.calls.followups.length === 10 && h.calls.selections.length === 2);
	h.dispose();
}

// --- 场景14b: 显式开启熔断（identicalFailuresLimit>0）时仍会停止
{
	const h = makeHarness({ cfg: { continueDelayMs: 30, retriesPerModel: 3, identicalFailuresLimit: 3, fallbacks: [
		{ provider: "api029", model: "deepseek-v4.1-flash" },
		{ provider: "api029", model: "kimi-k3" },
	] } });
	for (let n = 1; n <= 10; n += 1) await failRound(h, n, "cb/qwen-3.8-27b", "api029", "SERVER", "503 gateway down");
	check("显式开启熔断后停止续跑", h.calls.followups.length === 8 && h.calls.selections.length === 2);
	h.dispose();
}

// --- 场景15: 429 限流不再单独停止，照常走"重试 3 遍 → 切换"的循环
{
	const h = makeHarness({ cfg: { continueDelayMs: 30, retryBackoffMinMs: 40, retryBackoffMaxMs: 80, retriesPerModel: 3, fallbacks: [
		{ provider: "api029", model: "deepseek-v4.1-flash" },
		{ provider: "api029", model: "kimi-k3" },
	] } });
	for (let n = 1; n <= 5; n += 1) {
		await failRound(h, n, "cb/qwen-3.8-27b", "api029", "CONTEXT_WINDOW_EXCEEDED", '429: {"message":"Tokens per minute limit exceeded - too many tokens processed."}');
	}
	await sleep(200);
	check("429 照常重试 3 遍后切换", h.calls.followups.length === 5 && JSON.stringify(h.calls.selections.map((s) => s.model)) === JSON.stringify(["deepseek-v4.1-flash"]));
	check("限流轮的消息正文带提示", h.calls.followups[0]?.content?.[0]?.text?.includes("限流") === true);
	h.dispose();
}

// --- 场景16: 全模型轮换池——按中转交错排序：同源下一顺位在冷却时，直接跳到另一家中转
{
	const h = makeHarness({
		cfg: { continueDelayMs: 30, retriesPerModel: 1, providerFailStreak: 0, fallbacks: [
			{ provider: "fengwind", model: "mimo-v2.6-flash" },
			{ provider: "fengwind", model: "deepseek-v4.1-flash" },
		] },
		llm: {
			listProviders: () => [{ id: "fengwind" }, { id: "qq214" }],
			listModels: async (pid) => pid === "fengwind"
				? [{ id: "mimo-v2.6-flash" }, { id: "deepseek-v4.1-flash" }]
				: [{ id: "GLM-5.3-Flash" }],
		},
	});
	await markFailed(h, "mimo-v2.6-flash"); // mimo 先进入冷却
	for (let n = 1; n <= 2; n += 1) await failRound(h, n); // glm 失败：重试 1 次 → 切换到 qq214/GLM
	for (let n = 3; n <= 4; n += 1) await failRound(h, n, "GLM-5.3-Flash", "qq214", "SERVER"); // GLM 重试后失败 → 轮换到 deepseek
	await sleep(150);
	const models = h.calls.selections.map((s) => `${s.provider}/${s.model}`);
	// 链 = [glm, mimo(冷却), qq214/GLM, fengwind/deepseek]——交错让 qq214 排在 deepseek 之前
	check("池序按中转交错：跳过冷却的同源模型后先到另一家中转", models[0] === "qq214/GLM-5.3-Flash");
	check("轮换池覆盖另一中转的模型且同源模型仍在池中", models.includes("fengwind/deepseek-v4.1-flash"));
	h.dispose();
}

// --- 场景17: useAllConfiguredModels: false 时只用 fallbacks，不碰动态枚举的模型
{
	const h = makeHarness({
		cfg: { continueDelayMs: 30, useAllConfiguredModels: false, fallbacks: [{ provider: "fengwind", model: "mimo-v2.6-flash" }] },
		llm: {
			listProviders: () => [{ id: "fengwind" }, { id: "qq214" }],
			listModels: async (pid) => pid === "fengwind"
				? [{ id: "mimo-v2.6-flash" }, { id: "deepseek-v4.1-flash" }]
				: [{ id: "GLM-5.3-Flash" }],
		},
	});
	for (let n = 1; n <= 4; n += 1) await failRound(h, n);
	await sleep(150);
	check("关闭全模型轮换时不越出 fallbacks", h.calls.selections.every((s) => s.provider === "fengwind"));
	h.dispose();
}

// --- 场景18: excludeProviders 把指定中转整体排除出轮换池
{
	const h = makeHarness({
		cfg: { continueDelayMs: 30, excludeProviders: ["deepseek-official"], fallbacks: [{ provider: "fengwind", model: "mimo-v2.6-flash" }] },
		llm: {
			listProviders: () => [{ id: "fengwind" }, { id: "deepseek-official" }],
			listModels: async (pid) => pid === "fengwind"
				? [{ id: "mimo-v2.6-flash" }, { id: "deepseek-v4.1-flash" }]
				: [{ id: "deepseek-flash" }],
		},
	});
	for (let n = 1; n <= 6; n += 1) await failRound(h, n);
	await sleep(150);
	check("排除中转不进轮换池", h.calls.selections.every((s) => s.provider !== "deepseek-official"));
	h.dispose();
}

// --- 场景19: AUTH 类失败把整个中转拉黑，轮换直接跳过它的全部模型
{
	const h = makeHarness({
		cfg: { continueDelayMs: 30, fallbacks: [{ provider: "fengwind", model: "mimo-v2.6-flash" }] },
		llm: {
			listProviders: () => [{ id: "fengwind" }, { id: "badkey" }],
			listModels: async (pid) => pid === "fengwind"
				? [{ id: "mimo-v2.6-flash" }, { id: "deepseek-v4.1-flash" }]
				: [{ id: "model-a" }, { id: "model-b" }],
		},
	});
	// 第 1 轮正常失败 → 重试；第 2 轮 AUTH 失败 → badkey 整个中转拉黑；后续轮换必须绕开 badkey
	await failRound(h, 1, "mimo-v2.6-flash", "fengwind", "SERVER");
	await failRound(h, 2, "model-a", "badkey", "AUTH", "Authentication Fails, Your api key is invalid");
	for (let n = 3; n <= 6; n += 1) await failRound(h, n, "model-a", "badkey", "SERVER");
	await sleep(150);
	const models = h.calls.selections.map((s) => `${s.provider}/${s.model}`);
	check("AUTH 拉黑后不再选该中转的任何模型", h.calls.selections.every((s) => s.provider !== "badkey"));
	check("轮换继续在健康中转上进行", models.includes("fengwind/deepseek-v4.1-flash"));
	h.dispose();
}

// --- 场景20: 同一中转连败 3 次 → 整体拉黑（model-fails.json 出现 provider/* 键）
{
	const h = makeHarness({
		cfg: { continueDelayMs: 30, useAllConfiguredModels: false, fallbacks: [
			{ provider: "fengwind", model: "mimo-v2.6-flash" },
			{ provider: "fengwind", model: "deepseek-v4.1-flash" },
		] },
	});
	for (let n = 1; n <= 3; n += 1) await failRound(h, n, "mimo-v2.6-flash", "fengwind", "SERVER", "Gateway attempt budget is exhausted");
	await sleep(100);
	const fails = JSON.parse(fs.readFileSync(path.join(process.env.DSH_HOME, "auto-continue", "model-fails.json"), "utf8"));
	check("连败 3 次触发中转级拉黑", Boolean(fails["fengwind/*"]));
	h.dispose();
}

console.log(failed === 0 ? "\n全部通过 ✅" : `\n${failed} 项失败 ❌`);
process.exit(failed === 0 ? 0 : 1);
