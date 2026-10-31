// Agent mode end to end (docs/AUTOMATION.md), against the built app, as an
// MCP client such as Claude Code drives it: the app started with
// MAGNETCUT_AGENT_TEST_TOKEN and MAGNETCUT_AGENT_TEST_PORT; then a project
// made, a film imported onto its timeline, the summary read, a sheet of
// frames looked at, and the film exported, with its progress.
// bun apps/desktop/scripts/agent-check.ts <film> <export.mp4>
import { existsSync, statSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const [film, output] = process.argv.slice(2);
const token = process.env.MAGNETCUT_AGENT_TEST_TOKEN;
const port = process.env.MAGNETCUT_AGENT_TEST_PORT;
if (!film || !output || !token || !port) {
	console.error("usage: agent-check.ts <film> <export.mp4>, with the test token and port set");
	process.exit(2);
}
const url = `http://127.0.0.1:${port}/mcp`;
let nextId = 1;

type Message = {
	id?: number;
	method?: string;
	params?: Record<string, unknown>;
	result?: Record<string, unknown>;
	error?: { code: number; message: string };
};

/** A JSON-RPC request; the reply, and the notifications that came first. */
async function rpc({
	method,
	params = {},
	authorization = `Bearer ${token}`,
}: {
	method: string;
	params?: Record<string, unknown>;
	authorization?: string;
}): Promise<{ status: number; reply?: Message; notes: Message[] }> {
	const response = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			Authorization: authorization,
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
	});
	const body = await response.text();
	if (!response.ok) return { status: response.status, notes: [] };
	const messages: Message[] = (response.headers.get("content-type") ?? "").includes(
		"text/event-stream",
	)
		? body
				.split("\n")
				.filter((line) => line.startsWith("data: "))
				.map((line) => JSON.parse(line.slice(6)) as Message)
		: [JSON.parse(body) as Message];
	return {
		status: response.status,
		reply: messages.find((message) => message.id !== undefined),
		notes: messages.filter((message) => message.id === undefined),
	};
}

/** A tool's answer: its text and how many images; throws on a failure. */
async function tool({
	name,
	args = {},
}: {
	name: string;
	args?: Record<string, unknown>;
}): Promise<{ text: string; images: number; notes: Message[] }> {
	const { reply, notes } = await rpc({
		method: "tools/call",
		params: { name, arguments: args, _meta: { progressToken: `${name}-${nextId}` } },
	});
	const result = reply?.result as
		| { content: Array<{ type: string; text?: string }>; isError?: boolean }
		| undefined;
	if (!result) throw new Error(`${name}: ${JSON.stringify(reply?.error)}`);
	const text = result.content
		.filter((item) => item.type === "text")
		.map((item) => item.text)
		.join("\n");
	if (result.isError) throw new Error(`${name}: ${text}`);
	return {
		text,
		images: result.content.filter((item) => item.type === "image").length,
		notes,
	};
}

function report({ step, detail }: { step: string; detail: string }) {
	console.log(`AGENT ${step}: ${detail.replace(/\n/g, " / ")}`);
}

// The app takes a while to start, the editor longer.
let ready = false;
for (let tries = 0; tries < 180 && !ready; tries++) {
	try {
		const { status } = await rpc({ method: "initialize", params: { protocolVersion: "2025-06-18" } });
		ready = status === 200;
	} catch {}
	if (!ready) await Bun.sleep(1000);
}
if (!ready) throw new Error("the app never answered");

const refused = await rpc({ method: "initialize", authorization: "Bearer mc_wrong" });
if (refused.status !== 401) throw new Error(`a wrong token got ${refused.status}`);
report({ step: "refused", detail: "a wrong token gets 401" });

const init = await rpc({ method: "initialize", params: { protocolVersion: "2025-06-18" } });
report({ step: "initialize", detail: JSON.stringify(init.reply?.result?.serverInfo) });

const listed = await rpc({ method: "tools/list" });
const names = ((listed.reply?.result?.tools ?? []) as Array<{ name: string }>).map((t) => t.name);
for (const wanted of ["status", "project", "media", "summary", "describe", "edit", "undo", "look", "listen", "find", "export"]) {
	if (!names.includes(wanted)) throw new Error(`no ${wanted} tool: ${names.join(", ")}`);
}
const toolsSize = JSON.stringify(listed.reply?.result?.tools).length;
report({ step: "tools", detail: `${names.join(", ")} (${toolsSize} bytes)` });

const created = await tool({ name: "project", args: { action: "new", name: "Agent check" } });
report({ step: "project", detail: created.text });

const imported = await tool({ name: "media", args: { action: "import", paths: [film], add: true } });
if (!imported.text.startsWith("+ ")) throw new Error(`import: ${imported.text}`);
report({ step: "import", detail: imported.text });

