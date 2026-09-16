/**
 * Refresh the live harness's cached client bundle WITHOUT restarting it.
 *
 * The client module registry caches bundle bytes per package and only re-reads
 * them when a package's entry row is recreated. Disabling and re-enabling the
 * manager's own loader entry (through the profile patch layer, which the harness
 * watches) therefore re-hashes the freshly installed `lib/client.js` and the
 * next page load serves the new UI.
 *
 * Success is proven by the host-mount marker: the plugin rewrites it every time
 * it mounts, so a newer `mountedAt` means the entry really was recreated.
 *
 * Usage: node tools/refresh-served-bundle.mjs [--dry-run]
 */
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const dryRun = process.argv.includes("--dry-run");
const home = process.env.DSH_HOME || join(homedir(), ".dsh");
const profile = join(home, "profiles", process.env.DSH_DESKTOP_PROFILE || "web");
const patchFile = join(profile, "cordis.patch.yml");
const markerFile = join(profile, "data", "dsh-client-ui-skin-manager", "host-mount.json");
const ENTRY_ID = "ui-skin-manager";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const readMarker = () => {
	try {
		return JSON.parse(readFileSync(markerFile, "utf8")).mountedAt;
	} catch {
		return null;
	}
};

const original = readFileSync(patchFile, "utf8");
const before = readMarker();
console.log(`patch : ${patchFile}`);
console.log(`marker: ${before ?? "<absent>"}`);

if (dryRun) {
	console.log("\n--- would write (then restore) ---");
	console.log(`${original.trimEnd()}\n- id: ${ENTRY_ID}\n  disabled: true\n`);
	process.exit(0);
}

// 1. disable the entry: the loader disposes it and the registry drops its bundle row
writeFileSync(patchFile, `${original.trimEnd()}\n- id: ${ENTRY_ID}\n  disabled: true\n`, "utf8");
console.log("wrote disable row, waiting…");
await sleep(3000);

// 2. restore: the entry is recreated, so the registry re-reads the bundle bytes
writeFileSync(patchFile, original, "utf8");
console.log("restored original layer, waiting…");
await sleep(4000);

const after = readMarker();
console.log(`marker: ${after ?? "<absent>"}`);
const changed = after !== null && after !== before;
console.log(changed ? "RESULT: entry was recreated — the served bundle is fresh" : "RESULT: no remount observed — a DSH restart is required");
console.log(`patch restored byte-identically: ${readFileSync(patchFile, "utf8") === original}`);
console.log(`marker mtime: ${(() => { try { return statSync(markerFile).mtime.toISOString(); } catch { return "<absent>"; } })()}`);
process.exit(changed ? 0 : 3);
