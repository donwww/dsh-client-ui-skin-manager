/**
 * One-command skin installer for DSH profiles.
 *
 * Takes a GitHub repository (URL or `owner/repo`) or a local directory, puts the
 * skin package into the profile's `node_modules`, applies the route-disposal
 * compatibility shim when the skin needs it, and only writes loader wiring itself
 * when the skin manager is NOT installed (the manager owns wiring otherwise).
 *
 * Pure Node: no `git`, no `unzip`, no child processes — GitHub sources are fetched
 * through the API + raw endpoints, so it also works inside a restricted sandbox.
 *
 * Usage:
 *   node tools/install-skin.mjs <github-url | owner/repo | local-dir> [options]
 *
 * Options:
 *   --ref <branch|tag>  GitHub ref to download (default: the repository default branch)
 *   --name <package>    force the package name (default: from the skin's own manifest)
 *   --no-wire           never touch patch layers, even when no skin manager is installed
 *   --dry-run           resolve the source and print the plan without downloading or writing
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { get } from "node:https";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { inflateRawSync } from "node:zlib";

import { patchSkinDispose } from "./patch-skin-dispose.mjs";

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MANAGED_BEGIN = "# === dsh-skin-manager:begin";
const MANAGED_END = "# === dsh-skin-manager:end ===";

/** Parse argv into one source plus options. */
function parseArgs(argv) {
	const options = { source: undefined, ref: undefined, name: undefined, noWire: false, dryRun: false };
	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index];
		if (token === "--ref") options.ref = argv[++index];
		else if (token === "--name") options.name = argv[++index];
		else if (token === "--no-wire") options.noWire = true;
		else if (token === "--dry-run") options.dryRun = true;
		else if (token.startsWith("--")) throw new Error(`unknown option ${token}`);
		else if (options.source === undefined) options.source = token;
		else throw new Error(`unexpected argument ${token}`);
	}
	return options;
}

/** Follow redirects and return the whole body as a Buffer, retrying transient failures. */
function fetchBuffer(url, redirects = 5, attempt = 0) {
	return new Promise((resolvePromise, reject) => {
		const headers = { "user-agent": "dsh-skin-installer", accept: "application/vnd.github+json" };
		if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
		get(url, { headers }, (response) => {
			const status = response.statusCode ?? 0;
			if (status >= 300 && status < 400 && response.headers.location) {
				response.resume();
				if (redirects <= 0) return reject(new Error(`too many redirects for ${url}`));
				return resolvePromise(fetchBuffer(new URL(response.headers.location, url).href, redirects - 1, attempt));
			}
			if (status !== 200) {
				response.resume();
				const error = new Error(`HTTP ${status} for ${url}`);
				if (status >= 500 && attempt < 3) return void setTimeout(() => resolvePromise(fetchBuffer(url, redirects, attempt + 1)), 400 * (attempt + 1));
				return reject(error);
			}
			const chunks = [];
			response.on("data", (chunk) => chunks.push(chunk));
			response.on("end", () => resolvePromise(Buffer.concat(chunks)));
		}).on("error", (error) => {
			if (attempt < 3) {
				setTimeout(() => resolvePromise(fetchBuffer(url, redirects, attempt + 1)), 400 * (attempt + 1));
				return;
			}
			reject(error);
		});
	});
}

