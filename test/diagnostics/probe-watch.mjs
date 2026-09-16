/**
 * Diagnose which write style the running harness actually notices.
 *
 * Alternates the skin's `disabled` flag with IN-PLACE writes (no rename), then
 * asks the manager for the effective state. An unchanged result means the patch
 * file watcher is not reacting to in-place writes either.
 *
 * Usage: node test/probe-watch.mjs <port> <token> <patchFile>
 */
import { readFileSync, writeFileSync } from "node:fs";

const port = Number(process.argv[2] ?? 3099);
const token = process.argv[3];
const patch = process.argv[4];
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const effectiveId = async () => {
	const response = await fetch(`${base}/api/dsh-skin-manager/state?token=${token}`);
	return (await response.json()).effectiveId;
};

const original = readFileSync(patch, "utf8");
const withDisabled = (value) => original.replace(/- id: ui-skin-sample\n  disabled: (?:true|false)/, `- id: ui-skin-sample\n  disabled: ${value}`);

console.log(`mode       : in-place writeFileSync (no rename)`);
console.log(`before     : effectiveId=${await effectiveId()}`);
writeFileSync(patch, withDisabled("true"));
await sleep(2500);
console.log(`after true : effectiveId=${await effectiveId()}`);
writeFileSync(patch, withDisabled("false"));
await sleep(2500);
console.log(`after false: effectiveId=${await effectiveId()}`);
writeFileSync(patch, original);
await sleep(1500);
console.log(`restored   : effectiveId=${await effectiveId()}`);