const summary = await tool({ name: "summary" });
if (!/^V1 /m.test(summary.text)) throw new Error(`no clip on V1: ${summary.text}`);
report({ step: "summary", detail: `${summary.text} (${summary.text.length} characters)` });

const clip = /^V1 (\S+)/m.exec(summary.text)?.[1] ?? "";
const described = await tool({ name: "describe", args: { id: clip } });
report({ step: "describe", detail: described.text.split("\n")[0] });

const looked = await tool({ name: "look", args: { count: 4, width: 320 } });
if (looked.images !== 1) throw new Error(`look gave ${looked.images} images`);
report({ step: "look", detail: looked.text });

// Edits: a dry run changes nothing; a batch is one undo, and a stale rev is
// refused.
const rev = /rev (\w+)/.exec(summary.text)?.[1] ?? "";
const dry = await tool({
	name: "edit",
	args: { dryRun: true, rev, operations: [{ op: "cut", at: 0.1 }] },
});
const unchanged = await tool({ name: "summary" });
if (!dry.text.startsWith("would change") || unchanged.text !== summary.text) {
	throw new Error(`a dry run changed the project: ${dry.text}`);
}
report({ step: "dry run", detail: dry.text });
const edited = await tool({
	name: "edit",
	args: {
		rev,
		operations: [
			{ op: "cut", at: 0.1 },
			{ op: "transition", from: clip, duration: 0.05 },
			{ op: "text", text: "Hello", at: 0, to: 0.2 },
		],
	},
});
if (!/^\+ /m.test(edited.text) || !/cross-dissolve/.test(edited.text)) {
	throw new Error(`the batch didn't do what it said: ${edited.text}`);
}
report({ step: "edit", detail: edited.text });
const stale = await tool({
	name: "edit",
	args: { rev, operations: [{ op: "delete", ids: [clip] }] },
}).catch((error: Error) => error);
if (!(stale instanceof Error) || !/changed since/.test(stale.message)) {
	throw new Error("an edit planned on an old rev went through");
}
report({ step: "stale rev", detail: stale.message });
const undone = await tool({ name: "undo" });
const afterUndo = await tool({ name: "summary" });
if (afterUndo.text !== summary.text) {
	throw new Error(`one undo didn't undo the batch: ${afterUndo.text}`);
}
report({ step: "undo", detail: undone.text });
await tool({ name: "undo", args: { redo: true } });

const exported = await tool({ name: "export", args: { path: output, destination: "anything" } });
if (!existsSync(output) || statSync(output).size === 0) throw new Error(`no film at ${output}`);
report({
	step: "export",
	detail: `${exported.text}, ${statSync(output).size} bytes, ${exported.notes.length} progress notes`,
});

const again = await tool({ name: "export", args: { path: output } }).catch((error: Error) => error);
if (!(again instanceof Error) || !/already/.test(again.message)) {
	throw new Error("an export wrote over a file without being told to");
}
report({ step: "no overwrite", detail: again.message });
// The project as a file, opened again: the same tracks, clip for clip, its
// media found.
const tracksOf = (text: string) => text.split("\n").filter((line) => /^[VTAGE]\d/.test(line));
const saved = await tool({ name: "summary" });
const projectFile = output.replace(/\.mp4$/, ".magnetcut");
await tool({ name: "project", args: { action: "save", path: projectFile } });
if (!existsSync(projectFile)) throw new Error(`no project file at ${projectFile}`);
const reopened = await tool({ name: "project", args: { action: "open", path: projectFile } });
if (
	/missing/.test(reopened.text) ||
	JSON.stringify(tracksOf(reopened.text)) !== JSON.stringify(tracksOf(saved.text))
) {
	throw new Error(`the project file didn't open as it was: ${reopened.text} / saved: ${saved.text}`);
}
report({ step: "project file", detail: `saved and opened again: ${reopened.text}` });
const bars = await tool({ name: "find", args: { what: "blackbars" } });
report({ step: "black bars", detail: bars.text });