/** Recognize a GitHub source (`owner/repo`, optionally a full URL). */
function parseGitHub(source) {
	const match = /^(?:https?:\/\/github\.com\/)?([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/?$/i.exec(source.trim());
	if (match === null) return undefined;
	const [, owner, repo] = match;
	if (owner.startsWith(".") || owner.includes(":")) return undefined;
	return { owner, repo };
}

/** Download a whole repository tree through the API (no git, no archive). */
async function downloadViaBlobs(owner, repo, ref, destination, log) {
	const info = JSON.parse((await fetchBuffer(`https://api.github.com/repos/${owner}/${repo}`)).toString("utf8"));
	const branch = ref ?? info.default_branch ?? "main";
	const tree = JSON.parse((await fetchBuffer(`https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`)).toString("utf8"));
	const blobs = Array.isArray(tree.tree) ? tree.tree.filter((node) => node.type === "blob") : [];
	if (blobs.length === 0) throw new Error(`no files found in ${owner}/${repo}@${branch}`);
	if (blobs.length > 200) throw new Error(`refusing to download ${blobs.length} files — is this really a skin package?`);
	let total = 0;
	for (const node of blobs) {
		const relative = String(node.path);
		// The blob endpoint carries the bytes inline (base64); raw.githubusercontent is
		// avoided on purpose, because it is blocked on some networks while the API works.
		const payload = JSON.parse((await fetchBuffer(`https://api.github.com/repos/${owner}/${repo}/git/blobs/${node.sha}`)).toString("utf8"));
		if (payload.encoding !== "base64" || typeof payload.content !== "string") throw new Error(`unexpected blob payload for ${relative}`);
		const data = Buffer.from(payload.content.replace(/\s+/g, ""), "base64");
		if (data.length > MAX_FILE_BYTES) throw new Error(`${relative} is larger than ${MAX_FILE_BYTES} bytes`);
		total += data.length;
		if (total > MAX_TOTAL_BYTES) throw new Error(`download exceeds ${MAX_TOTAL_BYTES} bytes`);
		const target = join(destination, ...relative.split("/"));
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, data);
	}
	log(`downloaded ${blobs.length} files (${(total / 1048576).toFixed(2)} MB) from ${owner}/${repo}@${branch} via the blob API`);
}

/** Locate the end-of-central-directory record of a zip buffer. */
function findEndOfCentralDirectory(buffer) {
	const earliest = Math.max(0, buffer.length - 22 - 65535);
	for (let offset = buffer.length - 22; offset >= earliest; offset -= 1) {
		if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
	}
	return -1;
}

/** Read one zip entry's bytes (stored or deflated); entries carry sizes centrally. */
function readZipEntry(buffer, entry) {
	const local = entry.localOffset;
	if (buffer.readUInt32LE(local) !== 0x04034b50) throw new Error(`corrupt zip local header for ${entry.name}`);
	const nameLength = buffer.readUInt16LE(local + 26);
	const extraLength = buffer.readUInt16LE(local + 28);
	const start = local + 30 + nameLength + extraLength;
	let size = entry.compressedSize;
	if (size === 0 && buffer.length > start) {
		// streamed entry without a central size: run to the next signature
		let cursor = start;
		while (cursor + 4 <= buffer.length) {
			const signature = buffer.readUInt32LE(cursor);
			if (signature === 0x04034b50 || signature === 0x02014b50 || signature === 0x06054b50) break;
			cursor += 1;
		}
		size = cursor - start;
	}
	const data = buffer.subarray(start, start + size);
	if (entry.compression === 0) return Buffer.from(data);
	if (entry.compression === 8) return inflateRawSync(data);
	throw new Error(`unsupported zip compression method ${entry.compression} for ${entry.name}`);
}

/** Extract a zip buffer, optionally dropping the archive's leading directory. */
function unzipTo(buffer, destination, stripFirstSegment) {
	const eocd = findEndOfCentralDirectory(buffer);
	if (eocd < 0) throw new Error("not a zip archive");
	const count = buffer.readUInt16LE(eocd + 10);
	let offset = buffer.readUInt32LE(eocd + 16);
	let files = 0;
	for (let index = 0; index < count; index += 1) {
		if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("corrupt zip central directory");
		const entry = {
			name: buffer.toString("utf8", offset + 46, offset + 46 + buffer.readUInt16LE(offset + 28)),
			compression: buffer.readUInt16LE(offset + 10),
			compressedSize: buffer.readUInt32LE(offset + 20),
			localOffset: buffer.readUInt32LE(offset + 42)
		};
		offset += 46 + buffer.readUInt16LE(offset + 28) + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32);
		const segments = entry.name.split("/").filter((segment) => segment.length > 0);
		const relative = stripFirstSegment ? segments.slice(1) : segments;
		if (relative.length === 0) continue;
		const target = join(destination, ...relative);
		if (entry.name.endsWith("/")) {
			mkdirSync(target, { recursive: true });
			continue;
		}
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, readZipEntry(buffer, entry));
		files += 1;
	}
	return files;
}

/** Download the repository archive (codeload) and extract it; no external unzip needed. */
async function downloadViaZip(owner, repo, ref, destination, log) {
	let branch = ref;
	if (branch === undefined) {
		const info = JSON.parse((await fetchBuffer(`https://api.github.com/repos/${owner}/${repo}`)).toString("utf8"));
		branch = info.default_branch ?? "main";
	}
	const candidates = [`https://codeload.github.com/${owner}/${repo}/zip/refs/heads/${encodeURIComponent(branch)}`, `https://codeload.github.com/${owner}/${repo}/zip/refs/tags/${encodeURIComponent(branch)}`];
	let archive;
	let lastError;
	for (const url of candidates) {
		try {
			archive = await fetchBuffer(url);
			break;
		} catch (error) {
			lastError = error;
		}
	}
	if (archive === undefined) throw new Error(`archive download failed: ${lastError?.message || lastError}`);
	const files = unzipTo(archive, destination, true);
	if (files === 0) throw new Error("the archive contained no files");
	log(`downloaded ${files} files (${(archive.length / 1048576).toFixed(2)} MB) from ${owner}/${repo}@${branch} via the repository archive`);
}

