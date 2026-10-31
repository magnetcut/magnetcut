// Agent mode end to end (docs/AUTOMATION.md), against the built app, as an
// MCP client such as Claude Code drives it: the app started with
// MAGNETCUT_AGENT_TEST_TOKEN and MAGNETCUT_AGENT_TEST_PORT; then a project
// made, a film imported onto its timeline, the summary read, a sheet of
// frames looked at, and the film exported, with its progress.
// bun apps/desktop/scripts/agent-check.ts <film> <export.mp4>
import { existsSync, statSync } from "node:fs";

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
for (const wanted of ["status", "project", "media", "summary", "describe", "look", "export"]) {
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
console.log("AGENT done");
