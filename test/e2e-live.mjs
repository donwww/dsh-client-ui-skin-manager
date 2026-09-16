/**
 * End-to-end check against one RUNNING dsh web instance.
 *
 * Drives the skin manager's HTTP surface on a live harness and inspects the served
 * page, so the whole chain is proven: route → runtime entry toggle → managed block →
 * client-module wire.
 *
 * The fixture is described by environment variables, so the harness fits whichever
 * skins a test profile has:
 *
 *   E2E_SKINS="sample,second,third"   the installed skin ids, in picker order
 *   E2E_PICK="second"                 the skin selected mid-run (default: the 2nd)
 *   E2E_FOREIGN="third"               the skin wired by ANOTHER layer (default: the last)
 *   E2E_SKIN_ROUTE="/api/dsh-sample/palette-settings"
 *                                     optional host route of the first skin; when set,
 *                                     the run asserts it follows that skin's mount state
 *
 * Usage: node test/e2e-live.mjs <port> <launch-token>
 *   (find the token in the `dsh web:` line the instance printed at startup)
 */
const port = Number(process.argv[2] ?? 3080);
const token = process.argv[3];
if (!token) {
	console.error("usage: node test/e2e-live.mjs <port> <token>");
	process.exit(2);
}

const SKINS = (process.env.E2E_SKINS ?? "sample,second,third")
	.split(",")
	.map((id) => id.trim())
	.filter((id) => id.length > 0);
const PICK = process.env.E2E_PICK ?? SKINS[1] ?? SKINS[0];
const FOREIGN = process.env.E2E_FOREIGN ?? SKINS[SKINS.length - 1] ?? SKINS[0];
const SKIN_ROUTE = process.env.E2E_SKIN_ROUTE ?? "";
const FIRST = SKINS[0];

let failures = 0;
let skipped = 0;
function check(label, condition, detail = "") {
	if (condition) {
		console.log(`  ok   ${label}`);
		return;
	}
	failures += 1;
	console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
}
function skip(label, why) {
	skipped += 1;
	console.log(`  skip ${label} (${why})`);
}

const base = `http://127.0.0.1:${port}`;
const api = (path) => `${base}${path}${path.includes("?") ? "&" : "?"}token=${token}`;

/** Exchange the launch token for the signed session cookie the page uses. */
async function login() {
	const response = await fetch(`${base}/?token=${token}`, { redirect: "manual" });
	const setCookie = response.headers.get("set-cookie");
	if (!setCookie) throw new Error(`login failed: HTTP ${response.status}`);
	return setCookie.split(";")[0];
}

let cookie = null;

async function getState() {
	const response = await fetch(api("/api/dsh-skin-manager/state"));
	if (!response.ok) throw new Error(`state HTTP ${response.status}`);
	return response.json();
}

async function putState(body) {
	const response = await fetch(api("/api/dsh-skin-manager/state"), {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body)
	});
	return { status: response.status, payload: await response.json().catch(() => null) };
}

