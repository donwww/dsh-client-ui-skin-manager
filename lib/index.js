/**
 * Skin manager — host half.
 *
 * Lists the skins installed in the current dsh profile (any package exposing a
 * `skin.json`), keeps exactly one of them wired into the loader, and persists
 * the choice as a managed block inside the profile's `cordis.patch.yml`.
 *
 * The profile patch layer is watched by the harness (`dsh.profile.patchReload:
 * live`), so rewriting that block re-composes the running tree: a skin row is
 * inserted and every skin except the active one is disabled. A browser reload
 * then picks up the changed client-module wire.
 *
 * @module @dsh-external/dsh-client-ui-skin-manager
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";

const name = "@dsh-external/dsh-client-ui-skin-manager";
const inject = ["webServer"];

const STATE_ROUTE = "/api/dsh-skin-manager/state";
const PREVIEW_ROUTE = "/api/dsh-skin-manager/preview";
const SETTINGS_DIR = "dsh-client-ui-skin-manager";
const SETTINGS_FILE = "settings.json";
const MANAGED_BEGIN = "# === dsh-skin-manager:begin (managed block — manual edits are overwritten) ===";
const MANAGED_END = "# === dsh-skin-manager:end ===";
const SELF_PACKAGE = name;

/**
 * The pristine profile-level patch layer: comments plus an empty top-level array.
 *
 * A patch layer that holds ONLY comments is not `[]` — YAML parses it as `null`, and
 * the harness refuses to boot with
 * `overlay … must be a top-level YAML array of loader patch entries`.
 * Every writer in this package therefore runs its result through
 * {@link ensurePatchArray} before saving.
 */
const PROFILE_TEMPLATE = [
	"# Your patch layer for this dsh profile, applied after every bundle layer:",
	"# a top-level YAML array of loader patch entries (id-targeted config",
	"# overrides, disables, and insert lists; `!!js` expressions allowed).",
	"[]",
	""
].join("\n");

const MAX_BODY_BYTES = 256 * 1024;
const MIME_TYPES = {
	".webp": "image/webp",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif"
};

/**
 * Keep a patch layer loadable: it must stay a top-level YAML array.
 *
 * - comments only (or empty) → the pristine template with `[]`, because a
 *   comment-only file parses as `null` and the harness then refuses to start;
 * - a lone `[]` (with any comments) → left untouched;
 * - a `[]` line mixed with real entries → the `[]` line is dropped, since a flow
 *   sequence followed by block entries is not valid YAML;
 * - anything with entries and no stray `[]` → left untouched.
 *
 * @param text - the patch layer's current content.
 * @returns content that is guaranteed to parse as a top-level array.
 */
function ensurePatchArray(text) {
	const lines = text.split("\n");
	const isBlankOrComment = (line) => {
		const trimmed = line.trim();
		return trimmed.length === 0 || trimmed.startsWith("#");
	};
	const isArrayShorthand = (line) => line.trim() === "[]";
	const entries = lines.filter((line) => !isBlankOrComment(line));
	if (entries.length === 0) return PROFILE_TEMPLATE;
	if (entries.length === 1 && isArrayShorthand(entries[0])) return text;
	if (entries.some(isArrayShorthand)) return `${lines.filter((line) => !isArrayShorthand(line)).join("\n").trimEnd()}\n`;
	return text;
}

/** The profile this process runs; mirrors the skin convention. */
function profileName() {
	const profile = process.env.DSH_DESKTOP_PROFILE;
	return profile && /^[A-Za-z0-9_-]+$/.test(profile) ? profile : "web";
}

/** Absolute directory of the current profile. */
function profileDir() {
	return join(process.env.DSH_HOME || join(homedir(), ".dsh"), "profiles", profileName());
}

/** The PROFILE patch layer (the layer another agent is told to edit). */
function patchPath() {
	return join(profileDir(), "cordis.patch.yml");
}

/**
 * The HOME patch layer (`$DSH_HOME/cordis.patch.yml`). This manager keeps its own
 * insert row and its managed block HERE on purpose: the home layer is applied
 * after the profile layer, so a skin wired by somebody else's row (the documented
 * `cordis.patch.yml` install step another agent performs) can still be enabled or
 * disabled by this manager, and an agent that rewrites the profile layer cannot
 * delete the manager itself.
 */
