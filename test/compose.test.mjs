/**
 * Offline tests for the skin manager's host half: discovery, the wiring plan, and
 * the generated managed block — validated against the REAL harness composer
 * (`@deepseek-ai/dsh-app-boot`) so the rows the manager writes are proven to parse
 * and compose exactly as intended, without touching a live profile.
 *
 * The headline scenario is a skin that SOMEBODY ELSE wired (the documented
 * `cordis.patch.yml` step a third-party agent follows when installing a skin): the
 * composed tree must end up with exactly one entry per skin, still controlled by
 * this manager.
 *
 * `DSH_HOME` is pointed at a throwaway directory FIRST, so every path the host half
 * derives stays inside the fixture.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

/** The real harness home, captured before the fixture below overrides DSH_HOME. */
const HARNESS_HOME = process.env.DSH_HOME || join(homedir(), ".dsh");
const HOME = mkdtempSync(join(tmpdir(), "dsh-skin-manager-home-"));
process.env.DSH_HOME = HOME;
delete process.env.DSH_DESKTOP_PROFILE;

/**
 * Resolve the harness's own `@deepseek-ai/dsh-app-boot` — the real composer these
 * tests validate the generated patch rows against. The installation's dependency
 * closure is mirrored into `<home>/profiles/node_modules`, so no machine-specific
 * path is baked in; `DSH_APP_BOOT` overrides the lookup.
 */
function resolveAppBoot() {
	if (process.env.DSH_APP_BOOT) return process.env.DSH_APP_BOOT;
	for (const anchor of [join(HARNESS_HOME, "profiles", "node_modules", "anchor.js"), join(process.cwd(), "anchor.js")]) {
		try {
			return pathToFileURL(createRequire(anchor).resolve("@deepseek-ai/dsh-app-boot")).href;
		} catch {
			/* try the next anchor */
		}
	}
	throw new Error("cannot resolve @deepseek-ai/dsh-app-boot; set DSH_HOME or DSH_APP_BOOT");
}

const { composeEntries, loadOverlayPatches } = await import(resolveAppBoot());

const { collectForeignWiring, declaredId, discoverSkins, ensurePatchArray, migrateLayers, parseBlockInserts, planWiring, readBlockText, renderManagedBlock, resolveActiveId, spliceBlock, writeManagedBlock, homePatchPath, patchPath, PROFILE_TEMPLATE } = await import("../lib/index.js");

let failures = 0;
function check(label, fn) {
	try {
		fn();
		console.log(`  ok   ${label}`);
	} catch (error) {
		failures += 1;
		console.log(`  FAIL ${label}\n       ${error.message}`);
	}
}

const PROFILE = patchPath();
const HOME_PATCH = homePatchPath();

/** `loadOverlayPatches` takes a file path: materialize one-off layer text as a file. */
function writeTemp(text) {
	const path = join(HOME, `overlay-${Math.random().toString(36).slice(2)}.yml`);
	writeFileSync(path, text, "utf8");
	return path;
}

/** Create the fixture profile with three skin packages (scoped, plain, BOM'd). */
function fakeProfile() {
	const dir = join(HOME, "profiles", "web");
	const write = (packageName, skin) => {
		const target = join(dir, "node_modules", ...packageName.split("/"));
		mkdirSync(target, { recursive: true });
		writeFileSync(join(target, "package.json"), JSON.stringify({ name: packageName, version: "1.0.0" }));
		writeFileSync(join(target, "skin.json"), JSON.stringify(skin));
	};
	write("@dsh-external/dsh-client-ui-skin-sample", {
		id: "sample",
		name: "Sample skin",
		author: "sample-author",
		tagline: "sample tagline",
		package: "@dsh-external/dsh-client-ui-skin-sample",
		wiring: { id: "ui-skin-sample" },
		preview: { light: "preview/light.webp" },
		order: 8
	});
	write("dsh-client-ui-skin-second", { id: "second", name: "Second skin", package: "dsh-client-ui-skin-second", order: 2 });
	// a manifest saved with a UTF-8 BOM (Windows editor / PowerShell) must still be read
	write("dsh-client-ui-skin-third", { id: "third", name: "Third skin", package: "dsh-client-ui-skin-third", order: 3 });
	const rinPath = join(dir, "node_modules", "dsh-client-ui-skin-third", "skin.json");
	writeFileSync(rinPath, `\uFEFF${readFileSync(rinPath, "utf8")}`);
	// a non-skin package must be ignored
	mkdirSync(join(dir, "node_modules", "@deepseek-ai", "dsh-base"), { recursive: true });
	writeFileSync(join(dir, "node_modules", "@deepseek-ai", "dsh-base", "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh-base" }));
	mkdirSync(dir, { recursive: true });
	return dir;
}

