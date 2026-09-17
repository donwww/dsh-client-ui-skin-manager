/**
 * Repair a patch layer that lost its top-level YAML array.
 *
 * A `cordis.patch.yml` holding only comments parses as `null`, and dsh then refuses
 * to start with:
 *
 *   Error: dsh: overlay …/cordis.patch.yml must be a top-level YAML array of loader patch entries
 *
 * That state was produced by this project's 0.4.0 layer migration. This tool repairs
 * the affected file WITHOUT needing dsh to boot, so a stuck installation can be
 * recovered with nothing but Node.
 *
 * Usage:
 *   node tools/repair-patch-layer.mjs [--home <dir>] [--profile <name>] [--all] [--dry-run]
 *
 *   --all   check and repair both the profile layer and the home layer
 *
 * Exit codes: 0 = nothing to do or repaired, 1 = repair failed, 2 = bad usage.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { PROFILE_TEMPLATE, ensurePatchArray } from "../lib/index.js";

/** Parse argv. */
function parseArgs(argv) {
	const options = { home: process.env.DSH_HOME || join(homedir(), ".dsh"), profile: process.env.DSH_DESKTOP_PROFILE || "web", all: false, dryRun: false };
	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index];
		if (token === "--home") options.home = resolve(argv[++index]);
		else if (token === "--profile") options.profile = argv[++index];
		else if (token === "--all") options.all = true;
		else if (token === "--dry-run") options.dryRun = true;
		else throw new Error(`unknown option ${token}`);
	}
	return options;
}

/** Repair one file; returns a short human-readable outcome. */
function repair(path, dryRun) {
	if (!existsSync(path)) return "absent (nothing to repair)";
	const before = readFileSync(path, "utf8");
	const after = ensurePatchArray(before);
	if (after === before) return "already a YAML array (no change)";
	if (dryRun) return `would repair → writes ${PROFILE_TEMPLATE.split("\n").length - 1} lines ending in []`;
	writeFileSync(path, after, "utf8");
	return "REPAIRED (now ends with a valid top-level array)";
}

const options = parseArgs(process.argv.slice(2));
const profileDir = join(options.home, "profiles", options.profile);
const targets = [[join(profileDir, "cordis.patch.yml"), "profile layer"]];
if (options.all) targets.push([join(options.home, "cordis.patch.yml"), "home layer"]);

console.log(`home    : ${options.home}`);
console.log(`profile : ${options.profile}${options.dryRun ? "  (dry run)" : ""}`);
for (const [path, label] of targets) {
	try {
		console.log(`${label.padEnd(14)}: ${path}\n                 → ${repair(path, options.dryRun)}`);
	} catch (error) {
		console.error(`${label.padEnd(14)}: ${path}\n                 → FAILED: ${error?.message ?? error}`);
		process.exit(1);
	}
}
if (!options.all) console.log("note    : pass --all to also check the home layer ($DSH_HOME/cordis.patch.yml)");
