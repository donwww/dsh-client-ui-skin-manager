/**
 * Browser-half tests for the skin manager.
 *
 * Loads the client bundle with a stub module loader and a minimal React
 * implementation (createElement/useState/useEffect), then verifies the settings
 * registration and actually renders the section component: the single radio
 * list (stock UI + every installed skin), the state badges, and the click path
 * that applies a selection directly from the list.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let failures = 0;
async function check(label, fn) {
	try {
		await fn();
		console.log(`  ok   ${label}`);
	} catch (error) {
		failures += 1;
		console.log(`  FAIL ${label}\n       ${error.message}`);
	}
}

// ------------------------------------------------------------- module loader stub

let registration;
globalThis.window = { __ModuleLoader__: { load: (value) => (registration = value) } };

const here = dirname(fileURLToPath(import.meta.url));
await import(`file://${join(here, "..", "lib", "client.js").replaceAll("\\", "/")}`);

// -------------------------------------------------------------------- mini React

const cleanups = [];
function createReact() {
	const state = [];
	let cursor = 0;
	let dirty = false;
	const effects = [];
	return {
		dirty: () => dirty,
		resetDirty: () => {
			dirty = false;
		},
		begin: () => {
			cursor = 0;
			effects.length = 0;
		},
		pending: () => [...effects],
		api: {
			createElement(type, props, ...children) {
				return { type, props: { ...(props || {}), children: children.flat(Infinity).filter((child) => child !== undefined && child !== null && child !== false) } };
			},
			useState(initial) {
				const index = cursor++;
				if (!(index in state)) state[index] = typeof initial === "function" ? initial() : initial;
				const set = (value) => {
					state[index] = typeof value === "function" ? value(state[index]) : value;
					dirty = true;
				};
				return [state[index], set];
			},
			useEffect(fn) {
				effects.push(fn);
			}
		}
	};
}

/** Render a component until it stops scheduling state updates. */
async function render(Runtime, Component, props, passes = 25) {
	let tree;
	for (let pass = 0; pass < passes; pass += 1) {
		Runtime.begin();
		Runtime.resetDirty();
		tree = Component(props);
		for (const effect of Runtime.pending()) {
			const cleanup = effect();
			if (typeof cleanup === "function") cleanups.push(cleanup);
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
		if (!Runtime.dirty()) return tree;
	}
	return tree;
}

/** Collect every string rendered in an element tree. */
function text(node) {
	if (node === null || node === undefined || node === false) return "";
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(text).join(" ");
	const children = node && node.props ? node.props.children : undefined;
	return text(children);
}

/** Depth-first search over the element tree. */
function find(node, predicate) {
	if (!node || typeof node !== "object") return undefined;
	if (!Array.isArray(node) && predicate(node)) return node;
	const children = node.props ? node.props.children : undefined;
	const list = Array.isArray(children) ? children : children === undefined ? [] : [children];
	for (const child of list) {
		const hit = find(child, predicate);
		if (hit) return hit;
	}
	return undefined;
}

/** Every matching node, in tree order. */
function findAll(node, predicate, out = []) {
	if (!node || typeof node !== "object") return out;
	if (!Array.isArray(node) && predicate(node)) out.push(node);
	const children = node.props ? node.props.children : undefined;
	const list = Array.isArray(children) ? children : children === undefined ? [] : [children];
	for (const child of list) findAll(child, predicate, out);
	return out;
}

const isRow = (node) => node.props !== undefined && node.props.className === "dsh-sm-card";
const rowByText = (tree, needle) => findAll(tree, isRow).find((node) => text(node).includes(needle));
const radioOf = (row) => find(row, (node) => node.props !== undefined && node.props.className === "dsh-sm-radio");

// --------------------------------------------------------------------- test data

const statePayload = {
	ok: true,
	profile: "web",
	mode: "skin",
	skin: "sample",
	activeId: "sample",
	effectiveId: "sample",
	hostMountedAt: "2026-09-16T10:00:00.000Z",
	skins: [
		{
			id: "sample",
			name: "Sample skin",
			author: "sample-author",
			tagline: "sample tagline",
			package: "@dsh-external/dsh-client-ui-skin-sample",
			entryId: "ui-skin-sample",
			wired: true,
			enabled: true,
			phase: "active",
			hasPreview: true
		},
		{
			id: "second",
			name: "Second skin",
			author: "linxin",
			tagline: "sample tagline",
			package: "@dsh-external/dsh-client-ui-skin-second",
			entryId: "ui-skin-second",
			wired: true,
			enabled: false,
			phase: null,
			hasPreview: true
		}
	]
};

const calls = [];
globalThis.fetch = async (url, init = {}) => {
	calls.push({ url, method: init.method || "GET", body: init.body });
	return { ok: true, status: 200, json: async () => statePayload };
};
globalThis.location = { reload: () => calls.push({ url: "reload", method: "RELOAD" }) };

// ---------------------------------------------------------------------- the tests

console.log("registration");
const runtime = createReact();
const clientExports = registration.factory((id) => {
	if (id === "react") return runtime.api;
	throw new Error(`unexpected client module require: ${id}`);
});

await check("registers under its package id", () => {
	assert.equal(registration.id, "@dsh-external/dsh-client-ui-skin-manager");
});

await check("injects the slots and locale services", () => {
	assert.deepEqual(clientExports.inject, ["slots", "locale"]);
});

let captured = null;
let injectedSlot = null;
const clientCtx = {
	effect(fn) {
		fn();
		return () => {};
	},
	locale: {
		register: () => {},
		bind: () => (key) => ({ nav: "皮肤" })[key] ?? key
	},
	slots: {
		inject(name, callback) {
			injectedSlot = name;
			callback();
		},
		register(options, component) {
			captured = { options, component };
			return () => {};
		}
	}
};
clientExports.apply(clientCtx);

await check("contributes a settings section with a localized label", () => {
	assert.equal(injectedSlot, "settings.section");
	assert.equal(captured.options.name, "settings.section");
	assert.equal(captured.options.id, "skin-manager");
	assert.equal(captured.options.order, 30);
	assert.equal(captured.options.label(), "皮肤");
	assert.equal(typeof captured.component, "function");
});

console.log("rendering");
const tree = await render(runtime, captured.component, { close: () => {} });
const renderedText = text(tree);

await check("renders one list: the stock entry plus every installed skin", () => {
	const rows = findAll(tree, isRow);
	assert.equal(rows.length, 3, `expected 3 rows, got ${rows.length}`);
	assert.ok(text(rows[0]).includes("原版 UI"), text(rows[0]));
	assert.ok(text(rows[0]).includes("不使用任何皮肤"), text(rows[0]));
	assert.ok(text(rows[1]).includes("Sample skin"), text(rows[1]));
	assert.ok(text(rows[2]).includes("Second skin"), text(rows[2]));
});

await check("the obsolete mode buttons are gone", () => {
	assert.equal(findAll(tree, (node) => node.props !== undefined && node.props.className === "dsh-sm-mode").length, 0);
	const source = readFileSync(join(here, "..", "lib", "client.js"), "utf8");
	assert.ok(!source.includes("dsh-sm-mode"), "mode button styles must be gone");
	assert.ok(!source.includes("dsh-sm-btn"), "the floating button must stay gone");
	assert.ok(!source.includes("position:fixed"), "no fixed-position overlay");
});

await check("marks the active row with a filled radio", () => {
	const sampleRow = rowByText(tree, "Sample skin");
	const secondRow = rowByText(tree, "Second skin");
	const stockRow = rowByText(tree, "不使用任何皮肤");
	assert.equal(sampleRow.props["data-on"], "1");
	assert.equal(radioOf(sampleRow).props["data-on"], "1");
	assert.equal(secondRow.props["data-on"], undefined);
	assert.equal(radioOf(secondRow).props["data-on"], undefined);
	assert.equal(stockRow.props["data-on"], undefined);
});

await check("shows the active badge only on the effective row", () => {
	assert.ok(text(rowByText(tree, "Sample skin")).includes("使用中"), text(rowByText(tree, "Sample skin")));
	assert.ok(!text(rowByText(tree, "Second skin")).includes("使用中"), text(rowByText(tree, "Second skin")));
	assert.ok(text(rowByText(tree, "原版 UI")).includes("不使用任何皮肤"), "stock row keeps its hint");
});

await check("renders a preview for each skin", () => {
	const images = findAll(tree, (node) => node.type === "img");
	assert.equal(images.length, 2);
	assert.ok(images.some((image) => String(image.props.src).includes("skin=sample")), JSON.stringify(images.map((image) => image.props.src)));
	assert.ok(images.some((image) => String(image.props.src).includes("skin=second")));
});

await check("reports the host mount state", () => {
	assert.ok(renderedText.includes("宿主插件已挂载"), renderedText.slice(-200));
});

console.log("switching from the list");
await check("clicking the stock row applies the stock selection and reloads", async () => {
	const stockRow = rowByText(tree, "不使用任何皮肤");
	assert.ok(stockRow.props.onClick, "stock row is clickable");
	await stockRow.props.onClick();
	const put = calls.find((call) => call.method === "PUT");
	assert.ok(put, "PUT issued");
	assert.deepEqual(JSON.parse(put.body), { mode: "vanilla", skin: null });
	await new Promise((resolve) => setTimeout(resolve, 20));
	const refreshed = await render(runtime, captured.component, { close: () => {} });
	assert.ok(text(refreshed).includes("已生效，正在刷新页面"), text(refreshed).slice(0, 200));
});

await check("clicking any skin row selects exactly that skin", async () => {
	const secondRow = rowByText(tree, "Second skin");
	await secondRow.props.onClick();
	const puts = calls.filter((call) => call.method === "PUT");
	assert.deepEqual(JSON.parse(puts[puts.length - 1].body), { mode: "skin", skin: "second" });
	const sampleRow = rowByText(tree, "Sample skin");
	await sampleRow.props.onClick();
	const after = calls.filter((call) => call.method === "PUT");
	assert.deepEqual(JSON.parse(after[after.length - 1].body), { mode: "skin", skin: "sample" });
});

for (const cleanup of cleanups) {
	try {
		cleanup();
	} catch {
		/* ignore */
	}
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