/** Download a repository, preferring the archive and falling back to the blob API. */
async function downloadGitHub(owner, repo, ref, destination, log) {
	try {
		await downloadViaZip(owner, repo, ref, destination, log);
		return;
	} catch (error) {
		log(`archive download failed (${error?.message || error}); falling back to the blob API`);
		rmSync(destination, { recursive: true, force: true });
		mkdirSync(destination, { recursive: true });
	}
	await downloadViaBlobs(owner, repo, ref, destination, log);
}

/** Find the package root inside a downloaded tree (root, or one to two levels down). */
function findPackageRoot(directory) {
	const hasManifest = (dir) => existsSync(join(dir, "package.json")) || existsSync(join(dir, "skin.json"));
	if (hasManifest(directory)) return directory;
	for (const first of readdirSync(directory)) {
		if (first.startsWith(".")) continue;
		const firstPath = join(directory, first);
		if (!statSync(firstPath).isDirectory()) continue;
		if (hasManifest(firstPath)) return firstPath;
		for (const second of readdirSync(firstPath)) {
			if (second.startsWith(".")) continue;
			const secondPath = join(firstPath, second);
			if (statSync(secondPath).isDirectory() && hasManifest(secondPath)) return secondPath;
		}
	}
	return undefined;
}

/** Read the package name the manifest declares (BOM-tolerant). */
function readManifest(packageRoot) {
	const readJson = (path) => {
		try {
			const text = readFileSync(path, "utf8");
			return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
		} catch {
			return undefined;
		}
	};
	const manifest = readJson(join(packageRoot, "package.json"));
	const skin = readJson(join(packageRoot, "skin.json"));
	return { manifest, skin };
}

/** Copy a package tree into the profile, replacing a previous install of the same name. */
function placePackage(packageRoot, targetDir, log) {
	mkdirSync(dirname(targetDir), { recursive: true });
	if (existsSync(targetDir)) {
		log(`replacing the existing install at ${targetDir}`);
		rmSync(targetDir, { recursive: true, force: true });
	}
	mkdirSync(targetDir, { recursive: true });
	const copy = (from, to) => {
		for (const entry of readdirSync(from)) {
			if (entry === "node_modules") continue;
			const source = join(from, entry);
			const destination = join(to, entry);
			if (statSync(source).isDirectory()) {
				mkdirSync(destination, { recursive: true });
				copy(source, destination);
			} else {
				writeFileSync(destination, readFileSync(source));
			}
		}
	};
	copy(packageRoot, targetDir);
}

/** True when the skin manager is installed in this profile or wired in a patch layer. */
function managerInstalled(profile, home) {
	if (existsSync(join(profile, "node_modules", "@dsh-external", "dsh-client-ui-skin-manager"))) return true;
	for (const path of [join(home, "cordis.patch.yml"), join(profile, "cordis.patch.yml")]) {
		try {
			if (existsSync(path) && readFileSync(path, "utf8").includes("ui-skin-manager")) return true;
		} catch {
			/* unreadable layer: assume not wired there */
		}
	}
	return false;
}

/**
 * Wire one skin into the PROFILE patch layer (only used when no skin manager owns
 * the wiring). Replaces a bare `[]` root so the file stays a valid YAML array.
 */