function homePatchPath() {
	return join(process.env.DSH_HOME || join(homedir(), ".dsh"), "cordis.patch.yml");
}

/** This manager's own persisted selection. */
function settingsPath() {
	return join(profileDir(), "data", SETTINGS_DIR, SETTINGS_FILE);
}

/** Proof of life for the host half: rewritten every time the plugin mounts. */
function mountMarkerPath() {
	return join(profileDir(), "data", SETTINGS_DIR, "host-mount.json");
}

function safeReaddir(dir) {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

function isDirectory(path) {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Read a JSON file, tolerating the UTF-8 BOM that Windows editors and
 * PowerShell's `Set-Content -Encoding UTF8` prepend; a skin package authored
 * that way must still be discovered.
 */
function readJson(path) {
	try {
		const text = readFileSync(path, "utf8");
		return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
	} catch {
		return undefined;
	}
}

/**
 * Read one candidate package directory as a skin.
 * @param packageDir - the candidate package root.
 * @returns the skin descriptor, or `undefined` when the package is not a skin.
 */
function readSkin(packageDir) {
	const skinPath = join(packageDir, "skin.json");
	if (!existsSync(skinPath)) return undefined;
	const meta = readJson(skinPath);
	if (meta === undefined || typeof meta !== "object" || meta === null) return undefined;
	const manifest = readJson(join(packageDir, "package.json"));
	const packageName = typeof meta.package === "string" && meta.package.length > 0 ? meta.package : manifest && typeof manifest.name === "string" ? manifest.name : undefined;
	if (packageName === undefined || packageName === SELF_PACKAGE) return undefined;
	const id = typeof meta.id === "string" && meta.id.length > 0 ? meta.id : packageName;
	const wiring = meta.wiring && typeof meta.wiring === "object" ? meta.wiring : {};
	const entryId = typeof wiring.id === "string" && wiring.id.length > 0 ? wiring.id : `ui-skin-${id}`;
	const preview = meta.preview && typeof meta.preview === "object" ? meta.preview : {};
	const previewPath = (value) => (typeof value === "string" && value.length > 0 ? join(packageDir, value) : undefined);
	return {
		id,
		name: typeof meta.name === "string" && meta.name.length > 0 ? meta.name : id,
		nameEn: typeof meta.nameEn === "string" ? meta.nameEn : undefined,
		author: typeof meta.author === "string" ? meta.author : undefined,
		tagline: typeof meta.tagline === "string" ? meta.tagline : undefined,
		description: typeof meta.description === "string" ? meta.description : undefined,
		package: packageName,
		entryId,
		order: typeof meta.order === "number" ? meta.order : 100,
		dir: packageDir,
		previewLight: previewPath(preview.light),
		previewDark: previewPath(preview.dark)
	};
}

/**
 * Discover every skin package installed in the profile's node_modules.
 * @param dir - the profile directory.
 * @returns skin descriptors in skin-declared order.
 */
function discoverSkins(dir) {
	const found = [];
	const root = join(dir, "node_modules");
	for (const entry of safeReaddir(root)) {
		if (entry.startsWith(".")) continue;
		const base = join(root, entry);
		if (!isDirectory(base)) continue;
		if (entry.startsWith("@")) {
			for (const scoped of safeReaddir(base)) {
				if (scoped.startsWith(".")) continue;
				const skin = readSkin(join(base, scoped));
				if (skin !== undefined) found.push(skin);
			}
			continue;
		}
		const skin = readSkin(base);
		if (skin !== undefined) found.push(skin);
	}
	return found.sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
}

/** Read the persisted selection, defaulting to "use a skin" with none chosen. */
function readSettings() {
	const stored = readJson(settingsPath());
	const mode = stored && stored.mode === "vanilla" ? "vanilla" : "skin";
	const skin = stored && typeof stored.skin === "string" ? stored.skin : null;
	return { mode, skin };
}

/** Persist the selection atomically; the profile data directory is created on demand. */
function writeSettings(state) {
	const path = settingsPath();
	mkdirSync(join(profileDir(), "data", SETTINGS_DIR), { recursive: true });
	const temporary = `${path}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
	try {
		renameSync(temporary, path);
	} catch {
		rmSync(path, { force: true });
		renameSync(temporary, path);
	}
}

/** The active skin id for one selection and skin set, or `null` for the stock UI. */
function resolveActiveId(skins, state) {
	if (skins.length === 0 || state.mode === "vanilla") return null;
	if (state.skin !== null && skins.some((skin) => skin.id === state.skin)) return state.skin;
	return skins[0].id;
}

/**
 * Read the insert rows out of one managed block: package name → entry id. This
 * tells the manager which entries IT created, so entries it did not create are
 * recognizable as somebody else's wiring.
 * @param block - the managed block text (markers included).
 * @returns a map from package name to entry id.
 */
function parseBlockInserts(block) {
	const owned = new Map();
	const lines = block.split("\n");
	for (let index = 0; index < lines.length; index += 1) {
		const id = /^\s*-\s*id:\s*(\S+)\s*$/.exec(lines[index]);
		if (id === null) continue;
		const name = /^\s+name:\s*['"]?([^'"]+?)['"]?\s*$/.exec(lines[index + 1] ?? "");
		if (name !== null) owned.set(name[1].trim(), id[1]);
	}
	return owned;
}

/**
 * Strip the loader's group qualification from an entry id: entries under the root
 * include surface as `include:<id>`, while patch rows address the declared id.
 * @param id - a live loader entry id.
 * @returns the id as a patch row writes it.
 */
function declaredId(id) {
	const separator = id.indexOf(":");
	return separator >= 0 ? id.slice(separator + 1) : id;
}

/**
 * Wiring some other layer already provides: package name → the declared entry id
 * its row uses. Read from the patch FILES (never from the live loader, whose ids
 * are qualified and may be mid-reload), excluding this manager's own block.
 * @returns a map from package name to declared entry id.
 */
function collectForeignWiring() {
	const foreign = new Map();
	const home = homePatchPath();
	const profile = patchPath();
	const sources = [
		[home, true],
		[profile, false]
	];
	for (const [path, excludeOwnBlock] of sources) {
		try {
			if (!existsSync(path)) continue;
			const text = readFileSync(path, "utf8");
			const scope = excludeOwnBlock ? text.replace(readBlockText(text), "") : text;
			for (const [packageName, id] of parseBlockInserts(scope)) foreign.set(packageName, declaredId(id));
		} catch {
			/* an unreadable layer simply contributes no wiring */
		}
	}
	return foreign;
}

/**
 * Decide, per skin, whether this manager must insert the entry or only override
 * its enablement.
 *
 * A skin someone else wired — the documented `cordis.patch.yml` install step of a
 * skin README, a bundle row, or a leftover from a previous tool — already has a
 * loader entry. Inserting it again would give the composed tree two entries with
 * one id, which breaks mutual exclusion and makes the enable/disable rows
 * unreliable; so for those skins the manager emits ONLY the `disabled` row and
 * targets the id that already exists (adopting it), whatever that id is.
 *
 * @param options - discovered skins, the persisted selection, the block this
 *   manager wrote last time, and the wiring other layers already provide.
 * @returns one plan row per skin: `{ id, package, skinId, insert, disabled, external }`.
 */
function planWiring({ skins, state, previousBlock, foreign = new Map() }) {
	const activeId = resolveActiveId(skins, state);
	const owned = parseBlockInserts(previousBlock);
	return skins.map((skin) => {
		const foreignId = foreign.get(skin.package);
		const ownedId = owned.get(skin.package);
		const id = foreignId ?? ownedId ?? skin.entryId;
		return {
			id: declaredId(id),
			package: skin.package,
			skinId: skin.id,
			insert: foreignId === undefined,
			disabled: skin.id !== activeId,
			external: foreignId !== undefined
		};
	});
}

/**
 * Render the managed patch block from a wiring plan.
 * @param plan - the rows {@link planWiring} produced.
 * @returns the block text, without a trailing newline.
 */
function renderManagedBlock(plan) {
	const rows = Array.isArray(plan) ? plan : [];
	const inserts = rows.filter((row) => row.insert);
	const lines = [MANAGED_BEGIN];
	if (inserts.length > 0) {
		lines.push("- insert:");
		for (const row of inserts) {
			lines.push(`    - id: ${row.id}`);
			lines.push(`      name: '${row.package}'`);
		}
	}
	for (const row of rows) lines.push(`- id: ${row.id}`, `  disabled: ${row.disabled ? "true" : "false"}`);
	lines.push(MANAGED_END);
	return lines.join("\n");
}

/**
 * Overwrite a watched file without replacing it: the content is staged in a
 * temporary file and then copied onto the target, so the target keeps its
 * identity (file watchers watching that path stay attached).
 */
function writeFileInPlace(path, content) {
	const temporary = `${path}.skin-manager.tmp`;
	writeFileSync(temporary, content, "utf8");
	try {
		copyFileSync(temporary, path);
	} finally {
		rmSync(temporary, { force: true });
	}
}

/**
 * The patch file currently holding this manager's block: the home layer by
 * default, or the profile layer when a block from an earlier version still lives
 * there (the installer migrates it).
 * @returns the absolute path of the file to rewrite.
 */
function findBlockFile() {
	for (const candidate of [homePatchPath(), patchPath()]) {
		try {
			if (existsSync(candidate) && readFileSync(candidate, "utf8").includes(MANAGED_BEGIN)) return candidate;
		} catch {
			/* unreadable candidate: try the next one */
		}
	}
	return homePatchPath();
}

/** Extract the current managed block, or an empty string when there is none. */
function readBlockText(text) {
	const begin = text.indexOf(MANAGED_BEGIN);
	const end = text.indexOf(MANAGED_END);
	return begin >= 0 && end > begin ? text.slice(begin, end + MANAGED_END.length) : "";
}

/** Splice a managed block into a patch file's text (replacing an existing one). */
function spliceBlock(text, block) {
	const begin = text.indexOf(MANAGED_BEGIN);
	const end = text.indexOf(MANAGED_END);
	if (begin >= 0 && end > begin) return `${text.slice(0, begin)}${block}${text.slice(end + MANAGED_END.length)}`;
	const base = text.trimEnd();
	return `${base.length > 0 ? `${base}\n` : ""}${block}\n`;
}

/**
 * Replace the managed block, preserving everything outside it. Written in place so
 * a file watcher watching that exact path keeps working. Prefers the home layer; a
 * read-only or missing home directory falls back to the profile layer.
 * @param skins - discovered skins.
 * @param state - the persisted selection.
 * @returns whether a file changed.
 */
function writeManagedBlock(skins, state) {
	const preferred = findBlockFile();
	const current = ensurePatchArray(existsSync(preferred) ? readFileSync(preferred, "utf8") : "");
	const plan = planWiring({ skins, state, previousBlock: readBlockText(current), foreign: collectForeignWiring() });
	const next = spliceBlock(current, renderManagedBlock(plan));
	if (next === current) return false;
	try {
		writeFileInPlace(preferred, next);
		return true;
	} catch {
		const fallback = preferred === patchPath() ? homePatchPath() : patchPath();
		const fallbackCurrent = ensurePatchArray(existsSync(fallback) ? readFileSync(fallback, "utf8") : "");
		const fallbackNext = spliceBlock(fallbackCurrent, renderManagedBlock(plan));
		if (fallbackNext === fallbackCurrent) return false;
		writeFileInPlace(fallback, fallbackNext);
		return true;
	}
}

/**
 * Apply the selection to the RUNNING loader: enable the active skin's entry and
 * disable every other skin entry. This drives the entries the composed tree already
 * has (from the managed block or from wiring another layer provided), so a toggle
 * takes effect immediately; the patch file carries the same state into the next
 * load. A skin with no mounted entry yet is reported as `unmounted` and left alone:
 * the block already supplies its insert, and creating a second entry here would
 * double-mount the package once that insert is applied.
 * @param ctx - the plugin context.
 * @param skins - discovered skins.
 * @param activeId - the skin to enable, or `null` for the stock UI.
 * @returns a diagnostic summary of what happened.
 */
async function applyRuntimeSelection(ctx, skins, activeId) {
	const loader = ctx.get("loader");
	const summary = { loaderAvailable: loader !== undefined, toggled: [], unmounted: [], failed: [] };
	if (loader === undefined || typeof loader.entries !== "function") return summary;
	const entries = loaderEntries(ctx);
	const ordered = [...skins].sort((left, right) => (left.id === activeId ? -1 : 0) - (right.id === activeId ? -1 : 0));
	for (const skin of ordered) {
		const disabled = skin.id !== activeId;
		// Every entry of this package, not just the first: a skin wired by another
		// layer (or a legacy duplicate) must be controllable, so all of them are driven.
		const matches = entries.filter((entry) => entry.options && entry.options.name === skin.package);
		if (matches.length === 0) {
			// The entry is not mounted yet: the managed block already carries the insert,
			// and creating the entry here as well would collide with that insert once the
			// patch file reloads (two entries for one package, i.e. a double mount). The
			// reload/restart is what mounts it, so record it and leave the tree alone.
			summary.unmounted.push(skin.id);
			continue;
		}
		for (const entry of matches) {
			try {
				if (entry.options.disabled !== disabled) {
					await entry.update({ disabled });
					summary.toggled.push(entry.id);
				}
			} catch (error) {
				summary.failed.push(`${entry.id}: ${String((error && error.message) || error)}`);
			}
		}
	}
	return summary;
}

/** Map a Cordis fiber state onto a readable phase. */
function phaseOf(entry) {
	const fiber = entry.fiber;
	if (fiber === undefined) return null;
	switch (fiber.state) {
		case 0:
			return "pending";
		case 1:
			return "loading";
		case 2:
			return "active";
		case 3:
			return "failed";
		case 5:
			return "unloading";
		default:
			return null;
	}
}

/** Live loader entries (non-group), or an empty list when the loader is unavailable. */
function loaderEntries(ctx) {
	const loader = ctx.get("loader");
	if (loader === undefined || typeof loader.entries !== "function") return [];
	return [...loader.entries()].filter((entry) => !(entry.options && entry.options.group));
}

/** Live loader rows, or an empty list when the loader service is unavailable. */
function loaderRows(ctx) {
	return loaderEntries(ctx).map((entry) => ({
		entryId: entry.id,
		moduleName: entry.options ? entry.options.name : undefined,
		disabled: entry.disabled === true,
		phase: phaseOf(entry)
	}));
}

/**
 * Compose the state the panel renders.
 * @param ctx - the plugin context (for the live loader rows).
 * @param overrides - optional desired selection to report instead of the stored one.
 * @returns the snapshot payload.
 */
function snapshot(ctx, overrides = {}) {
	const dir = profileDir();
	const skins = discoverSkins(dir);
	const stored = readSettings();
	const state = {
		mode: overrides.mode !== undefined ? overrides.mode : stored.mode,
		skin: overrides.skin !== undefined ? overrides.skin : stored.skin
	};
	const activeId = resolveActiveId(skins, state);
	const rows = loaderRows(ctx);
	const byPackage = new Map();
	for (const row of rows) {
		if (typeof row.moduleName !== "string") continue;
		if (!byPackage.has(row.moduleName)) byPackage.set(row.moduleName, []);
		byPackage.get(row.moduleName).push(row);
	}
	const items = skins.map((skin) => {
		const matches = byPackage.get(skin.package) ?? [];
		const row = matches[0];
		return {
			id: skin.id,
			name: skin.name,
			nameEn: skin.nameEn,
			author: skin.author,
			tagline: skin.tagline,
			description: skin.description,
			package: skin.package,
			entryId: row === undefined ? skin.entryId : declaredId(row.entryId),
			wired: matches.length > 0,
			enabled: matches.some((candidate) => !candidate.disabled),
			phase: row === undefined ? null : row.phase,
			/** More than one loader entry for this package: foreign wiring left a duplicate. */
			duplicated: matches.length > 1,
			/** Wired by a layer other than this manager (an install step another agent ran). */
			external: matches.length > 0 && !matches.some((candidate) => declaredId(candidate.entryId) === skin.entryId),
			hasPreview: skin.previewLight !== undefined || skin.previewDark !== undefined
		};
	});
	const effectiveId = items.find((item) => item.enabled)?.id ?? null;
	const mount = readJson(mountMarkerPath());
	return {
		ok: true,
		profile: profileName(),
		mode: state.mode,
		skin: state.skin,
		activeId,
		effectiveId,
		skins: items,
		hostMountedAt: mount && typeof mount.mountedAt === "string" ? mount.mountedAt : null,
		hint: skins.length === 0 ? "未在 profile 的 node_modules 中发现皮肤包（缺少 skin.json）" : undefined
	};
}

/** Build the skin directory index used by the preview route. */
function skinById(dir, id) {
	return discoverSkins(dir).find((skin) => skin.id === id);
}

function isLoopback(req) {
	const address = req.socket && req.socket.remoteAddress;
	return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function sendJson(res, status, value) {
	const data = Buffer.from(JSON.stringify(value), "utf8");
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"content-length": String(data.length)
	});
	res.end(data);
}

function readBody(req) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				req.destroy();
				reject(new Error("payload too large"));
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

/** GET the state, or PUT a new selection. */
async function handleStateRoute(ctx, req, res) {
	if (!isLoopback(req)) {
		res.writeHead(403);
		res.end("forbidden");
		return;
	}
	const url = new URL(req.url || STATE_ROUTE, "http://127.0.0.1");
	if (req.method === "GET") {
		sendJson(res, 200, snapshot(ctx));
		return;
	}
	if (req.method !== "PUT" && req.method !== "POST") {
		res.writeHead(405, { allow: "GET, PUT" });
		res.end();
		return;
	}
	try {
		const parsed = JSON.parse(await readBody(req));
		const skins = discoverSkins(profileDir());
		const stored = readSettings();
		let mode = parsed && parsed.mode === "vanilla" ? "vanilla" : parsed && parsed.mode === "skin" ? "skin" : stored.mode;
		let skin = parsed && typeof parsed.skin === "string" ? parsed.skin : stored.skin;
		if (skin !== null && !skins.some((candidate) => candidate.id === skin)) skin = null;
		if (skins.length === 0) mode = "vanilla";
		if (mode === "skin" && skin === null && skins.length > 0) skin = skins[0].id;
		const state = { mode, skin };
		writeSettings(state);
		const changed = writeManagedBlock(skins, state);
		const runtime = await applyRuntimeSelection(ctx, skins, resolveActiveId(skins, state));
		sendJson(res, 200, { ...snapshot(ctx, state), changed, runtime });
	} catch (error) {
		sendJson(res, 400, { ok: false, message: String((error && error.message) || error) });
	}
}

/** Serve one preview image from an installed skin package. */
function handlePreviewRoute(req, res) {
	if (!isLoopback(req)) {
		res.writeHead(403);
		res.end("forbidden");
		return;
	}
	const url = new URL(req.url || PREVIEW_ROUTE, "http://127.0.0.1");
	const id = url.searchParams.get("skin");
	const theme = url.searchParams.get("theme") === "dark" ? "dark" : "light";
	const skin = id === null ? undefined : skinById(profileDir(), id);
	const file = skin === undefined ? undefined : theme === "dark" ? skin.previewDark ?? skin.previewLight : skin.previewLight ?? skin.previewDark;
	if (file === undefined || !existsSync(file)) {
		res.writeHead(404);
		res.end("not found");
		return;
	}
	try {
		const data = readFileSync(file);
		res.writeHead(200, {
			"content-type": MIME_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
			"cache-control": "private, max-age=60",
			"content-length": String(data.length)
		});
		res.end(data);
	} catch {
		res.writeHead(500);
		res.end("read failed");
	}
}

/**
 * Re-hash this package's browser bundle so a freshly copied `lib/client.js`
 * reaches the page without restarting the harness. `rebuilt()` is the client
 * module registry's only content-change entry point; it is a no-op when the
 * bytes are unchanged.
 * @param ctx - the plugin context.
 */
function refreshClientBundle(ctx) {
	try {
		const registry = ctx.get("clientModules");
		if (registry === undefined) return;
		if (typeof registry.reconcilePackage === "function") registry.reconcilePackage(SELF_PACKAGE);
		if (typeof registry.rebuilt === "function") registry.rebuilt(SELF_PACKAGE);
	} catch {
		/* the registry is optional; a failure must not break the plugin */
	}
}

/** This manager's own insert row as the installer writes it into a patch layer. */
const SELF_ID = "ui-skin-manager";
const SELF_ROW = `- insert:\n    - id: ${SELF_ID}\n      name: '${SELF_PACKAGE}'\n`;

/**
 * Make the HOME layer own this manager's wiring: ensure its own insert row is
 * there, remove a block and manager row left in the PROFILE layer by an earlier
 * version, and finally regenerate the managed block.
 *
 * Only text this manager itself wrote is ever removed from the profile layer, so
 * rows another agent added for its skins are preserved and adopted instead.
 * @param ctx - the plugin context.
 * @param skins - discovered skins.
 * @param state - the persisted selection.
 * @returns a short description of what changed.
 */
function migrateLayers(skins, state) {
	const home = homePatchPath();
	const profile = patchPath();
	const homeText = existsSync(home) ? readFileSync(home, "utf8") : "";
	const profileText = home === profile ? "" : existsSync(profile) ? readFileSync(profile, "utf8") : "";
	let profileNext = profileText;
	if (profileText.length > 0) {
		profileNext = profileText;
		if (profileNext.includes(MANAGED_BEGIN)) profileNext = profileNext.replace(readBlockText(profileNext), "").trimEnd().concat("\n");
		if (profileNext.includes(`- id: ${SELF_ID}`)) profileNext = profileNext.replace(SELF_ROW, "").replace(/\n{3,}/g, "\n\n").trimEnd().concat("\n");
		// never leave the profile layer as comments only: that is not a YAML array
		// and the harness would refuse to boot on the next start
		profileNext = ensurePatchArray(profileNext);
	}
	// profile first (never leave two blocks visible at once), then the home layer
	if (profileNext !== profileText) {
		try {
			writeFileInPlace(profile, profileNext);
		} catch {
			/* a read-only profile layer leaves the old block in place; the home layer still wins */
		}
	}
	let homeNext = existsSync(home) ? readFileSync(home, "utf8") : "";
	if (!homeNext.includes(`- id: ${SELF_ID}`)) {
		const header = ["# Harness-home patch layer (applied after each profile's own cordis.patch.yml).", "# Written by @dsh-external/dsh-client-ui-skin-manager; skins are managed", "# through 设置 → 皮肤, not by hand.", ""].join("\n");
		homeNext = `${homeNext.length > 0 ? `${homeNext.trimEnd()}\n` : ""}${header}${SELF_ROW}`;
		try {
			writeFileInPlace(home, homeNext);
		} catch {
			/* fall through: writeManagedBlock falls back to the profile layer */
		}
	}
	return writeManagedBlock(skins, state);
}

/**
 * Mount the manager: the state routes plus a boot-time reconcile that adopts
 * foreign wiring, moves this manager's own wiring into the home layer, and applies
 * the stored selection to the live loader.
 * @param ctx - the plugin context.
 */
function apply(ctx) {
	ctx.effect(
		() =>
			ctx.webServer.register({
				kind: "exact",
				path: STATE_ROUTE,
				handler: (req, res) => {
					handleStateRoute(ctx, req, res).catch((error) => sendJson(res, 500, { ok: false, message: String((error && error.message) || error) }));
				}
			}),
		"skin-manager: state route"
	);
	ctx.effect(() => ctx.webServer.register({ kind: "exact", path: PREVIEW_ROUTE, handler: handlePreviewRoute }), "skin-manager: preview route");
	queueMicrotask(() => {
		try {
			const marker = mountMarkerPath();
			mkdirSync(join(profileDir(), "data", SETTINGS_DIR), { recursive: true });
			writeFileSync(marker, `${JSON.stringify({ mountedAt: new Date().toISOString(), pid: process.pid, profile: profileName(), patchPath: patchPath(), homePatchPath: homePatchPath() }, null, 2)}\n`, "utf8");
		} catch {
			/* a read-only profile must not break the boot */
		}
		let skins = [];
		let state = readSettings();
		try {
			skins = discoverSkins(profileDir());
			state = readSettings();
			migrateLayers(skins, state);
		} catch {
			/* reconciliation is best effort */
		}
		// the composed tree may predate this reconcile: make the live loader match
		applyRuntimeSelection(ctx, skins, resolveActiveId(skins, state)).catch(() => {});
		refreshClientBundle(ctx);
	});
}

export {
	MANAGED_BEGIN,
	MANAGED_END,
	PROFILE_TEMPLATE,
	apply,
	declaredId,
	discoverSkins,
	ensurePatchArray,
	findBlockFile,
	homePatchPath,
	inject,
	loaderEntries,
	collectForeignWiring,
	migrateLayers,
	mountMarkerPath,
	name,
	parseBlockInserts,
	patchPath,
	planWiring,
	profileDir,
	readBlockText,
	readSettings,
	refreshClientBundle,
	renderManagedBlock,
	resolveActiveId,
	spliceBlock,
	writeManagedBlock,
	writeSettings
};
