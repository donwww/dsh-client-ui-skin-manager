/**
 * Publish this package to GitHub through the REST API — no `git` required.
 *
 * Creates the repository when it does not exist, uploads every publishable file
 * (skipping `.git`, `node_modules`, and anything the local `.gitignore` names), and
 * substitutes the real `owner/repo` into `package.json`'s repository fields on the
 * way up. Re-running updates the files it uploaded before.
 *
 * The token is read from the environment and never printed:
 *
 *   GITHUB_TOKEN=... node tools/publish-github.mjs <owner>/<repo> [options]
 *
 * Options:
 *   --dir <path>        package directory to upload (default: the repository root)
 *   --private           create the repository private (default: public)
 *   --description <s>   repository description (default: the package description)
 *   --branch <name>     branch to commit to (default: the repository default branch)
 *   --dry-run           list what would be uploaded; no API writes
 *
 * Required token scope: classic `repo`, or a fine-grained token with
 * "Contents: read and write" (plus "Administration: write" when it must create
 * the repository) for the target owner.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { get, request } from "node:https";
import { join, relative, resolve } from "node:path";

const SKIP_DIRECTORIES = new Set([".git", "node_modules", ".harness-home", "tmp"]);
const PLACEHOLDER = "OWNER/REPO";

/** Parse argv into one target plus options. */
function parseArgs(argv) {
	const options = { target: undefined, dir: process.cwd(), private: false, description: undefined, branch: undefined, dryRun: false };
	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index];
		if (token === "--dir") options.dir = argv[++index];
		else if (token === "--private") options.private = true;
		else if (token === "--description") options.description = argv[++index];
		else if (token === "--branch") options.branch = argv[++index];
		else if (token === "--dry-run") options.dryRun = true;
		else if (token.startsWith("--")) throw new Error(`unknown option ${token}`);
		else if (options.target === undefined) options.target = token;
		else throw new Error(`unexpected argument ${token}`);
	}
	return options;
}

const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

/** One GitHub API call; returns { status, body }. */
function api(method, path, body) {
	return new Promise((resolvePromise, reject) => {
		const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");
		const request_ = request(
			{
				method,
				hostname: "api.github.com",
				path,
				headers: {
					"user-agent": "dsh-skin-manager-publisher",
					accept: "application/vnd.github+json",
					"x-github-api-version": "2022-11-28",
					...(token ? { authorization: `Bearer ${token}` } : {}),
					...(payload ? { "content-type": "application/json", "content-length": payload.length } : {})
				}
			},
			(response) => {
				const chunks = [];
				response.on("data", (chunk) => chunks.push(chunk));
				response.on("end", () => {
					const text = Buffer.concat(chunks).toString("utf8");
					let parsed;
					try {
						parsed = text.length > 0 ? JSON.parse(text) : undefined;
					} catch {
						parsed = undefined;
					}
					resolvePromise({ status: response.statusCode ?? 0, body: parsed, text });
				});
			}
		);
		request_.on("error", reject);
		if (payload) request_.write(payload);
		request_.end();
	});
}

/** Every publishable file, as POSIX-style paths relative to the package dir. */
function collectFiles(root) {
	const files = [];
	const ignored = readIgnore(join(root, ".gitignore"));
	const walk = (directory) => {
		for (const name of readdirSync(directory)) {
			const full = join(directory, name);
			const stats = statSync(full);
			if (stats.isDirectory()) {
				if (SKIP_DIRECTORIES.has(name)) continue;
				walk(full);
				continue;
			}
			const relativePath = relative(root, full).split("\\").join("/");
			if (ignored.some((pattern) => matches(relativePath, pattern))) continue;
			files.push({ path: relativePath, file: full });
		}
	};
	walk(root);
	return files.sort((left, right) => left.path.localeCompare(right.path));
}

/** Minimal `.gitignore` support: blank lines, comments, `dir/`, and `*` globs. */
function readIgnore(path) {
	try {
		return readFileSync(path, "utf8")
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0 && !line.startsWith("#") && !line.startsWith("!"))
			.map((line) => line.replace(/\/$/, ""));
	} catch {
		return [];
	}
}

function matches(path, pattern) {
	const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
	return new RegExp(`^${escaped}$`).test(path) || new RegExp(`(^|/)${escaped}$`).test(path);
}

