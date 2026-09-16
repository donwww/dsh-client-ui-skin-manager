/**
 * Offline tests for the skin manager's HTTP surface and runtime toggling.
 *
 * Mounts the real plugin against a fake context (including a fake Cordis loader
 * with `entry.update` / `loader.create`) and fake `req`/`res` objects, so every
 * route the browser panel calls is exercised without a running harness.
 * `DSH_HOME` points at a throwaway home created under the OS temp directory.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

import { apply } from "../lib/index.js";

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

/** Build a fake harness home with two skin packages in the web profile. */
function fakeHome() {
	const home = mkdtempSync(join(tmpdir(), "dsh-skin-manager-home-"));
	const profile = join(home, "profiles", "web");
	const writeSkin = (packageName, skin) => {
		const dir = join(profile, "node_modules", ...packageName.split("/"));
		mkdirSync(join(dir, "preview"), { recursive: true });
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: packageName, version: "0.0.6" }));
		writeFileSync(join(dir, "skin.json"), JSON.stringify(skin));
		writeFileSync(join(dir, "preview", "light.webp"), Buffer.from("RIFF0000WEBP"));
		return dir;
	};
	writeSkin("@dsh-external/dsh-client-ui-skin-sample", {
		id: "sample",
		name: "Sample skin",
		author: "sample-author",
		tagline: "sample tagline",
		package: "@dsh-external/dsh-client-ui-skin-sample",
		wiring: { id: "ui-skin-sample" },
		preview: { light: "preview/light.webp" }
	});
	// installed while the harness runs: no loader entry exists for it yet
	writeSkin("dsh-client-ui-skin-second", { id: "second", name: "Second skin", package: "dsh-client-ui-skin-second" });
	writeFileSync(join(profile, "cordis.patch.yml"), "# profile patch layer (left to the user and to other installers)\n[]\n");
	return { home, profile };
}

function fakeRequest({ method = "GET", url = "/", body = undefined, address = "127.0.0.1" }) {
	const listeners = new Map();
	return {
		method,
		url,
		socket: { remoteAddress: address },
		on(event, handler) {
			listeners.set(event, handler);
			return this;
		},
		destroy() {},
		async start() {
			const data = listeners.get("data");
			const end = listeners.get("end");
			if (body !== undefined && data) data(Buffer.from(body, "utf8"));
			if (end) end();
		}
	};
}

function fakeResponse() {
	let settle;
	const ended = new Promise((resolve) => {
		settle = resolve;
	});
	return {
		status: 0,
		headers: undefined,
		body: undefined,
		ended,
		writeHead(status, headers) {
			this.status = status;
			this.headers = headers;
		},
		end(body) {
			this.body = body;
			settle();
		}
	};
}

/** A loader stub mirroring the real entry lifecycle closely enough to test toggles. */
function fakeLoader() {
	const state = { entries: [], created: [] };
	const make = (options) => {
		const entry = {
			id: options.id ?? options.name,
			options: { ...options },
			disabled: options.disabled === true,
			fiber: { state: options.disabled === true ? 4 : 2 },
			/** Mirror the loader: flip the option and (re)create or drop the fiber. */
			async update(next) {
				Object.assign(this.options, next);
				this.disabled = this.options.disabled === true;
				this.fiber = this.disabled ? { state: 4 } : { state: 2 };
			}
		};
		state.entries.push(entry);
		return entry;
	};
	return {
		state,
		make,
		entries: () => state.entries,
		resolve: (id) => state.entries.find((entry) => entry.id === id),
		/** Drop every entry for one package (simulates another layer replacing the manager's row). */
		remove: (packageName) => {
			state.entries = state.entries.filter((entry) => entry.options.name !== packageName);
		},
		create: async (options) => {
			const entry = make({ ...options, disabled: false });
			state.created.push(entry.id);
			return entry.id;
		}
	};
}

const { home, profile } = fakeHome();
process.env.DSH_HOME = home;
delete process.env.DSH_DESKTOP_PROFILE;

