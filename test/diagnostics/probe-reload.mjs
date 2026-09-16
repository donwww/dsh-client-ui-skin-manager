/**
 * Second watcher diagnostic: does the running harness still apply patch-file
 * changes at all, and can an entry that was disabled be re-enabled?
 *
 * Uses the manager's OWN entry: disabling it must make its route answer 404
 * (fallback HTML) instead of the JSON state.
 *
 * Usage: node test/probe-reload.mjs <port> <token> <patchFile>
 */
import { readFileSync, writeFileSync } from "node:fs";

const port = Number(process.argv[2]);
const token = process.argv[3];
const patch = process.argv[4];
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const state = async () => {
	const response = await fetch(`${base}/api/dsh-skin-manager/state?token=${token}`);
	const text = await response.text();
	return { status: response.status, type: response.headers.get("content-type"), body: text.slice(0, 90).replace(/\s+/g, " ") };
};

const original = readFileSync(patch, "utf8");
const withManager = (disabled) => (disabled ? `${original.trimEnd()}\n- id: ui-skin-manager\n  disabled: true\n` : original);

console.log("before          :", JSON.stringify(await state()));
writeFileSync(patch, withManager(true));
await sleep(3000);
console.log("manager disabled:", JSON.stringify(await state()));
writeFileSync(patch, original);
await sleep(3000);
console.log("manager enabled :", JSON.stringify(await state()));