async function ensureRepository(owner, repo, options, log) {
	const existing = await api("GET", `/repos/${owner}/${repo}`);
	if (existing.status === 200) {
		log(`repository exists: ${existing.body.html_url} (${existing.body.private ? "private" : "public"})`);
		return { defaultBranch: existing.body.default_branch ?? "main", created: false };
	}
	if (existing.status !== 404) throw new Error(`cannot read ${owner}/${repo}: HTTP ${existing.status} ${existing.text.slice(0, 200)}`);
	const me = await api("GET", "/user");
	if (me.status !== 200) throw new Error(`token rejected: HTTP ${me.status}`);
	const login = me.body.login;
	const description = options.description ?? JSON.parse(readFileSync(join(options.dir, "package.json"), "utf8")).description;
	const createPath = login.toLowerCase() === owner.toLowerCase() ? "/user/repos" : `/orgs/${owner}/repos`;
	const created = await api("POST", createPath, { name: repo, description, private: options.private, auto_init: true });
	if (created.status !== 201) throw new Error(`cannot create ${owner}/${repo}: HTTP ${created.status} ${created.text.slice(0, 300)}`);
	log(`repository created: ${created.body.html_url} (${created.body.private ? "private" : "public"})`);
	return { defaultBranch: created.body.default_branch ?? "main", created: true };
}

async function uploadFile(owner, repo, branch, entry, ownerName, repoName, log) {
	let bytes = readFileSync(entry.file);
	if (entry.path === "package.json") {
		const text = bytes.toString("utf8").split(PLACEHOLDER).join(`${ownerName}/${repoName}`);
		bytes = Buffer.from(text, "utf8");
	}
	const base = `/repos/${owner}/${repo}/contents/${entry.path.split("/").map(encodeURIComponent).join("/")}`;
	const head = await api("GET", `${base}?ref=${encodeURIComponent(branch)}`);
	const body = {
		message: `chore: publish ${entry.path}`,
		content: bytes.toString("base64"),
		branch,
		...(head.status === 200 && head.body?.sha ? { sha: head.body.sha } : {})
	};
	const put = await api("PUT", base, body);
	if (put.status !== 200 && put.status !== 201) throw new Error(`upload failed for ${entry.path}: HTTP ${put.status} ${put.text.slice(0, 200)}`);
	log(`uploaded ${entry.path} (${(bytes.length / 1024).toFixed(1)} KB)`);
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.target === undefined || !/^[^/\s]+\/[^/\s]+$/.test(options.target)) {
		console.error("usage: GITHUB_TOKEN=... node tools/publish-github.mjs <owner>/<repo> [--dir <path>] [--private] [--description <text>] [--branch <name>] [--dry-run]");
		process.exit(2);
	}
	const [owner, repo] = options.target.split("/");
	const dir = resolve(options.dir);
	const files = collectFiles(dir);
	const log = (message) => console.log(message);

	if (files.length === 0) {
		console.error(`nothing to upload in ${dir}`);
		process.exit(1);
	}
	log(`package : ${dir}`);
	log(`target  : ${owner}/${repo}${options.private ? " (private)" : " (public)"}`);
	log(`files   : ${files.length}`);
	for (const entry of files) log(`  - ${entry.path}`);

	if (options.dryRun) {
		log("dry run : no API writes");
		return;
	}
	if (!token) {
		console.error("GITHUB_TOKEN (or GH_TOKEN) is not set; refusing to continue");
		process.exit(2);
	}

	const { defaultBranch } = await ensureRepository(owner, repo, options, log);
	const branch = options.branch ?? defaultBranch;
	log(`branch  : ${branch}`);
	for (const entry of files) await uploadFile(owner, repo, branch, entry, owner, repo, log);

	const topics = await api("PUT", `/repos/${owner}/${repo}/topics`, { names: ["dsh", "deepseek-harness", "skin", "theme", "web-gui", "cordis-plugin"] });
	log(topics.status === 200 ? "topics  : set" : `topics  : skipped (HTTP ${topics.status})`);
	log("");
	log(`done    : https://github.com/${owner}/${repo}`);
}

main().catch((error) => {
	console.error(`publish failed: ${error?.message ?? error}`);
	process.exit(1);
});
