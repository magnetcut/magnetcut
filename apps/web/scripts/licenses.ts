/**
 * The licence check, and the third-party notices for what MagnetCut ships.
 *
 * Collects the Rust crates that the desktop app and the WebAssembly core are
 * built from (cargo metadata: normal dependencies, every platform) and the
 * JavaScript packages that the editor is bundled from (bun.lock, from
 * apps/web's dependencies), then:
 *
 * - fails if any is under a licence MagnetCut can't ship (GPL, LGPL, AGPL,
 *   SSPL, anything not listed in ALLOWED) without a permissive alternative;
 * - writes apps/web/public/acknowledgements.txt, which About shows: each
 *   package with the licence it's used under and that licence's text, as
 *   MIT, BSD and Apache require of a binary. Identical texts appear once.
 *
 * Run: bun run licenses             writes the file (from the root)
 *      bun run licenses --check     fails if it's out of date (CI)
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const ROOT = join(import.meta.dir, "../../..");
const OUTPUT = join(ROOT, "apps/web/public/acknowledgements.txt");

// What may ship, most preferred first: of alternatives, the earliest wins.
const ALLOWED = [
	"MIT",
	"MIT-0",
	"ISC",
	"0BSD",
	"BSD-2-Clause",
	"BSD-3-Clause",
	"Zlib",
	"Unlicense",
	"CC0-1.0",
	"BSL-1.0",
	"BlueOak-1.0.0",
	"Unicode-3.0",
	"Unicode-DFS-2016",
	"Apache-2.0",
	"Apache-2.0 WITH LLVM-exception",
	"CC-BY-4.0",
	"Python-2.0",
	"MPL-2.0",
];

// Packages in the lockfile's tree that never reach the bundle, and why.
// Besides these, any package for one system only (os or cpu in the lockfile):
// native binaries, which a browser bundle can't contain.
const NOT_SHIPPED: Array<{ pattern: RegExp; reason: string }> = [
	{
		pattern: /^(sharp|@img\/.*)$/,
		reason:
			"image processing in Node, for Next's image optimisation and transformers.js on a server; the static export and the browser use neither",
	},
];

interface Package {
	ecosystem: "rust" | "js";
	name: string;
	version: string;
	license: string;
	dir: string;
	authors: string[];
}

// ---- SPDX: which licences a package is used under -------------------------

type Expression =
	| { kind: "license"; id: string }
	| { kind: "and" | "or"; parts: Expression[] };

function parseSpdx({ text }: { text: string }): Expression {
	const tokens = text
		.replaceAll("/", " OR ")
		.replaceAll("(", " ( ")
		.replaceAll(")", " ) ")
		.split(/\s+/)
		.filter(Boolean);
	let at = 0;
	const parseOr = (): Expression => {
		const parts = [parseAnd()];
		while (tokens[at]?.toUpperCase() === "OR") {
			at++;
			parts.push(parseAnd());
		}
		return parts.length === 1 ? parts[0] : { kind: "or", parts };
	};
	const parseAnd = (): Expression => {
		const parts = [parseAtom()];
		while (tokens[at]?.toUpperCase() === "AND") {
			at++;
			parts.push(parseAtom());
		}
		return parts.length === 1 ? parts[0] : { kind: "and", parts };
	};
	const parseAtom = (): Expression => {
		if (tokens[at] === "(") {
			at++;
			const inner = parseOr();
			at++; // ")"
			return inner;
		}
		let id = tokens[at++] ?? "";
		if (tokens[at]?.toUpperCase() === "WITH") {
			id = `${id} WITH ${tokens[at + 1]}`;
			at += 2;
		}
		return { kind: "license", id: id.replace(/\+$/, "") };
	};
	return parseOr();
}

// The licences to use it under, or null if no alternative is allowed.
function elect({ expression }: { expression: Expression }): string[] | null {
	if (expression.kind === "license") {
		return ALLOWED.includes(expression.id) ? [expression.id] : null;
	}
	const choices = expression.parts.map((part) => elect({ expression: part }));
	if (expression.kind === "and") {
		return choices.every((choice) => choice !== null)
			? [...new Set(choices.flat() as string[])]
			: null;
	}
	const rank = (choice: string[]) =>
		Math.max(...choice.map((id) => ALLOWED.indexOf(id)));
	const allowed = choices.filter((choice) => choice !== null) as string[][];
	return allowed.sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

// ---- Licence files ----------------------------------------------------------

const LICENSE_FILE =
	/^(licen[cs]e|copying|unlicense|notice|copyright|third[-_]party)/i;

// Which licence a file holds: by its name, else by its words.
function classify({ name, text }: { name: string; text: string }): string {
	if (/notice|third[-_]party/i.test(name)) return "NOTICE";
	if (/mit/i.test(name)) return "MIT";
	if (/apache/i.test(name)) return "Apache-2.0";
	if (/zlib/i.test(name)) return "Zlib";
	if (/unlicense/i.test(name)) return "Unlicense";
	if (/bsd/i.test(name)) return "BSD";
	if (/Apache License,?\s+Version 2\.0/i.test(text)) return "Apache-2.0";
	if (/Permission is hereby granted, free of charge/i.test(text)) return "MIT";
	if (/free and unencumbered software/i.test(text)) return "Unlicense";
	if (/Redistribution and use in source and binary forms/i.test(text)) {
		return "BSD";
	}
	if (/Permission to use, copy, modify, and\/?or distribute/i.test(text)) {
		return "ISC";
	}
	if (/Mozilla Public License,? (v\. |version )?2\.0/i.test(text)) {
		return "MPL-2.0";
	}
	if (/altered source versions must be plainly marked/i.test(text)) {
		return "Zlib";
	}
	if (/UNICODE LICENSE/i.test(text)) return "Unicode";
	return "unknown";
}

// The licences a file's class stands for.
function covers({ file, licenses }: { file: string; licenses: string[] }) {
	if (file === "NOTICE") return true;
	return licenses.some(
		(id) =>
			id === file ||
			id.startsWith(`${file}-`) ||
			id.startsWith(`${file} `) ||
			(file === "BSD" && id.startsWith("BSD")) ||
			(file === "ISC" && (id === "ISC" || id === "0BSD")) ||
			(file === "Unicode" && id.startsWith("Unicode")),
	);
}

function licenseTexts({
	pkg,
	licenses,
}: {
	pkg: Package;
	licenses: string[];
}): string[] {
	const files = existsSync(pkg.dir)
		? readdirSync(pkg.dir).filter(
				(name) =>
					LICENSE_FILE.test(name) && statSync(join(pkg.dir, name)).isFile(),
			)
		: [];
	const classified = files.map((name) => {
		const text = readFileSync(join(pkg.dir, name), "utf8");
		return { name, text, file: classify({ name, text }) };
	});
	const chosen = classified.filter(
		({ file }) =>
			covers({ file, licenses }) ||
			// One licence and a file we can't place: it's that licence's.
			(file === "unknown" && licenses.length === 1),
	);
	if (chosen.some(({ file }) => file !== "NOTICE")) {
		return chosen.map(({ text }) => text);
	}
	// No text in the package: the licence's standard one.
	return [
		...licenses.map((id) => standardText({ id, pkg })),
		...chosen.map(({ text }) => text),
	];
}

const standardTexts = new Map<string, string>();

function standardText({ id, pkg }: { id: string; pkg: Package }): string {
	const holders = pkg.authors.length
		? pkg.authors.join(", ")
		: `the ${pkg.name} authors`;
	if (id === "MIT") {
		return `MIT License\n\nCopyright (c) ${holders}\n\n${MIT_BODY}`;
	}
	if (id === "ISC") {
		return `ISC License\n\nCopyright (c) ${holders}\n\n${ISC_BODY}`;
	}
	if (id === "BSD-3-Clause") {
		return `BSD 3-Clause License\n\nCopyright (c) ${holders}\n\n${BSD_3_BODY}`;
	}
	return (
		standardTexts.get(id) ??
		`Licensed under ${id}: https://spdx.org/licenses/${id}.html`
	);
}

const MIT_BODY = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

const ISC_BODY = `Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.`;

const BSD_3_BODY = `Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`;

// Where a package's source is published: the MPL asks that people be told.
function sourceUrl({ pkg }: { pkg: Package }): string {
	return pkg.ecosystem === "rust"
		? `https://crates.io/crates/${pkg.name}/${pkg.version}`
		: `https://www.npmjs.com/package/${pkg.name}/v/${pkg.version}`;
}

// ---- Rust: cargo metadata ----------------------------------------------------

interface CargoMetadata {
	packages: Array<{
		id: string;
		name: string;
		version: string;
		license: string | null;
		license_file: string | null;
		manifest_path: string;
		authors: string[];
	}>;
	workspace_members: string[];
	resolve: {
		nodes: Array<{
			id: string;
			deps: Array<{ pkg: string; dep_kinds: Array<{ kind: string | null }> }>;
		}>;
	};
}

function rustPackages(): Package[] {
	const result = Bun.spawnSync(
		["cargo", "metadata", "--format-version", "1", "--locked"],
		{ cwd: ROOT, stderr: "inherit" },
	);
	if (!result.success) throw new Error("cargo metadata failed");
	const metadata = JSON.parse(result.stdout.toString()) as CargoMetadata;
	const byId = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
	const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
	const workspace = new Set(metadata.workspace_members);

	// What the desktop app and the WebAssembly core link: normal dependencies
	// only (no build scripts' or tests').
	const shipped = new Set<string>();
	const stack = metadata.workspace_members.filter((id) =>
		["magnetcut", "magnetcut-wasm"].includes(byId.get(id)?.name ?? ""),
	);
	while (stack.length) {
		const id = stack.pop() as string;
		if (shipped.has(id)) continue;
		shipped.add(id);
		for (const dep of nodes.get(id)?.deps ?? []) {
			if (dep.dep_kinds.some(({ kind }) => kind === null)) stack.push(dep.pkg);
		}
	}

	return [...shipped]
		.filter((id) => !workspace.has(id))
		.map((id) => {
			const pkg = byId.get(id) as CargoMetadata["packages"][number];
			return {
				ecosystem: "rust" as const,
				name: pkg.name,
				version: pkg.version,
				license: pkg.license ?? "",
				dir: dirname(pkg.manifest_path),
				authors: pkg.authors.map((author) => author.replace(/\s*<.*>$/, "")),
			};
		});
}

// ---- JavaScript: bun.lock -------------------------------------------------------

type LockEntry = [
	string,
	string,
	{
		dependencies?: Record<string, string>;
		optionalDependencies?: Record<string, string>;
		os?: string | string[];
		cpu?: string | string[];
	},
	string?,
];

interface Lockfile {
	workspaces: Record<
		string,
		{ name?: string; dependencies?: Record<string, string> }
	>;
	packages: Record<string, LockEntry>;
}

function jsPackages(): { packages: Package[]; skipped: string[] } {
	// JSON with trailing commas.
	const text = readFileSync(join(ROOT, "bun.lock"), "utf8").replace(
		/,(\s*[}\]])/g,
		"$1",
	);
	const lock = JSON.parse(text) as Lockfile;
	const web = lock.workspaces["apps/web"];

	// A dependency resolves to the entry nested deepest under its dependant.
	const resolve = (path: string[], name: string): string[] | null => {
		for (let depth = path.length; depth >= 0; depth--) {
			const candidate = [...path.slice(0, depth), name];
			if (lock.packages[candidate.join("/")]) return candidate;
		}
		return null;
	};

	const found = new Map<string, Package>();
	const skipped = new Set<string>();
	const visited = new Set<string>();
	const visit = (path: string[], name: string) => {
		const key = resolve(path, name);
		if (!key) return;
		const keyString = key.join("/");
		if (visited.has(keyString)) return;
		visited.add(keyString);
		const [spec, , info] = lock.packages[keyString];
		if (spec.includes("@workspace:")) return;
		if (
			info.os ||
			info.cpu ||
			NOT_SHIPPED.some(({ pattern }) => pattern.test(name))
		) {
			skipped.add(name);
			return;
		}
		const version = spec.slice(spec.lastIndexOf("@") + 1);
		const id = `${name}@${version}`;
		if (!found.has(id)) {
			const dir = packageDir({ name, version });
			const manifest = dir
				? (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
						license?: string | { type: string };
						licenses?: Array<{ type: string }>;
						author?: string | { name: string };
					})
				: {};
			const license =
				typeof manifest.license === "string"
					? manifest.license
					: (manifest.license?.type ??
						manifest.licenses?.map(({ type }) => type).join(" OR ") ??
						"");
			const author =
				typeof manifest.author === "string"
					? manifest.author.replace(/\s*[<(].*$/, "")
					: manifest.author?.name;
			found.set(id, {
				ecosystem: "js",
				name,
				version,
				license,
				dir: dir ?? "",
				authors: author ? [author] : [],
			});
		}
		for (const dep of Object.keys({
			...info.dependencies,
			...info.optionalDependencies,
		})) {
			visit(key, dep);
		}
	};
	const webKey = [web.name ?? "@magnetcut/web"];
	for (const name of Object.keys(web.dependencies ?? {})) visit(webKey, name);
	return { packages: [...found.values()], skipped: [...skipped].sort() };
}

// bun's isolated installs: node_modules/.bun/<name, / as +>@<version>[+peers].
function packageDir({
	name,
	version,
}: {
	name: string;
	version: string;
}): string | null {
	const store = join(ROOT, "node_modules/.bun");
	const prefix = `${name.replace("/", "+")}@${version}`;
	const entry = readdirSync(store).find(
		(dir) => dir === prefix || dir.startsWith(`${prefix}+`),
	);
	return entry ? join(store, entry, "node_modules", name) : null;
}

// ---- The file ---------------------------------------------------------------

function normalise({ text }: { text: string }): string {
	return text
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function section({
	title,
	packages,
	problems,
}: {
	title: string;
	packages: Package[];
	problems: string[];
}): string {
	// Identical texts once, with every package under them.
	const groups = new Map<string, string[]>();
	for (const pkg of packages.sort((a, b) =>
		`${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`),
	)) {
		const licenses = elect({ expression: parseSpdx({ text: pkg.license }) });
		if (!pkg.license || !licenses) {
			problems.push(
				`${pkg.name} ${pkg.version}: ${pkg.license || "no licence"}`,
			);
			continue;
		}
		const texts = licenseTexts({ pkg, licenses }).map((part) =>
			normalise({ text: part }),
		);
		if (licenses.includes("MPL-2.0")) {
			texts.push(`Source: ${sourceUrl({ pkg })}`);
		}
		const text = texts.join("\n\n");
		const line = `${pkg.name} ${pkg.version} (${licenses.join(" AND ")})`;
		groups.set(text, [...(groups.get(text) ?? []), line]);
	}
	const rule = "-".repeat(78);
	const blocks = [...groups].map(
		([text, names]) => `${names.join("\n")}\n\n${text}`,
	);
	return `${title}\n${"=".repeat(title.length)}\n\n${blocks.join(`\n\n${rule}\n\n`)}`;
}

function header(): string {
	const opencut = normalise({
		text: readFileSync(join(ROOT, "licenses/OpenCut.txt"), "utf8"),
	});
	return `Acknowledgements
================

MagnetCut is free software under the GNU Affero General Public License 3.0.
Its source: https://github.com/magnetcut/magnetcut

It's based on OpenCut, whose code is used under this licence:

${opencut}

And it's built from the open-source packages below, each under the licence
named after it. Written by apps/web/scripts/licenses.ts.`;
}

async function main() {
	// Standard texts for packages that ship none, taken from ones that do.
	const rust = rustPackages();
	const { packages: js, skipped } = jsPackages();
	for (const pkg of [...rust, ...js]) {
		if (!existsSync(pkg.dir)) continue;
		for (const name of readdirSync(pkg.dir)) {
			if (!LICENSE_FILE.test(name) || !statSync(join(pkg.dir, name)).isFile()) {
				continue;
			}
			const text = readFileSync(join(pkg.dir, name), "utf8");
			const file = classify({ name, text });
			if (
				file === "Apache-2.0" &&
				/TERMS AND CONDITIONS/.test(text) &&
				!standardTexts.has("Apache-2.0")
			) {
				standardTexts.set("Apache-2.0", text);
			}
			if (
				/UNICODE LICENSE V3/i.test(text) &&
				!standardTexts.has("Unicode-3.0")
			) {
				standardTexts.set("Unicode-3.0", text);
			}
		}
	}

	const problems: string[] = [];
	const content = `${[
		header(),
		section({ title: "Rust crates", packages: rust, problems }),
		section({ title: "JavaScript packages", packages: js, problems }),
	].join("\n\n\n")}\n`;

	if (problems.length) {
		console.error(
			`Not allowed, or no licence found:\n  ${problems.join("\n  ")}`,
		);
		process.exit(1);
	}
	console.log(
		`${rust.length} Rust crates, ${js.length} JavaScript packages` +
			(skipped.length ? `; not shipped: ${skipped.join(", ")}` : ""),
	);

	if (process.argv.includes("--check")) {
		const current = existsSync(OUTPUT) ? readFileSync(OUTPUT, "utf8") : "";
		if (current !== content) {
			console.error(
				"apps/web/public/acknowledgements.txt is out of date: bun run licenses",
			);
			process.exit(1);
		}
		return;
	}
	await writeFile(OUTPUT, content);
	console.log(`apps/web/public/acknowledgements.txt: ${content.length} bytes`);
}

await main();