// Listening: a tone, a second of silence, the tone again, written here as a
// WAV: the silence found where it is, the tone at -20 LUFS, and the silence
// taken out with `remove`.
const wav = output.replace(/\.mp4$/, "-tone.wav");
{
	const rate = 48_000;
	const seconds = 3;
	const frames = rate * seconds;
	const data = Buffer.alloc(frames * 4);
	for (let i = 0; i < frames; i++) {
		const t = i / rate;
		const value = t >= 1 && t < 2 ? 0 : 0.1 * Math.sin(2 * Math.PI * 1000 * t);
		const sample = Math.round(value * 32767);
		data.writeInt16LE(sample, i * 4);
		data.writeInt16LE(sample, i * 4 + 2);
	}
	const header = Buffer.alloc(44);
	header.write("RIFF", 0);
	header.writeUInt32LE(36 + data.length, 4);
	header.write("WAVEfmt ", 8);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(2, 22);
	header.writeUInt32LE(rate, 24);
	header.writeUInt32LE(rate * 4, 28);
	header.writeUInt16LE(4, 32);
	header.writeUInt16LE(16, 34);
	header.write("data", 36);
	header.writeUInt32LE(data.length, 40);
	writeFileSync(wav, Buffer.concat([header, data]));
}
await tool({ name: "project", args: { action: "new", name: "Sound check" } });
await tool({ name: "media", args: { action: "import", paths: [wav], add: true } });
const silences = await tool({ name: "listen", args: { what: "silences" } });
const found = /(\d+\.\d+)-(\d+\.\d+)/.exec(silences.text);
if (!found || Math.abs(Number(found[1]) - 1) > 0.1 || Math.abs(Number(found[2]) - 2) > 0.1) {
	throw new Error(`the silence isn't where it is: ${silences.text}`);
}
report({ step: "silences", detail: silences.text });
const loudness = await tool({ name: "listen", args: { what: "loudness" } });
const lufs = Number(/(-?\d+\.\d) LUFS/.exec(loudness.text)?.[1]);
if (!(Math.abs(lufs + 20) < 1)) throw new Error(`the tone isn't -20 LUFS: ${loudness.text}`);
report({ step: "loudness", detail: loudness.text });
const removed = await tool({
	name: "edit",
	args: { operations: [{ op: "remove", ranges: [[Number(found[1]), Number(found[2])]] }] },
});
const shorter = await tool({ name: "summary" });
// The silence is found to a 50 ms window: 2 s left, give or take one.
if (!/ 0:02\.[01] rev/.test(shorter.text.split("\n")[0])) {
	throw new Error(`the silence wasn't taken out: ${shorter.text}`);
}
report({ step: "remove", detail: `${removed.text} / ${shorter.text.split("\n")[0]}` });
// Shots: a black picture, then a white one, written here as PNGs; the one
// cut found where they meet.
function png({ grey }: { grey: number }): Buffer {
	const [width, height] = [64, 36];
	const crcTable = Array.from({ length: 256 }, (_, n) => {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		return c >>> 0;
	});
	const crc = (bytes: Buffer) => {
		let c = 0xffffffff;
		for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
		return (c ^ 0xffffffff) >>> 0;
	};
	const chunk = (type: string, data: Buffer) => {
		const length = Buffer.alloc(4);
		length.writeUInt32BE(data.length);
		const body = Buffer.concat([Buffer.from(type), data]);
		const check = Buffer.alloc(4);
		check.writeUInt32BE(crc(body));
		return Buffer.concat([length, body, check]);
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header.writeUInt8(8, 8); // bit depth
	header.writeUInt8(2, 9); // RGB
	const rows = Buffer.alloc((width * 3 + 1) * height, grey);
	for (let y = 0; y < height; y++) rows[y * (width * 3 + 1)] = 0;
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(rows)),
		chunk("IEND", Buffer.alloc(0)),
	]);
}
const black = output.replace(/\.mp4$/, "-black.png");
const white = output.replace(/\.mp4$/, "-white.png");
writeFileSync(black, png({ grey: 10 }));
writeFileSync(white, png({ grey: 240 }));
await tool({ name: "project", args: { action: "new", name: "Shots check" } });
await tool({ name: "media", args: { action: "import", paths: [black, white], add: true } });
const shots = await tool({ name: "find", args: { what: "shots" } });
const cut = Number(/at (\d+\.\d+)/.exec(shots.text)?.[1]);
if (!/^1 cuts/.test(shots.text) || Math.abs(cut - 5) > 0.1) {
	throw new Error(`the cut isn't where the pictures meet: ${shots.text} / ${(await tool({ name: "summary" })).text}`);
}
report({ step: "shots", detail: shots.text });

// The command line: MCP on standard input and output through the app's own
// program, and one call.
const program = process.env.MAGNETCUT_PROGRAM;
if (program) {
	const env = {
		...process.env,
		MAGNETCUT_URL: url,
		MAGNETCUT_TOKEN: token,
	};
	const relay = Bun.spawn([program, "--mcp"], { env, stdin: "pipe", stdout: "pipe" });
	relay.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
	relay.stdin.end();
	const relayed = await new Response(relay.stdout).text();
	await relay.exited;
	if (!relayed.includes('"summary"')) throw new Error(`--mcp relayed: ${relayed.slice(0, 300)}`);
	report({ step: "--mcp", detail: `tools/list relayed, ${relayed.length} bytes` });
	const called = Bun.spawn([program, "call", "summary"], { env, stdout: "pipe" });
	const printed = await new Response(called.stdout).text();
	if ((await called.exited) !== 0 || !printed.startsWith('"Shots check"')) {
		throw new Error(`call summary printed: ${printed}`);
	}
	report({ step: "call", detail: printed.split("\n")[0] });
}
console.log("AGENT done");