async function pollEffective(target, timeoutMs = 8000) {
	const deadline = Date.now() + timeoutMs;
	let last = null;
	while (Date.now() < deadline) {
		last = await getState();
		if (last.effectiveId === target) return last;
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	return last;
}

/** Fetch the served page and report which client modules its boot payload names. */
async function wire() {
	const response = await fetch(base, { headers: { cookie } });
	const text = await response.text();
	const present = new Set(SKINS.filter((id) => text.includes(`dsh-client-ui-skin-${id}`)));
	return { status: response.status, manager: text.includes("@dsh-external/dsh-client-ui-skin-manager"), present, length: text.length };
}

/** Ask the first skin's own host route: a mounted skin answers JSON, an unmounted one falls back to HTML. */
async function skinRoute() {
	const response = await fetch(`${base}${SKIN_ROUTE}`, { headers: { cookie } });
	return { status: response.status, type: response.headers.get("content-type") };
}

/** Pull the manager's served browser bundle out of the page's boot payload. */
async function servedManagerModule() {
	const page = await (await fetch(base, { headers: { cookie } })).text();
	const matches = [...page.matchAll(/\/plugins\/[^"'\\\s]*dsh-client-ui-skin-manager[^"'\\\s]*/g)].map((match) => match[0].replaceAll("&amp;", "&"));
	const url = matches.find((candidate) => candidate.includes("client.js"));
	if (url === undefined) return { url: null, body: "", matches };
	const response = await fetch(url.startsWith("/") ? `${base}${url}` : url, { headers: { cookie } });
	return { url, status: response.status, body: await response.text(), matches };
}

const skinOf = (state, id) => state.skins.find((skin) => skin.id === id);
const enabledIds = (state) => state.skins.filter((skin) => skin.enabled).map((skin) => skin.id).join(",");

console.log(`instance : ${base}`);
console.log(`fixture  : skins=${SKINS.join(",")} pick=${PICK} foreign=${FOREIGN}${SKIN_ROUTE ? ` route=${SKIN_ROUTE}` : ""}`);
cookie = await login();
check("launch token exchanges for a session cookie", typeof cookie === "string" && cookie.length > 0, cookie ?? "");

const served = await servedManagerModule();
check(
	"the served manager bundle is the settings page build",
	served.status === 200 && served.body.includes("settings.section") && served.body.includes("dsh-sm-radio") && !served.body.includes("dsh-sm-btn") && !served.body.includes("dsh-sm-mode"),
	`${served.url} HTTP ${served.status} len=${served.body.length}`
);

const first = await getState();
check("the manager mounted and discovered every fixture skin", SKINS.every((id) => skinOf(first, id)), JSON.stringify(first.skins.map((skin) => skin.id)));
check("the host-mount marker is present", typeof first.hostMountedAt === "string", String(first.hostMountedAt));
check(`the first skin (${FIRST}) is wired and effective`, first.effectiveId === FIRST, `effectiveId=${first.effectiveId}`);
check("no skin is reported duplicated", first.skins.every((skin) => skin.duplicated !== true), JSON.stringify(first.skins.map((skin) => ({ id: skin.id, dup: skin.duplicated }))));

const wireFirst = await wire();
check("the served page carries the manager and the active skin", wireFirst.status === 200 && wireFirst.manager && wireFirst.present.has(FIRST), JSON.stringify({ ...wireFirst, present: [...wireFirst.present] }));
if (SKIN_ROUTE) check("the active skin's own host route answers JSON", (await skinRoute()).type === "application/json; charset=utf-8", JSON.stringify(await skinRoute()));
else skip("the active skin's own host route answers JSON", "E2E_SKIN_ROUTE is unset");

const off = await putState({ mode: "vanilla" });
check("PUT vanilla accepted", off.status === 200 && off.payload.activeId === null, `HTTP ${off.status}`);
const afterOff = await pollEffective(null);
check("runtime toggle switched the loader to the stock UI", afterOff.effectiveId === null, `effectiveId=${afterOff.effectiveId}`);
check("the formerly active skin reports disabled but still wired", skinOf(afterOff, FIRST).enabled === false && skinOf(afterOff, FIRST).wired === true, JSON.stringify(skinOf(afterOff, FIRST)));

const wireOff = await wire();
check("the skinned client module is gone from the served page", wireOff.manager && !wireOff.present.has(FIRST), JSON.stringify([...wireOff.present]));
if (SKIN_ROUTE) check("the disabled skin's host route is unregistered", (await skinRoute()).type !== "application/json; charset=utf-8", JSON.stringify(await skinRoute()));

const on = await putState({ mode: "skin", skin: FIRST });
check("PUT the first skin accepted", on.status === 200 && on.payload.activeId === FIRST, `HTTP ${on.status}`);
const afterOn = await pollEffective(FIRST);
check("runtime toggle restored the skin", afterOn.effectiveId === FIRST, `effectiveId=${afterOn.effectiveId}`);
const wireOn = await wire();
check("the skinned client module is back on the served page", wireOn.manager && wireOn.present.has(FIRST), JSON.stringify([...wireOn.present]));
if (SKIN_ROUTE) check("the re-enabled skin's host route answers again", (await skinRoute()).type === "application/json; charset=utf-8", JSON.stringify(await skinRoute()));

console.log("several skins, one of them wired by somebody else");
const listed = await getState();
check("the list exposes every installed skin", listed.skins.map((skin) => skin.id).join(",") === SKINS.join(","), JSON.stringify(listed.skins.map((skin) => skin.id)));
const foreign = skinOf(listed, FOREIGN);
check("the foreign-wired skin is adopted, not duplicated", foreign.wired === true && foreign.duplicated === false, JSON.stringify(foreign));
check("the foreign-wired skin is held disabled while another skin is active", foreign.enabled === false && listed.effectiveId === FIRST, `${FOREIGN}.enabled=${foreign.enabled} effectiveId=${listed.effectiveId}`);

const pick = await putState({ mode: "skin", skin: PICK });
check(`picking ${PICK} is accepted`, pick.status === 200 && pick.payload.activeId === PICK, `activeId=${pick.payload.activeId}`);
const settledPick = await pollEffective(PICK);
check(`exactly ${PICK} is enabled`, settledPick.effectiveId === PICK && enabledIds(settledPick) === PICK, JSON.stringify({ effectiveId: settledPick.effectiveId, enabled: enabledIds(settledPick) }));
const wirePick = await wire();
check("the served page carries the picked skin and nothing else", wirePick.manager && wirePick.present.has(PICK) && !wirePick.present.has(FIRST), JSON.stringify([...wirePick.present]));
if (SKIN_ROUTE) check("the first skin's host route is gone while another is active", (await skinRoute()).type !== "application/json; charset=utf-8", JSON.stringify(await skinRoute()));

const pickForeign = await putState({ mode: "skin", skin: FOREIGN });
check(`picking the foreign-wired skin (${FOREIGN}) is accepted`, pickForeign.payload.activeId === FOREIGN, `activeId=${pickForeign.payload.activeId}`);
const settledForeign = await pollEffective(FOREIGN);
check(
	`exactly the foreign-wired skin is enabled`,
	settledForeign.effectiveId === FOREIGN && enabledIds(settledForeign) === FOREIGN,
	JSON.stringify(settledForeign.skins.map((skin) => ({ id: skin.id, on: skin.enabled })))
);
const wireForeign = await wire();
check("the served page carries the foreign-wired skin and nothing else", wireForeign.manager && wireForeign.present.has(FOREIGN) && wireForeign.present.size === 1, JSON.stringify([...wireForeign.present]));

const restored = await putState({ mode: "skin", skin: FIRST });
check("switching straight back to the first skin works", restored.payload.activeId === FIRST);
const settledBack = await pollEffective(FIRST);
check("the loader is back on the first skin", settledBack.effectiveId === FIRST && enabledIds(settledBack) === FIRST, JSON.stringify(settledBack.skins.map((skin) => ({ id: skin.id, on: skin.enabled }))));

check("the page without the cookie is still fenced", (await fetch(base)).status === 401);
// Note: routes registered through ctx.webServer.register are reachable on loopback
// without the browser cookie (as with every first-party plugin route); the manager's
// own guard is the loopback check covered by the unit tests.

console.log(failures === 0 ? `\nall checks passed${skipped > 0 ? ` (${skipped} skipped)` : ""}` : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
