/**
 * dsh-auto-continue 客户端半边：会话标题栏「自动重试」开关。
 *
 * 加载：package.json 的 dsh.client 声明本文件，宿主经 window.__ModuleLoader__ 注入浏览器。
 * 状态源：插件 node 侧的本地控制端点（127.0.0.1，端口 = 配置 uiPort，默认 49765）。
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
			}, ToggleButton));
		}

		function labelOf(running) {
			return running ? "自动重试 开" : "自动重试 关";
		}

		function ToggleButton() {
			const [state, setState] = react.useState({ text: "自动重试 …", running: null, dead: false });
			react.useEffect(() => {
				let alive = true;
				fetch(`${BASE}/status`).then((r) => r.json()).then((j) => {
					if (alive && typeof j.running === "boolean") setState({ text: labelOf(j.running), running: j.running, dead: false });
				}).catch(() => {
					if (alive) setState({ text: "自动重试 不可用", running: null, dead: true });
				});
				return () => { alive = false; };
			}, []);
			const toggle = () => {
				if (state.dead) return;
				setState({ text: "自动重试 …", running: state.running, dead: false });
				fetch(`${BASE}/toggle`, { method: "POST" }).then((r) => r.json()).then((j) => {
					if (typeof j.running === "boolean") setState({ text: labelOf(j.running), running: j.running, dead: false });
				}).catch(() => {});
			};
			return react.createElement("button", {
				onClick: toggle,
				title: "dsh-auto-continue：失败后自动重试并切换模型",
				style: {
					cursor: state.dead ? "default" : "pointer",
					border: "1px solid rgba(255,255,255,0.14)",
					borderRadius: 6,
					background: "transparent",
					color: state.dead ? "#666" : state.running === false ? "#8a8f98" : "#e8eaed",
					fontSize: 12,
					padding: "3px 10px",
					lineHeight: "18px",
				},
			}, state.text);
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
