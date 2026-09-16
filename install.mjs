/**
 * Install (or update) the skin manager into the current dsh profile.
 *
 * Two layers are involved, on purpose:
 *
 * - the HOME layer (`$DSH_HOME/cordis.patch.yml`) carries the manager's own
 *   insert row and its managed block — it is applied after the profile layer, so
 *   the manager's enable/disable decisions win over a skin row another agent
 *   added, and an agent that rewrites the profile layer cannot delete the manager;
 * - the PROFILE layer (`profiles/<name>/cordis.patch.yml`) is left to the user and
 *   to whoever installs skins; any rows this manager previously put there are
 *   removed, and a skin another agent already wired there is ADOPTED (the manager
 *   then only overrides its enablement instead of inserting a duplicate).
 *
 * Re-running is safe and idempotent.
 *
 * Usage:  node install.mjs [--dry-run]
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { MANAGED_BEGIN, MANAGED_END, discoverSkins, parseBlockInserts, readBlockText, readSettings, renderManagedBlock, resolveActiveId, spliceBlock } from "./lib/index.js";

const dryRun = process.argv.includes("--dry-run");
const filesOnly = process.argv.includes("--files-only");
const source = dirname(fileURLToPath(import.meta.url));
const home = process.env.DSH_HOME || join(homedir(), ".dsh");
const profileName = process.env.DSH_DESKTOP_PROFILE && /^[A-Za-z0-9_-]+$/.test(process.env.DSH_DESKTOP_PROFILE) ? process.env.DSH_DESKTOP_PROFILE : "web";
const profileDir = join(home, "profiles", profileName);
const targetDir = join(profileDir, "node_modules", "@dsh-external", "dsh-client-ui-skin-manager");
const homePatch = join(home, "cordis.patch.yml");
const profilePatch = join(profileDir, "cordis.patch.yml");
const SELF_ID = "ui-skin-manager";
const SELF_PACKAGE = "@dsh-external/dsh-client-ui-skin-manager";

const HOME_HEADER = [
	"# Harness-home patch layer for every profile, applied after each profile's own",
	"# cordis.patch.yml. Written by @dsh-external/dsh-client-ui-skin-manager:",
	"# the row below wires the manager itself and the marked block is its skin wiring.",
	"# Edit skins through 设置 → 皮肤 instead of hand-editing that block.",
	""
].join("\n");

const MANAGER_ROW = ["- insert:", `    - id: ${SELF_ID}`, `      name: '${SELF_PACKAGE}'`, ""].join("\n");

const PROFILE_TEMPLATE = [
	"# Your patch layer for this dsh profile, applied after every bundle layer:",
	"# a top-level YAML array of loader patch entries (id-targeted config",
	"# overrides, disables, and insert lists; `!!js` expressions allowed).",
	"[]",
	""
].join("\n");

if (!existsSync(profileDir)) {
	console.error(`profile directory not found: ${profileDir}`);
	process.exit(1);
}

/** Remove this manager's marker block from a patch layer's text. */
function stripBlock(text) {
	const begin = text.indexOf(MANAGED_BEGIN);
	const end = text.indexOf(MANAGED_END);
	if (begin < 0 || end < begin) return text;
	return `${text.slice(0, begin)}${text.slice(end + MANAGED_END.length)}`;
}

