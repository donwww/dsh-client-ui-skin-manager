/**
 * Evidence run: with a STRANGER-installed skin whose patch row sits outside the
 * managed block, can the manager still control that skin?
 *
 * Usage: node test/probe-stranger.mjs <port> <token>
 */
const port = Number(process.argv[2]);
const token = process.argv[3];
const base = `http://127.0.0.1:${port}`;
const api = (path) => `${base}${path}${path.includes("?") ? "&" : "?"}token=${token}`;

const login = async () => {
	const response = await fetch(`${base}/?token=${token}`, { redirect: "manual" });
	const setCookie = response.headers.get("set-cookie");
	return setCookie ? setCookie.split(";")[0] : null;
};
const cookie = await login();

const state = async () => {
	const response = await fetch(api("/api/dsh-skin-manager/state"));
	return response.json();
};
const put = async (body) => {
	const response = await fetch(api("/api/dsh-skin-manager/state"), { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	return response.json();
};
const wire = async () => {
	const text = await (await fetch(base, { headers: { cookie } })).text();
	return { sample: text.includes("dsh-client-ui-skin-sample"), second: text.includes("dsh-client-ui-skin-second"), third: text.includes("dsh-client-ui-skin-third") };
};
const summarize = (data) => data.skins.map((skin) => `${skin.id}:${skin.enabled ? "ON" : "off"}`).join(" ");

console.log(`before      : ${summarize(await state())} | wire ${JSON.stringify(await wire())}`);

console.log(`PUT vanilla : ${summarize(await put({ mode: "vanilla" }))}`);
await new Promise((resolve) => setTimeout(resolve, 1200));
console.log(`after       : ${summarize(await state())} | wire ${JSON.stringify(await wire())}`);

console.log(`PUT sample   : ${summarize(await put({ mode: "skin", skin: "sample" }))}`);
await new Promise((resolve) => setTimeout(resolve, 1200));
console.log(`after       : ${summarize(await state())} | wire ${JSON.stringify(await wire())}`);