const profile = fakeProfile();
const SAMPLE = "@dsh-external/dsh-client-ui-skin-sample";
const SECOND = "dsh-client-ui-skin-second";
const THIRD = "dsh-client-ui-skin-third";
/** A row another agent wrote, exactly as a skin README tells it to. */
const foreignRow = (id, packageName, extra = "") => `- insert:\n    - id: ${id}\n      name: '${packageName}'\n${extra}`;
const writeHome = (text) => writeFileSync(HOME_PATCH, text, "utf8");
const readHome = () => readFileSync(HOME_PATCH, "utf8");
const writeProfile = (text) => writeFileSync(PROFILE, text, "utf8");
const compose = () => composeEntries([loadOverlayPatches("test", PROFILE), loadOverlayPatches("test", HOME_PATCH)]);
const skinIds = (rows) => rows.filter((row) => typeof row.id === "string" && row.id.startsWith("ui-skin-")).map((row) => row.id);
const noForeign = () => new Map();

console.log("discovery");
const skins = discoverSkins(profile);
const sample = skins.find((skin) => skin.id === "sample");
const second = skins.find((skin) => skin.id === "second");
const third = skins.find((skin) => skin.id === "third");
check("finds every skin, ordered by skin.json order", () => {
	assert.deepEqual(
		skins.map((skin) => skin.id),
		["second", "third", "sample"]
	);
});
check("a UTF-8 BOM in skin.json does not hide the skin", () => {
	assert.ok(skins.some((skin) => skin.id === "third" && skin.name === "Third skin"));
});
check("resolves entryId, package and preview", () => {
	assert.equal(sample.entryId, "ui-skin-sample");
	assert.equal(sample.package, SAMPLE);
	assert.equal(sample.previewLight, join(profile, "node_modules", "@dsh-external", "dsh-client-ui-skin-sample", "preview", "light.webp"));
});
check("active id follows the selection", () => {
	assert.equal(resolveActiveId(skins, { mode: "skin", skin: "sample" }), "sample");
	assert.equal(resolveActiveId(skins, { mode: "vanilla", skin: "sample" }), null);
	assert.equal(resolveActiveId(skins, { mode: "skin", skin: null }), "second");
});
check("loader-qualified ids are normalized to the declared id", () => {
	assert.equal(declaredId("include:ui-skin-third"), "ui-skin-third");
	assert.equal(declaredId("ui-skin-third"), "ui-skin-third");
});

console.log("wiring plan");
check("inserts every skin when nothing is wired yet", () => {
	const plan = planWiring({ skins, state: { mode: "skin", skin: "sample" }, previousBlock: "", foreign: noForeign() });
	assert.deepEqual(
		plan.map((row) => `${row.skinId}:${row.insert ? "insert" : "adopt"}`),
		["second:insert", "third:insert", "sample:insert"]
	);
	assert.deepEqual(
		plan.map((row) => row.disabled),
		[true, true, false]
	);
});
check("keeps its own insert while no other layer wires the skin", () => {
	const previousBlock = renderManagedBlock(planWiring({ skins: [sample], state: { mode: "skin", skin: "sample" }, previousBlock: "", foreign: noForeign() }));
	const plan = planWiring({ skins: [sample], state: { mode: "skin", skin: "sample" }, previousBlock, foreign: noForeign() });
	assert.equal(plan[0].insert, true);
	assert.equal(plan[0].external, false);
	assert.equal(plan[0].id, "ui-skin-sample");
});
check("adopts a foreign id instead of inserting a duplicate", () => {
	const plan = planWiring({ skins: [sample], state: { mode: "skin", skin: "sample" }, previousBlock: "", foreign: new Map([[SAMPLE, "some-ai-skin-row"]]) });
	assert.equal(plan[0].insert, false, "must not insert a second entry");
	assert.equal(plan[0].external, true);
	assert.equal(plan[0].id, "some-ai-skin-row", "the override must target the entry that exists");
});
check("adopts a foreign row that carries the manager's own id", () => {
	const previousBlock = renderManagedBlock(planWiring({ skins: [sample], state: { mode: "skin", skin: "sample" }, previousBlock: "", foreign: noForeign() }));
	const plan = planWiring({ skins: [sample], state: { mode: "skin", skin: "sample" }, previousBlock, foreign: new Map([[SAMPLE, "ui-skin-sample"]]) });
	assert.equal(plan[0].insert, false, "the foreign row already supplies the entry");
	assert.equal(plan[0].id, "ui-skin-sample");
});

