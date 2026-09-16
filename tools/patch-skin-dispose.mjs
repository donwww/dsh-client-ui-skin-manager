/**
 * Compatibility shim for skins whose host half registers a web route the way older
 * dsh builds allowed.
 *
 * Such a skin's `apply(ctx)` returns `ctx.webServer.register(...)`. When the
 * harness disables and later re-enables that entry, the loader restarts the plugin
 * while the previous route is still in the web server's table, so the restart fails
 * with `webserver: duplicate exact route "..."` and the skin can never be switched
 * back on without a DSH restart. Registering through `ctx.effect(...)` ties the
 * route to the plugin fiber, so the route is disposed with the entry and the entry
 * can be re-enabled any number of times.
 *
 * Idempotent: a file already carrying the shim is left untouched, and an
 * unrecognized shape is reported instead of edited.
 *
 * Usage: node tools/patch-skin-dispose.mjs <path-to-skin-package>
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MARKER = "dsh-compat: route registered through ctx.effect";
/** The shape every affected skin uses: `apply` returns the route registration. */
const RETURNS_REGISTER = /function apply\(ctx\)\s*\{\s*return\s+(ctx\.webServer\.register\(\{[\s\S]*?\}\))\s*;?\s*\}/;

/**
 * Apply the shim to one skin package.
 * @param packageDir - the skin package directory (must contain lib/index.js).
 * @returns `"patched"`, `"already"`, `"not-needed"` (no web route at all),
 *   `"missing"` (no lib/index.js), or `"unsupported"` (a route with an unexpected shape).
 */
export function patchSkinDispose(packageDir) {
	const entry = join(resolve(packageDir), "lib", "index.js");
	if (!existsSync(entry)) return "missing";
	const source = readFileSync(entry, "utf8");
	if (source.includes(MARKER)) return "already";
	if (!source.includes("webServer.register")) return "not-needed";
	const match = RETURNS_REGISTER.exec(source);
	if (match === null) return "unsupported";
	const patched = `function apply(ctx) {
	// ${MARKER}: the route must be disposed with the plugin fiber, otherwise the
	// harness cannot re-enable this skin after disabling it (duplicate route).
	return ctx.effect(() => ${match[1]}, "skin: host route");
}`;
	writeFileSync(entry, source.replace(RETURNS_REGISTER, patched), "utf8");
	return "patched";
}

/** CLI entry point. */
function main() {
	const target = process.argv[2];
	if (!target) {
		console.error("usage: node tools/patch-skin-dispose.mjs <path-to-skin-package>");
		process.exit(2);
	}
	const result = patchSkinDispose(target);
	const messages = {
		patched: `patched ${join(resolve(target), "lib", "index.js")}`,
		already: "already patched",
		"not-needed": "no web route to shim",
		missing: `no lib/index.js in ${resolve(target)}`,
		unsupported: "found a route registration in an unexpected shape — refusing to patch; review lib/index.js by hand"
	};
	console.log(messages[result]);
	process.exit(result === "missing" || result === "unsupported" ? 1 : 0);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();
