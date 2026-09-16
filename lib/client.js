/**
 * Skin manager — browser half.
 *
 * Contributes a `settings.section` page ("皮肤" / "Skins") to the DSH settings
 * dialog. The page is ONE radio list: "原版 UI" first, then one row per installed
 * skin. Clicking a row applies that choice directly, so any number of skins stays
 * a single click away. No floating overlay is rendered, so nothing can cover the
 * shell's own controls.
 *
 * Only `react` is required (the shell's seed module); the UI is built with
 * createElement and inline styles so it depends on no component library.
 */
window.__ModuleLoader__.load({
	id: "@dsh-external/dsh-client-ui-skin-manager",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const h = React.createElement;

		const STATE_URL = "/api/dsh-skin-manager/state";
		const PREVIEW_URL = "/api/dsh-skin-manager/preview";
		const POLL_INTERVAL_MS = 300;
		const POLL_TIMEOUT_MS = 8000;
		const RELOAD_DELAY_MS = 350;
		const REFRESH_INTERVAL_MS = 5000;
		const NS = "skin-manager";
		const STOCK_ID = "__stock__";

		const zh = {
			nav: "皮肤",
			heading: "皮肤",
			intro: "在下面选择要使用的界面外观，点哪一项就用哪一项。切换后页面会自动刷新一次。",
			stock: "原版 UI",
			stockHint: "不使用任何皮肤，保持 DSH 原始外观",
			inUse: "使用中",
			pending: "待生效",
			unwired: "未接入",
			empty: "未发现皮肤包：profile 的 node_modules 里没有带 skin.json 的包。",
			applying: "正在应用…",
			reloading: "已生效，正在刷新页面…",
			timeout: "设置已写入配置，但运行中的 DSH 尚未切换；请重启 DSH 后再试。",
			readFailed: "读取皮肤状态失败：",
			applyFailed: "应用失败：",
			hostMounted: "宿主插件已挂载",
			hostMissing: "宿主插件未挂载（需重启 DSH）",
			refreshNote: "皮肤切换通过插件启停实现，页面会刷新一次以加载或卸载皮肤。"
		};
		const en = {
			nav: "Skins",
			heading: "Skins",
			intro: "Pick the interface below — clicking a row uses that choice. Switching reloads the page once.",
			stock: "Stock UI",
			stockHint: "No skin: the original DSH appearance",
			inUse: "Active",
			pending: "Pending",
			unwired: "Not wired",
			empty: "No skin packages found: no package with a skin.json in this profile's node_modules.",
			applying: "Applying…",
			reloading: "Applied — reloading the page…",
			timeout: "Saved to the profile, but the running DSH has not switched yet; restart DSH and try again.",
			readFailed: "Failed to read the skin state: ",
			applyFailed: "Failed to apply: ",
			hostMounted: "Host plugin mounted at",
			hostMissing: "Host plugin not mounted (restart DSH)",
			refreshNote: "Switching a skin toggles its plugin, so the page reloads once to load or unload it."
		};

		const CSS = `
.dsh-sm-root{display:flex;flex-direction:column;gap:16px;padding:2px 0 8px}
.dsh-sm-h{font-size:15px;font-weight:600;margin:0}
.dsh-sm-intro{font-size:12.5px;opacity:.68;margin:6px 0 0;line-height:1.6}
.dsh-sm-list{display:flex;flex-direction:column;gap:10px}
.dsh-sm-card{display:flex;gap:12px;align-items:center;padding:10px;border-radius:11px;border:1px solid rgba(127,127,127,.3);background:rgba(127,127,127,.07);cursor:pointer;text-align:left;color:inherit;font:inherit}
.dsh-sm-card:hover{border-color:rgba(155,107,216,.75)}
.dsh-sm-card[data-on="1"]{border-color:rgba(155,107,216,.95);background:rgba(155,107,216,.16)}
.dsh-sm-card:disabled{opacity:.6;cursor:default}
.dsh-sm-radio{width:15px;height:15px;flex:0 0 auto;border-radius:50%;border:1.5px solid rgba(127,127,127,.8);position:relative}
.dsh-sm-radio[data-on="1"]{border-color:rgba(155,107,216,.95)}
.dsh-sm-radio[data-on="1"]::after{content:"";position:absolute;inset:2.5px;border-radius:50%;background:rgba(155,107,216,.95)}
.dsh-sm-thumb{width:96px;height:58px;flex:0 0 auto;border-radius:8px;object-fit:cover;background:rgba(127,127,127,.22)}
.dsh-sm-stock{width:96px;height:58px;flex:0 0 auto;border-radius:8px;border:1px dashed rgba(127,127,127,.45);display:flex;align-items:center;justify-content:center;font-size:11px;opacity:.6}
.dsh-sm-name{font-weight:600;font-size:13.5px}
.dsh-sm-sub{font-size:12px;opacity:.7;margin-top:3px}
.dsh-sm-badge{display:inline-block;margin-left:8px;padding:1px 7px;border-radius:999px;font-size:11px;font-weight:500;background:rgba(127,127,127,.28)}
.dsh-sm-badge[data-kind="on"]{background:rgba(110,200,140,.28)}
.dsh-sm-status{font-size:12.5px;margin:0;white-space:pre-wrap}
.dsh-sm-status[data-kind="error"]{color:#e0736f}
.dsh-sm-status[data-kind="ok"]{color:#4fae74}
.dsh-sm-foot{font-size:11.5px;opacity:.55;margin:0;line-height:1.6;white-space:pre-wrap}
`;

		async function readState() {
			const response = await fetch(STATE_URL, { cache: "no-store", headers: { accept: "application/json" } });
			const payload = await response.json().catch(() => null);
			if (!response.ok || !payload || payload.ok !== true) throw new Error((payload && payload.message) || `HTTP ${response.status}`);
			return payload;
		}

		async function writeState(body) {
			const response = await fetch(STATE_URL, {
				method: "PUT",
				headers: { accept: "application/json", "content-type": "application/json" },
				body: JSON.stringify(body)
			});
			const payload = await response.json().catch(() => null);
			if (!response.ok || !payload || payload.ok !== true) throw new Error((payload && payload.message) || `HTTP ${response.status}`);
			return payload;
		}

		const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

		/** Poll the host until the loader reports the requested selection as effective. */
		async function waitForEffect(target, deadline) {
			while (Date.now() < deadline) {
				const data = await readState();
				if (data.effectiveId === target) return data;
				await sleep(POLL_INTERVAL_MS);
			}
			return null;
		}

		function formatClock(value) {
			try {
				return new Date(value).toLocaleTimeString();
			} catch {
				return value;
			}
		}

		/**
		 * The settings page. One radio list of every choice: the stock UI first,
		 * then one row per discovered skin.
		 * Registered into `settings.section` by {@link apply}.
		 */
		function SkinSection() {
			const [data, setData] = React.useState(null);
			const [busy, setBusy] = React.useState(false);
			const [status, setStatus] = React.useState("");
			const [statusKind, setStatusKind] = React.useState("");
			const [error, setError] = React.useState("");

			React.useEffect(() => {
				let cancelled = false;
				const load = async () => {
					try {
						const next = await readState();
						if (cancelled) return;
						setData(next);
						setError("");
					} catch (cause) {
						if (!cancelled) setError(String((cause && cause.message) || cause));
					}
				};
				load();
				const timer = setInterval(load, REFRESH_INTERVAL_MS);
				return () => {
					cancelled = true;
					clearInterval(timer);
				};
			}, []);

			const applySelection = async (mode, skinId) => {
				if (busy) return;
				setBusy(true);
				setStatusKind("");
				setStatus(zh.applying);
				try {
					const next = await writeState({ mode, skin: skinId });
					setData(next);
					const settled = next.effectiveId === next.activeId ? next : await waitForEffect(next.activeId, Date.now() + POLL_TIMEOUT_MS);
					if (settled !== null) {
						setStatusKind("ok");
						setStatus(zh.reloading);
						setTimeout(() => location.reload(), RELOAD_DELAY_MS);
						return;
					}
					setStatusKind("error");
					setStatus(zh.timeout);
				} catch (cause) {
					setStatusKind("error");
					setStatus(zh.applyFailed + String((cause && cause.message) || cause));
				} finally {
					setBusy(false);
				}
			};

			const skins = data && Array.isArray(data.skins) ? data.skins : [];
			const vanilla = data !== null && data.mode === "vanilla";
			const radio = (on) => h("span", { className: "dsh-sm-radio", "data-on": on ? "1" : undefined, key: "radio" });
			const meta = (name, hint, badge, badgeKind) =>
				h("div", { style: { minWidth: 0 }, key: "meta" }, [
					h("div", { className: "dsh-sm-name", key: "name" }, [name, badge === null ? null : h("span", { className: "dsh-sm-badge", "data-kind": badgeKind, key: "badge" }, badge)]),
					h("div", { className: "dsh-sm-sub", key: "hint" }, hint)
				]);

			/** One selectable row; the same structure for the stock UI and every skin. */
			const row = (key, on, apply, children) =>
				h(
					"button",
					{
						key,
						className: "dsh-sm-card",
						type: "button",
						disabled: busy,
						"data-on": on ? "1" : undefined,
						"aria-pressed": on ? "true" : "false",
						onClick: apply
					},
					children
				);

			const rows = [
				row(STOCK_ID, vanilla, () => applySelection("vanilla", null), [
					radio(vanilla),
					h("span", { className: "dsh-sm-stock", key: "mark" }, zh.stock),
					meta(zh.stock, zh.stockHint, vanilla ? zh.inUse : null, "on")
				])
			];

			for (const skin of skins) {
				const active = data.mode === "skin" && data.activeId === skin.id;
				const badge = skin.enabled ? zh.inUse : active ? zh.pending : !skin.wired ? zh.unwired : null;
				const children = [radio(active)];
				if (skin.hasPreview) {
					children.push(
						h("img", {
							key: "thumb",
							className: "dsh-sm-thumb",
							alt: "",
							loading: "lazy",
							src: `${PREVIEW_URL}?skin=${encodeURIComponent(skin.id)}&theme=dark`,
							onError: (event) => {
								if (event && event.target) event.target.style.display = "none";
							}
						})
					);
				}
				children.push(meta(skin.name, [skin.author, skin.tagline].filter(Boolean).join(" · ") || skin.package, badge, skin.enabled ? "on" : undefined));
				rows.push(row(skin.id, active, () => applySelection("skin", skin.id), children));
			}

			const children = [
				h("style", { key: "style" }, CSS),
				h("div", { key: "head" }, [h("h2", { className: "dsh-sm-h", key: "h" }, zh.heading), h("p", { className: "dsh-sm-intro", key: "p" }, zh.intro)]),
				h("div", { className: "dsh-sm-list", key: "list" }, rows)
			];

			if (skins.length === 0) children.push(h("p", { className: "dsh-sm-intro", key: "empty" }, zh.empty));
			if (error) children.push(h("p", { className: "dsh-sm-status", "data-kind": "error", key: "err" }, zh.readFailed + error));
			else if (status) children.push(h("p", { className: "dsh-sm-status", "data-kind": statusKind || undefined, key: "status" }, status));
			if (data) {
				children.push(
					h("p", { className: "dsh-sm-foot", key: "foot" }, `${zh.refreshNote}\n${data.hostMountedAt ? `${zh.hostMounted} ${formatClock(data.hostMountedAt)}` : zh.hostMissing}`)
				);
			}

			return h("div", { className: "dsh-sm-root" }, children);
		}

		const inject = ["slots", "locale"];

		/**
		 * Register the skin page once the settings shell declares `settings.section`.
		 * @param ctx - client cordis context.
		 */
		function apply(ctx) {
			let label = () => zh.nav;
			try {
				ctx.effect(() => ctx.locale.register(NS, { zh, en }), "skin-manager: dictionaries");
				const t = ctx.locale.bind(NS);
				label = () => t("nav");
			} catch (cause) {
				console.error("[skin-manager] locale wiring failed; using a static label", cause);
			}
			try {
				ctx.slots.inject("settings.section", () =>
					ctx.slots.register(
						{
							name: "settings.section",
							id: "skin-manager",
							order: 30,
							label
						},
						SkinSection
					)
				);
			} catch (cause) {
				console.error("[skin-manager] registering the settings section failed", cause);
			}
		}

		exports.SkinSection = SkinSection;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
