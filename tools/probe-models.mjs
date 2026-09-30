// 全量模型探测：读取 dsh profile 的 llm-pi-ai 配置，逐 provider × model 发最小真实请求
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const profilePath = path.join(os.homedir(), ".dsh", "profiles", "desktop", "cordis.patch.yml");
const credPath = path.join(os.homedir(), ".dsh", ".credentials.yaml");
const lines = fs.readFileSync(profilePath, "utf8").split("\n");

// —— 解析 llm-pi-ai 的 providers 段 ——
const start = lines.findIndex((l) => l.trim() === "- id: llm-pi-ai");
const providers = {};
let cur = null;
for (let i = start + 1; i < lines.length; i += 1) {
	const l = lines[i];
	if (/^(- id|  id): /.test(l) && !l.includes("llm-pi-ai")) break; // 下一个顶层条目
	const prov = l.match(/^      (\S+):$/);
	if (prov) { cur = prov[1]; providers[cur] = { models: [] }; continue; }
	if (!cur) continue;
	const field = l.match(/^        (apiKeyEnv|api|baseURL): (.*)$/);
	if (field) { providers[cur][field[1]] = field[2].trim().replace(/^["']|["']$/g, ""); continue; }
	const model = l.match(/^          - id: (.+)$/);
	if (model) providers[cur].models.push(model[1].trim().replace(/^["']|["']$/g, ""));
}

// —— 解析凭据 refs ——
const keys = {};
let inRefs = false;
for (const l of fs.readFileSync(credPath, "utf8").split("\n")) {
	if (/^refs:/.test(l)) { inRefs = true; continue; }
	if (inRefs) {
		const m = l.match(/^  (\S+): (\S+)$/);
		if (m) keys[m[1]] = m[2];
	}
}

const total = Object.values(providers).reduce((n, p) => n + p.models.length, 0);
console.log(`共 ${Object.keys(providers).length} 个中转、${total} 个模型，开始逐个实测…\n`);

async function probe(provider, model, p) {
	const key = keys[p.apiKeyEnv];
	if (!key) return { verdict: "FAIL", reason: "找不到 API key" };
	const url = p.api === "openai-responses"
		? `${p.baseURL.replace(/\/$/, "")}/responses`
		: `${p.baseURL.replace(/\/$/, "")}/chat/completions`;
	const body = p.api === "openai-responses"
		? { model, input: "reply with just: ok", max_output_tokens: 30 }
		: { model, messages: [{ role: "user", content: "reply with just: ok" }], max_tokens: 30, stream: false };
	const started = Date.now();
	try {
		const res = await fetch(url, {
			method: "POST",
			headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(25000),
		});
		const ms = Date.now() - started;
		const text = await res.text();
		let j;
		try { j = JSON.parse(text); } catch { return { verdict: "FAIL", reason: `HTTP ${res.status} 非JSON: ${text.slice(0, 60)}`, ms }; }
		if (p.api === "openai-responses") {
			if (j.output_text || (Array.isArray(j.output) && j.output.length)) return { verdict: "SUCCESS", reason: (j.output_text || "ok").slice(0, 30), ms };
			if (j.error) return { verdict: "FAIL", reason: String(j.error.message || JSON.stringify(j.error)).slice(0, 70), ms };
			return { verdict: "FAIL", reason: `HTTP ${res.status}: ${text.slice(0, 60)}`, ms };
		}
		if (j.choices?.[0]) return { verdict: "SUCCESS", reason: `HTTP ${res.status}, ${ms}ms`, ms };
		if (j.base_resp) return { verdict: "FAIL", reason: `${j.base_resp.status_code} ${j.base_resp.status_msg}`, ms };
		if (j.error) return { verdict: "FAIL", reason: String(j.error.message || j.error.code || JSON.stringify(j.error)).slice(0, 70), ms };
		return { verdict: "FAIL", reason: `HTTP ${res.status}: ${text.slice(0, 60)}`, ms };
	} catch (error) {
		return { verdict: "FAIL", reason: error.name === "TimeoutError" ? "超时(25s)" : String(error).slice(0, 60), ms: Date.now() - started };
	}
}

const ok = [];
for (const [name, p] of Object.entries(providers)) {
	console.log(`\n=== ${name}（${p.api}，${p.baseURL}）===`);
	for (const model of p.models) {
		const r = await probe(name, model, p);
		const tag = r.verdict === "SUCCESS" ? "✅" : "❌";
		console.log(`${tag} ${name}/${model} → ${r.reason}`);
		if (r.verdict === "SUCCESS") ok.push({ id: `${name}/${model}`, ms: r.ms });
	}
}

console.log(`\n===== 汇总：${ok.length}/${total} 可用 =====`);
ok.sort((a, b) => a.ms - b.ms);
for (const o of ok) console.log(`✅ ${o.id}（响应 ${o.ms}ms）`);