/** Remove the manager's own insert row (and the header it introduced) from the profile layer. */
function stripManagerRow(text) {
	return text
		.replace(/\n?- insert:\n\s*- id: ui-skin-manager\n\s*name: ['"]@dsh-external\/dsh-client-ui-skin-manager['"]\n?/g, "\n")
		.replace(/\n?# (?:The markers below|the markers below) are maintained by @dsh-external\/dsh-client-ui-skin-manager;?\n?/g, "\n")
		.replace(/\n?# edit skins through its [^\n]*panel instead of hand-editing that block\.\n?/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trimEnd()
		.concat("\n");
}

/** True when a patch layer holds no entries at all (comments only, or an empty array). */
function hasNoEntries(text) {
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("#"))
		.every((line) => line === "[]");
}

console.log(`profile : ${profileDir}`);
console.log(`package : ${targetDir}`);
console.log(`home    : ${homePatch}`);

// 1. copy the package (code, manifest, docs, tools)
const files = ["package.json", "README.md", "AGENT-INSTALL.md"];
if (!dryRun) {
	mkdirSync(targetDir, { recursive: true });
	cpSync(join(source, "lib"), join(targetDir, "lib"), { recursive: true });
	if (existsSync(join(source, "tools"))) cpSync(join(source, "tools"), join(targetDir, "tools"), { recursive: true });
	for (const file of files) if (existsSync(join(source, file))) cpSync(join(source, file), join(targetDir, file));
}
console.log(`copied  : lib/${existsSync(join(source, "tools")) ? ", tools/" : ""}${files.filter((file) => existsSync(join(source, file))).map((file) => `, ${file}`).join("")}`);

if (filesOnly) {
	// Used while an OLDER build is still running: that build rewrites the profile
	// layer, so moving the block now would race it. The new host half migrates the
	// layers itself the first time it mounts (i.e. after the next DSH restart).
	console.log("files-only: patch layers left untouched; the running build migrates them on its next mount");
	process.exit(0);
}

// 2. plan the skin wiring. Offline, a skin is "already wired" when some patch layer
//    names its package in an insert row — adopt that row's id instead of inserting again.
const skins = discoverSkins(profileDir);
const settings = readSettings();
const activeId = resolveActiveId(skins, settings);
const profileText = existsSync(profilePatch) ? readFileSync(profilePatch, "utf8") : "";
const homeText = existsSync(homePatch) ? readFileSync(homePatch, "utf8") : "";
const adopted = new Map([...parseBlockInserts(stripBlock(homeText)), ...parseBlockInserts(stripBlock(profileText))]);
const plan = skins.map((skin) => {
	const foreignId = adopted.get(skin.package);
	return {
		id: foreignId ?? skin.entryId,
		package: skin.package,
		skinId: skin.id,
		insert: foreignId === undefined,
		disabled: skin.id !== activeId,
		external: foreignId !== undefined
	};
});
const block = renderManagedBlock(plan);

// 3. rewrite the HOME layer: header + manager row + block, everything else preserved
const homeNext = spliceBlock(homeText, block);
const homeWithRow = homeNext.includes(`- id: ${SELF_ID}`) ? homeNext : `${HOME_HEADER}${MANAGER_ROW}${homeNext}`;

// 4. clean the PROFILE layer: drop our old block and manager row
const strippedProfile = stripManagerRow(stripBlock(profileText));
const profileNext = hasNoEntries(strippedProfile) ? PROFILE_TEMPLATE : strippedProfile;

console.log(`skins   : ${skins.map((skin) => `${skin.id} (${skin.id === activeId ? "active" : "off"}${skin.id === activeId ? "" : ""})`).join(", ") || "none"}`);
console.log(`wiring  : ${plan.map((row) => `${row.skinId}:${row.insert ? "insert" : `adopt ${row.id}`}`).join(", ") || "none"}`);
console.log(`state   : mode=${settings.mode} skin=${settings.skin ?? "-"}`);

if (dryRun) {
	console.log("\n--- home layer (dry run) ---");
	console.log(homeWithRow);
	console.log("--- profile layer (dry run) ---");
	console.log(profileNext);
	process.exit(0);
}

const homeBackup = join(home, "cordis.patch.yml.pre-skin-manager.bak");
const profileBackup = join(profileDir, "cordis.patch.yml.pre-skin-manager.bak");
if (homeText.length > 0 && !existsSync(homeBackup)) copyFileSync(homePatch, homeBackup);
else if (profileText.length > 0 && !existsSync(profileBackup)) copyFileSync(profilePatch, profileBackup);

writeFileSync(homePatch, homeWithRow, "utf8");
if (profileNext !== profileText) writeFileSync(profilePatch, profileNext, "utf8");
console.log(`wrote   : ${homePatch}`);
console.log(`wrote   : ${profilePatch}${profileNext === profileText ? " (unchanged)" : ""}`);