function wireInProfile(patchPath, entryId, packageName) {
	const current = existsSync(patchPath) ? readFileSync(patchPath, "utf8") : "[]\n";
	if (current.includes(entryId) || current.includes(MANAGED_BEGIN)) return { changed: false, reason: "already referenced or managed" };
	const rows = `- insert:\n    - id: ${entryId}\n      name: '${packageName}'\n- id: ${entryId}\n  disabled: false\n`;
	const body = current
		.split("\n")
		.filter((line) => line.trim() !== "[]")
		.join("\n")
		.trimEnd();
	writeFileSync(patchPath, `${body.length > 0 ? `${body}\n` : ""}${rows}`, "utf8");
	return { changed: true, reason: "inserted" };
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.source === undefined) {
		console.error("usage: node tools/install-skin.mjs <github-url | owner/repo | local-dir> [--ref <branch>] [--name <package>] [--no-wire] [--dry-run]");
		process.exit(2);
	}

	const home = process.env.DSH_HOME || join(homedir(), ".dsh");
	const profileName = process.env.DSH_DESKTOP_PROFILE && /^[A-Za-z0-9_-]+$/.test(process.env.DSH_DESKTOP_PROFILE) ? process.env.DSH_DESKTOP_PROFILE : "web";
	const profile = join(home, "profiles", profileName);
	const stage = join(profile, "node_modules", ".skin-install-stage");
	const log = (message) => console.log(message);

	if (!existsSync(profile)) {
		console.error(`profile directory not found: ${profile}`);
		process.exit(1);
	}
	log(`home    : ${home}`);
	log(`profile : ${profile}`);

	const github = parseGitHub(String(options.source));
	const local = github === undefined ? resolve(String(options.source)) : undefined;

	// --- resolve the source into a staging directory -------------------------
	let packageRoot;
	if (local !== undefined) {
		if (!existsSync(local) || !statSync(local).isDirectory()) {
			console.error(`local source is not a directory: ${local}`);
			process.exit(1);
		}
		packageRoot = findPackageRoot(local);
		if (packageRoot === undefined) {
			console.error(`no package.json / skin.json found in ${local}`);
			process.exit(1);
		}
		log(`source  : ${local}`);
	} else {
		log(`source  : github.com/${github.owner}/${github.repo}${options.ref ? `@${options.ref}` : ""}`);
		if (options.dryRun) {
			log("dry run : would download the repository and install its package into the profile");
			log("target  : resolved from the package manifest after the download");
			return;
		}
		rmSync(stage, { recursive: true, force: true });
		mkdirSync(stage, { recursive: true });
		try {
			await downloadGitHub(github.owner, github.repo, options.ref, stage, log);
			packageRoot = findPackageRoot(stage);
			if (packageRoot === undefined) throw new Error("the repository contains no package.json / skin.json");
		} catch (error) {
			rmSync(stage, { recursive: true, force: true });
			console.error(`download failed: ${error.message}`);
			process.exit(1);
		}
	}

	const { manifest, skin } = readManifest(packageRoot);
	const packageName = options.name ?? (typeof manifest?.name === "string" ? manifest.name : undefined) ?? (typeof skin?.package === "string" ? skin.package : undefined);
	if (packageName === undefined) {
		console.error("cannot determine the package name (no package.json name and no skin.json package)");
		process.exit(1);
	}
	const skinId = typeof skin?.id === "string" ? skin.id : basename(packageRoot);
	const entryId = typeof skin?.wiring?.id === "string" ? skin.wiring.id : `ui-skin-${skinId}`;
	const targetDir = join(profile, "node_modules", ...packageName.split("/"));
	const isSkin = skin !== undefined && existsSync(join(packageRoot, "skin.json"));

	log(`package : ${packageName}`);
	log(`skin    : ${isSkin ? `${skinId} (${skin.name ?? skinId})` : "not a skin package (no skin.json)"}`);
	log(`entry   : ${entryId}`);
	log(`target  : ${targetDir}`);

	if (options.dryRun) {
		log("dry run : nothing written");
		return;
	}

	// --- install ------------------------------------------------------------
	placePackage(packageRoot, targetDir, log);
	if (packageRoot !== local && packageRoot.startsWith(stage)) rmSync(stage, { recursive: true, force: true });
	log(`installed`);

	const shim = patchSkinDispose(targetDir);
	log(`shim    : ${shim}${shim === "unsupported" ? " (review the skin's lib/index.js by hand)" : ""}`);

	// --- wiring -------------------------------------------------------------
	const managed = managerInstalled(profile, home);
	if (managed) {
		log("wiring  : the skin manager owns the wiring — it will adopt this package itself");
	} else if (options.noWire) {
		log("wiring  : skipped (--no-wire)");
	} else {
		const result = wireInProfile(join(profile, "cordis.patch.yml"), entryId, packageName);
		log(`wiring  : ${result.reason} in the profile patch layer`);
	}

	log("");
	log("next    : " + (managed ? "refresh the GUI page and pick it in 设置 → 皮肤 (if the row says 未接入, restart DSH once so the loader mounts it)" : "restart DSH, then open 设置 → 皮肤"));
	log(`verify  : GET http://127.0.0.1:3080/api/dsh-skin-manager/state  (loopback needs no token)`);
}

main().catch((error) => {
	console.error(`install-skin failed: ${error?.message ?? error}`);
	process.exit(1);
});
