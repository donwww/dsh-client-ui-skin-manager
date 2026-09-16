/**
 * Generate a minimal but VALID skin package, for tests and for exercising the
 * installer's local-directory path.
 *
 * Usage: node test/fixtures/make-stub-skin.mjs <target-dir> <skin-id> [display-name]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [target, skinId, displayName] = process.argv.slice(2);
if (!target || !skinId) {
	console.error("usage: node test/fixtures/make-stub-skin.mjs <target-dir> <skin-id> [display-name]");
	process.exit(2);
}

const packageName = `@dsh-external/dsh-client-ui-skin-${skinId}`;
const name = displayName ?? skinId;

mkdirSync(join(target, "lib"), { recursive: true });
mkdirSync(join(target, "preview"), { recursive: true });

writeFileSync(
	join(target, "package.json"),
	`${JSON.stringify(
		{
			name: packageName,
			version: "1.0.0",
			private: true,
			type: "module",
			main: "lib/index.js",
			exports: { ".": "./lib/index.js", "./client": "./lib/client.js", "./skin.json": "./skin.json", "./package.json": "./package.json" },
			dsh: { client: { inject: [], platform: "web", immediately: true } }
		},
		null,
		2
	)}\n`
);

writeFileSync(
	join(target, "skin.json"),
	`${JSON.stringify(
		{
			id: skinId,
			name,
			author: "test-fixture",
			tagline: "由测试夹具生成的占位皮肤",
			package: packageName,
			wiring: { id: `ui-skin-${skinId}` },
			preview: { light: "preview/light.webp" },
			order: 100
		},
		null,
		2
	)}\n`
);

writeFileSync(
	join(target, "lib", "index.js"),
	`const name = "${packageName}";\nconst inject = [];\nfunction apply() {}\nexport { apply, inject, name };\n`
);

writeFileSync(
	join(target, "lib", "client.js"),
	`window.__ModuleLoader__.load({\n\tid: "${packageName}",\n\tfactory: () => {\n\t\tvar module = { exports: {} };\n\t\tObject.defineProperty(module.exports, Symbol.toStringTag, { value: "Module" });\n\t\tmodule.exports.apply = function apply() {};\n\t\tmodule.exports.inject = [];\n\t\treturn module.exports;\n\t}\n});\n`
);

writeFileSync(join(target, "preview", "light.webp"), Buffer.from([0x52, 0x49, 0x46, 0x46, 0x30, 0x30, 0x30, 0x30, 0x57, 0x45, 0x42, 0x50]));

console.log(`stub skin ready: ${target} (${packageName})`);
