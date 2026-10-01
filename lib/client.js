/**
 * dsh-auto-continue 客户端半边：会话标题栏「自动重试」开关 + 设置弹层。
 *
 * 加载：package.json 的 dsh.client 声明本文件，宿主经 window.__ModuleLoader__ 注入浏览器。
 * 状态源：插件 node 侧的本地控制端点（127.0.0.1，端口 = 配置 uiPort，默认 49765）。
 *   GET  /status  → { running }
 *   POST /toggle  → { running }
 *   GET  /config  → { retriesPerModel, retryBackoffMinMs, retryBackoffMaxMs, continueMax }
 *   POST /config  → 同上（修改并持久化到 ~/.dsh/auto-continue/settings.json）
 * 端点不可达时按钮显示"不可用"，不影响插件本体与 /autocont 指令。
 */
window.__ModuleLoader__.load({
	id: "dsh-auto-continue",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const react = require("react");

		const PORT = 49765; // 与 node 侧 uiPort 默认值保持一致
		const BASE = `http://127.0.0.1:${PORT}`;

		const inject = ["slots"];

		function apply(ctx) {
			ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
				name: "conversation.session.header.actions",
				id: "auto-continue-toggle",
				order: 30,
				inject: () => ({}),
			}, HeaderControls));
		}

		function labelOf(running) {
			return running ? "自动重试 开" : "自动重试 关";
		}

		const btnStyle = {
			cursor: "pointer",
			border: "1px solid rgba(255,255,255,0.14)",
			borderRadius: 6,
			background: "transparent",
			color: "#e8eaed",
			fontSize: 12,
			padding: "3px 10px",
			lineHeight: "18px",
		};

		function HeaderControls() {
			const [running, setRunning] = react.useState(null);
			const [dead, setDead] = react.useState(false);
			const [panelOpen, setPanelOpen] = react.useState(false);

			react.useEffect(() => {
				let alive = true;
				fetch(`${BASE}/status`).then((r) => r.json()).then((j) => {
					if (alive && typeof j.running === "boolean") setRunning(j.running);
				}).catch(() => { if (alive) setDead(true); });
				return () => { alive = false; };
			}, []);

			const toggle = () => {
				if (dead) return;
				fetch(`${BASE}/toggle`, { method: "POST" }).then((r) => r.json()).then((j) => {
					if (typeof j.running === "boolean") setRunning(j.running);
				}).catch(() => {});
			};

			return react.createElement("div", { style: { position: "relative", display: "inline-flex", alignItems: "center", gap: 4 } },
				react.createElement("button", {
					onClick: toggle,
					title: "dsh-auto-continue：失败后自动重试并切换模型",
					style: { ...btnStyle, cursor: dead ? "default" : "pointer", color: dead ? "#666" : running === false ? "#8a8f98" : "#e8eaed" },
				}, dead ? "自动重试 不可用" : labelOf(running)),
				react.createElement("button", {
					onClick: () => setPanelOpen((v) => !v),
					title: "重试设置",
					style: { ...btnStyle, padding: "3px 7px" },
				}, "⚙"),
				panelOpen && react.createElement(SettingsPanel, { onClose: () => setPanelOpen(false) }),
			);
		}

		function SettingsPanel({ onClose }) {
			const [cfg, setCfg] = react.useState(null);
			const [hint, setHint] = react.useState("");
			react.useEffect(() => {
				let alive = true;
				fetch(`${BASE}/config`).then((r) => r.json()).then((j) => {
					if (alive) setCfg({
						retriesPerModel: j.retriesPerModel,
						minSec: Math.round((j.retryBackoffMinMs || 0) / 1000),
						maxSec: Math.round((j.retryBackoffMaxMs || 0) / 1000),
					});
				}).catch(() => { if (alive) setHint("读取失败"); });
				return () => { alive = false; };
			}, []);
			const field = (label, key, min, max) => react.createElement("label", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, margin: "6px 0" } },
				react.createElement("span", { style: { color: "#9aa0a6", fontSize: 12 } }, label),
				react.createElement("input", {
					type: "number", min, max, value: cfg[key] ?? "",
					onChange: (e) => setCfg({ ...cfg, [key]: e.target.value === "" ? "" : Number(e.target.value) }),
					style: { width: 76, background: "#1b1d21", color: "#e8eaed", border: "1px solid rgba(255,255,255,0.16)", borderRadius: 4, padding: "3px 6px", fontSize: 12 },
				}),
			);
			const save = () => {
				const body = {
					retriesPerModel: Number(cfg.retriesPerModel) || 0,
					retryBackoffMinMs: Math.max(0, Number(cfg.minSec) || 0) * 1000,
					retryBackoffMaxMs: Math.max(0, Number(cfg.maxSec) || 0) * 1000,
				};
				fetch(`${BASE}/config`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
					.then((r) => r.json())
					.then((j) => {
						setCfg({ retriesPerModel: j.retriesPerModel, minSec: Math.round(j.retryBackoffMinMs / 1000), maxSec: Math.round(j.retryBackoffMaxMs / 1000) });
						setHint("已保存 ✓");
						setTimeout(() => setHint(""), 1800);
					})
					.catch(() => setHint("保存失败"));
			};
			const panelStyle = {
				position: "absolute", top: "calc(100% + 8px)", right: 0, zIndex: 9999,
				width: 240, padding: "12px 14px", borderRadius: 10,
				background: "#16181c", border: "1px solid rgba(255,255,255,0.14)",
				boxShadow: "0 8px 28px rgba(0,0,0,0.55)",
			};
			return react.createElement("div", { style: panelStyle, onClick: (e) => e.stopPropagation() },
				react.createElement("div", { style: { color: "#e8eaed", fontSize: 13, fontWeight: 600, marginBottom: 4 } }, "自动重试设置"),
				cfg === null
					? react.createElement("div", { style: { color: "#9aa0a6", fontSize: 12, padding: "10px 0" } }, hint || "读取中…")
					: react.createElement("div", null,
						field("每模型重试次数", "retriesPerModel", 0, 10),
						field("间隔下限（秒）", "minSec", 0, 600),
						field("间隔上限（秒）", "maxSec", 0, 600),
						react.createElement("div", { style: { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 10, alignItems: "center" } },
							react.createElement("span", { style: { color: "#7dd87d", fontSize: 12, marginRight: "auto" } }, hint),
							react.createElement("button", { onClick: onClose, style: { ...btnStyle, color: "#9aa0a6" } }, "关闭"),
							react.createElement("button", { onClick: save, style: { ...btnStyle, background: "#2f6fed", borderColor: "#2f6fed", color: "#fff" } }, "保存"),
						),
					),
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