console.log("managed block");
check("writes inserts plus one override per skin", () => {
	writeHome(`${renderManagedBlock(planWiring({ skins, state: { mode: "skin", skin: "sample" }, previousBlock: "", foreign: noForeign() }))}\n`);
	const text = readHome();
	assert.ok(text.includes("- id: ui-skin-second\n      name: 'dsh-client-ui-skin-second'"));
	assert.ok(text.includes("- id: ui-skin-sample\n  disabled: false"));
	assert.ok(text.includes("- id: ui-skin-second\n  disabled: true"));
});
check("parses the inserts it owns", () => {
	const owned = parseBlockInserts(readBlockText(readHome()));
	assert.equal(owned.get(SECOND), "ui-skin-second");
	assert.equal(owned.get(SAMPLE), "ui-skin-sample");
});
check("switching skins rewrites the block in place", () => {
	writeProfile("# profile layer\n");
	const block = renderManagedBlock(planWiring({ skins, state: { mode: "skin", skin: "second" }, previousBlock: readBlockText(readHome()), foreign: noForeign() }));
	writeHome(spliceBlock(readHome(), block));
	const text = readHome();
	assert.ok(text.includes("- id: ui-skin-second\n  disabled: false"));
	assert.ok(text.includes("- id: ui-skin-sample\n  disabled: true"));
	assert.equal(text.match(/dsh-skin-manager:begin/g).length, 1);
});
check("vanilla mode disables every skin", () => {
	const block = renderManagedBlock(planWiring({ skins, state: { mode: "vanilla", skin: null }, previousBlock: readBlockText(readHome()), foreign: noForeign() }));
	writeHome(spliceBlock(readHome(), block));
	for (const id of ["ui-skin-sample", "ui-skin-second", "ui-skin-third"]) assert.ok(readHome().includes(`- id: ${id}\n  disabled: true`), id);
});

console.log("a skin somebody else wired");
check("collectForeignWiring reads the other layer and ignores its own block", () => {
	writeProfile(`# profile layer\n${foreignRow("ui-skin-third", THIRD)}`);
	writeHome(`${renderManagedBlock(planWiring({ skins: [sample], state: { mode: "vanilla", skin: null }, previousBlock: "", foreign: noForeign() }))}\n`);
	const foreign = collectForeignWiring();
	assert.equal(foreign.get(THIRD), "ui-skin-third", "the other layer's row is found");
	assert.equal(foreign.get(SAMPLE), undefined, "the manager's own insert is not foreign");
});
check("writeManagedBlock adopts the foreign row and wires the rest", () => {
	writeProfile(`# profile layer\n${foreignRow("some-ai-row", SAMPLE)}`);
	writeHome(`${renderManagedBlock(planWiring({ skins: [sample, third], state: { mode: "vanilla", skin: null }, previousBlock: "", foreign: noForeign() }))}\n`);
	assert.equal(writeManagedBlock([sample, second, third], { mode: "vanilla", skin: null }), true);
	const home = readHome();
	assert.ok(!home.includes(`name: '${SAMPLE}'`), `the duplicate insert must be dropped:\n${home}`);
	assert.ok(home.includes("- id: some-ai-row\n  disabled: true"), `the override must target the existing row:\n${home}`);
	assert.ok(home.includes(`name: '${SECOND}'`), "a skin nobody wired is inserted by the manager");
	assert.ok(home.includes(`name: '${THIRD}'`), "and so is a second one");
});
check("a foreign row plus the manager block compose to one entry per skin", () => {
	writeProfile(`# profile layer\n${foreignRow("ui-skin-sample", SAMPLE)}`);
	const foreign = collectForeignWiring();
	const plan = planWiring({ skins: [sample, third], state: { mode: "skin", skin: "sample" }, previousBlock: "", foreign });
	writeHome(`${renderManagedBlock(plan)}\n`);
	const ids = skinIds(compose());
	assert.equal(new Set(ids).size, ids.length, `duplicate ids: ${JSON.stringify(ids)}`);
	assert.deepEqual(ids.sort(), ["ui-skin-sample", "ui-skin-third"]);
});
check("the home layer outranks a foreign enable row", () => {
	writeProfile(`# profile layer\n${foreignRow("ui-skin-sample", SAMPLE, "- id: ui-skin-sample\n  disabled: false\n")}`);
	const plan = planWiring({ skins: [sample], state: { mode: "vanilla", skin: null }, previousBlock: "", foreign: collectForeignWiring() });
	writeHome(`${renderManagedBlock(plan)}\n`);
	const row = compose().find((candidate) => candidate.id === "ui-skin-sample");
	assert.equal(row.disabled, true, "the manager's home-layer override must win");
});
check("switching back to a foreign-wired skin enables only it", () => {
	writeProfile(`# profile layer\n${foreignRow("ui-skin-sample", SAMPLE)}`);
	const plan = planWiring({ skins, state: { mode: "skin", skin: "sample" }, previousBlock: readBlockText(readHome()), foreign: collectForeignWiring() });
	writeHome(`${renderManagedBlock(plan)}\n`);
	const rows = compose().filter((candidate) => typeof candidate.id === "string" && candidate.id.startsWith("ui-skin-"));
	const enabled = rows.filter((candidate) => candidate.disabled !== true).map((candidate) => candidate.id);
	assert.deepEqual(enabled, ["ui-skin-sample"], JSON.stringify(rows.map((row) => ({ id: row.id, disabled: row.disabled }))));
});