const routes = new Map();
const loader = fakeLoader();
// The composed tree already mounted what the managed block wires: the manager
// drives those entries, it never creates them itself.
loader.make({ id: "ui-skin-sample", name: "@dsh-external/dsh-client-ui-skin-sample", disabled: false });
loader.make({ id: "ui-skin-second", name: "dsh-client-ui-skin-second", disabled: true });
const ctx = {
	effect(fn) {
		fn();
		return () => {};
	},
	get(service) {
		return service === "loader" ? loader : undefined;
	},
	webServer: {
		register(route) {
			if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`);
			routes.set(route.path, route.handler);
			return () => routes.delete(route.path);
		}
	}
};
apply(ctx);
await new Promise((resolve) => setTimeout(resolve, 10));

const STATE = "/api/dsh-skin-manager/state";
const PREVIEW = "/api/dsh-skin-manager/preview";

async function call(pathAndQuery, options = {}) {
	const handler = routes.get(pathAndQuery.split("?")[0]);
	assert.ok(handler, `route ${pathAndQuery.split("?")[0]} registered`);
	const req = fakeRequest({ url: pathAndQuery, ...options });
	const res = fakeResponse();
	handler(req, res);
	await req.start();
	await res.ended;
	return res;
}

/** The manager writes the HOME layer; the profile layer stays untouched. */
const patchText = () => readFileSync(join(home, "cordis.patch.yml"), "utf8");
const profilePatchText = () => readFileSync(join(profile, "cordis.patch.yml"), "utf8");
const entryFor = (packageName) => loader.state.entries.find((entry) => entry.options.name === packageName);

console.log("mount");
await check("registers both exact routes", () => {
	assert.deepEqual([...routes.keys()].sort(), [PREVIEW, STATE].sort());
});

await check("writes a host-mount marker and wires discovered skins into the HOME layer", () => {
	const marker = JSON.parse(readFileSync(join(profile, "data", "dsh-client-ui-skin-manager", "host-mount.json"), "utf8"));
	assert.equal(typeof marker.mountedAt, "string");
	const patch = patchText();
	assert.ok(patch.includes("- id: ui-skin-sample") && patch.includes("- id: ui-skin-second"));
	assert.ok(patch.includes("name: 'dsh-client-ui-skin-second'"));
	assert.equal(profilePatchText(), "# profile patch layer (left to the user and to other installers)\n[]\n", "the profile layer is left alone");
});

console.log("state route");
await check("GET reports both skins and the default selection", async () => {
	const res = await call(STATE);
	assert.equal(res.status, 200);
	const payload = JSON.parse(res.body);
	assert.deepEqual(
		payload.skins.map((skin) => skin.id),
		["sample", "second"]
	);
	assert.equal(payload.activeId, "sample");
	assert.equal(payload.effectiveId, "sample", "the composed tree already mounted what the block wires");
	assert.equal(payload.skins.find((skin) => skin.id === "sample").enabled, true);
	assert.equal(payload.skins.find((skin) => skin.id === "second").wired, true);
	assert.equal(payload.skins.find((skin) => skin.id === "second").enabled, false, "the inactive skin is held disabled");
});

await check("PUT keeps the selected skin enabled and persists the choice", async () => {
	const res = await call(STATE, { method: "PUT", body: JSON.stringify({ mode: "skin", skin: "sample" }) });
	assert.equal(res.status, 200);
	const payload = JSON.parse(res.body);
	assert.equal(payload.activeId, "sample");
	assert.equal(payload.effectiveId, "sample");
	assert.equal(entryFor("@dsh-external/dsh-client-ui-skin-sample").disabled, false);
	assert.equal(entryFor("dsh-client-ui-skin-second").disabled, true);
	assert.deepEqual(JSON.parse(readFileSync(join(profile, "data", "dsh-client-ui-skin-manager", "settings.json"), "utf8")), { mode: "skin", skin: "sample" });
	assert.ok(patchText().includes("- id: ui-skin-sample\n  disabled: false"));
	assert.ok(patchText().includes("- id: ui-skin-second\n  disabled: true"));
});

await check("PUT vanilla disables the active skin at runtime", async () => {
	const res = await call(STATE, { method: "PUT", body: JSON.stringify({ mode: "vanilla" }) });
	const payload = JSON.parse(res.body);
	assert.equal(payload.activeId, null);
	assert.equal(payload.effectiveId, null);
	assert.deepEqual(payload.runtime.toggled, ["ui-skin-sample"]);
	assert.equal(entryFor("@dsh-external/dsh-client-ui-skin-sample").disabled, true);
	assert.equal(entryFor("@dsh-external/dsh-client-ui-skin-sample").fiber.state, 4);
	assert.ok(patchText().includes("- id: ui-skin-sample\n  disabled: true"));
});

await check("switching to the other wired skin toggles both", async () => {
	const res = await call(STATE, { method: "PUT", body: JSON.stringify({ mode: "skin", skin: "second" }) });
	const payload = JSON.parse(res.body);
	assert.equal(payload.activeId, "second");
	assert.equal(payload.effectiveId, "second");
	assert.equal(entryFor("dsh-client-ui-skin-second").disabled, false);
	assert.equal(entryFor("@dsh-external/dsh-client-ui-skin-sample").disabled, true);
	assert.deepEqual(payload.runtime.toggled, ["ui-skin-second"], "sample was already disabled by the previous step");
});

await check("a skin with no mounted entry is reported unmounted, never double-inserted", async () => {
	// the manager's block wires it, but the running tree has not reloaded yet
	loader.remove("dsh-client-ui-skin-second");
	const res = await call(STATE, { method: "PUT", body: JSON.stringify({ mode: "skin", skin: "second" }) });
	const payload = JSON.parse(res.body);
	assert.equal(payload.activeId, "second");
	assert.equal(payload.effectiveId, null, "nothing was mounted behind the user's back");
	assert.deepEqual(payload.runtime.unmounted, ["second"]);
	assert.equal(loader.resolve("ui-skin-second"), undefined, "no second entry is created");
	assert.equal(entryFor("@dsh-external/dsh-client-ui-skin-sample").disabled, true, "the rest is still driven");
	assert.ok(patchText().includes("- id: ui-skin-second\n  disabled: false"), "the choice is persisted for the next load");
	// put the fixture back for the following checks
	loader.make({ id: "ui-skin-second", name: "dsh-client-ui-skin-second", disabled: false });
});

await check("GET reports the live effective state and drift", async () => {
	const res = await call(STATE);
	const payload = JSON.parse(res.body);
	assert.equal(payload.activeId, "second");
	assert.equal(payload.effectiveId, "second");
	const second = payload.skins.find((skin) => skin.id === "second");
	assert.equal(second.wired, true);
	assert.equal(second.enabled, true);
	assert.equal(second.phase, "active");
	const sample = payload.skins.find((skin) => skin.id === "sample");
	assert.equal(sample.enabled, false);
	assert.equal(sample.phase, null);
});

await check("adopts a skin that another agent wired, and still controls it", async () => {
	// the other layer's row, exactly as a skin README tells a third-party agent to add it
	writeFileSync(join(profile, "cordis.patch.yml"), "# profile patch layer (left to the user and to other installers)\n- insert:\n    - id: some-ai-row\n      name: '@dsh-external/dsh-client-ui-skin-sample'\n");
	// that row is what the loader mounted; the manager's own insert for sample is gone
	loader.remove("@dsh-external/dsh-client-ui-skin-sample");
	loader.make({ id: "some-ai-row", name: "@dsh-external/dsh-client-ui-skin-sample", disabled: false });
	const res = await call(STATE, { method: "PUT", body: JSON.stringify({ mode: "skin", skin: "sample" }) });
	const payload = JSON.parse(res.body);
	assert.equal(payload.activeId, "sample");
	assert.equal(payload.effectiveId, "sample");
	const patch = patchText();
	assert.ok(!patch.includes("name: '@dsh-external/dsh-client-ui-skin-sample'"), `the duplicate insert must be dropped:\n${patch}`);
	assert.ok(patch.includes("- id: some-ai-row\n  disabled: false"), `the override must target the existing row:\n${patch}`);
	assert.equal(loader.resolve("some-ai-row").disabled, false, "the adopted row is the one the manager drives");
});

await check("PUT rejects an unknown skin id by falling back to the first skin", async () => {
	const res = await call(STATE, { method: "PUT", body: JSON.stringify({ mode: "skin", skin: "does-not-exist" }) });
	const payload = JSON.parse(res.body);
	assert.equal(payload.skin, "sample");
	assert.equal(payload.activeId, "sample");
});

await check("PUT with a malformed body answers 400", async () => {
	const res = await call(STATE, { method: "PUT", body: "{not json" });
	assert.equal(res.status, 400);
	assert.equal(JSON.parse(res.body).ok, false);
});

await check("GET from a non-loopback peer answers 403", async () => {
	const res = await call(STATE, { address: "10.0.0.7" });
	assert.equal(res.status, 403);
});

console.log("preview route");
await check("serves the skin preview bytes", async () => {
	const res = await call(`${PREVIEW}?skin=sample&theme=light`);
	assert.equal(res.status, 200);
	assert.equal(res.headers["content-type"], "image/webp");
	assert.equal(Buffer.from(res.body).toString("utf8"), "RIFF0000WEBP");
});

await check("answers 404 for an unknown skin", async () => {
	const res = await call(`${PREVIEW}?skin=nope`);
	assert.equal(res.status, 404);
});

await check("preview is loopback-only", async () => {
	const res = await call(`${PREVIEW}?skin=sample`, { address: "192.168.1.20" });
	assert.equal(res.status, 403);
});

rmSync(home, { recursive: true, force: true });
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