console.log("patch layer integrity (0.4.0 regression)");
// A comments-only patch layer is NOT a YAML array: YAML parses it as null and the
// harness refuses to boot with "must be a top-level YAML array of loader patch
// entries". The 0.4.0 layer migration produced exactly that file. These checks use
// the harness's own loader so the guarantee is verified, not assumed.
check("ensurePatchArray: comments only becomes a loadable array", () => {
	const repaired = ensurePatchArray("# just a comment\n# and another\n");
	assert.equal(repaired, PROFILE_TEMPLATE);
	assert.doesNotThrow(() => loadOverlayPatches("test", writeTemp(repaired)));
});
check("ensurePatchArray: a lone [] is left byte-identical", () => {
	const text = "# comment\n[]\n";
	assert.equal(ensurePatchArray(text), text);
});
check("ensurePatchArray: [] mixed with entries drops the [] line", () => {
	const text = "# comment\n[]\n- insert:\n    - id: ui-skin-sample\n      name: '@dsh-external/dsh-client-ui-skin-sample'\n";
	const fixed = ensurePatchArray(text);
	assert.ok(!fixed.includes("[]"), fixed);
	assert.doesNotThrow(() => loadOverlayPatches("test", writeTemp(fixed)));
});
check("ensurePatchArray: entries without [] are left untouched", () => {
	const text = "# comment\n- id: ui-skin-sample\n  disabled: false\n";
	assert.equal(ensurePatchArray(text), text);
});
check("migrateLayers leaves the profile layer loadable (not comments-only)", () => {
	// the exact 0.4.0 layout: header comments + the manager row + the managed block
	writeProfile(
		"# Your patch layer for this dsh profile, applied after every bundle layer:\n" +
			"# a top-level YAML array of loader patch entries.\n" +
			"#\n" +
			"# The markers below are maintained by the skin manager.\n" +
			"- insert:\n" +
			"    - id: ui-skin-manager\n" +
			"      name: '@dsh-external/dsh-client-ui-skin-manager'\n" +
			renderManagedBlock(planWiring({ skins: [sample], state: { mode: "skin", skin: "sample" }, previousBlock: "", foreign: noForeign() })) +
			"\n"
	);
	writeFileSync(HOME_PATCH, "");
	assert.doesNotThrow(() => loadOverlayPatches("test", PROFILE), "fixture itself must still be loadable");
	migrateLayers([sample, second, third], { mode: "skin", skin: "sample" });
	const profile = readFileSync(PROFILE, "utf8");
	assert.ok(!profile.includes("dsh-skin-manager:begin"), "the manager's block must leave the profile layer");
	assert.ok(!profile.includes("ui-skin-manager"), "the manager's row must leave the profile layer");
	assert.doesNotThrow(() => loadOverlayPatches("test", PROFILE), `profile layer after migration is not loadable:\n${profile}`);
	const home = readFileSync(HOME_PATCH, "utf8");
	assert.ok(home.includes("- id: ui-skin-manager"), "the home layer takes over the manager row");
	assert.ok(home.includes("dsh-skin-manager:begin"), "the home layer takes over the managed block");
});
check("migrateLayers repairs an already broken (comments-only) profile layer", () => {
	writeProfile("# Your patch layer for this dsh profile.\n#\n# The markers below are maintained by the skin manager.\n");
	assert.throws(() => loadOverlayPatches("test", PROFILE), "the broken state must be exactly what fails at boot");
	migrateLayers([sample], { mode: "skin", skin: "sample" });
	assert.doesNotThrow(() => loadOverlayPatches("test", PROFILE), `repair failed:\n${readFileSync(PROFILE, "utf8")}`);
});

rmSync(HOME, { recursive: true, force: true });
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
