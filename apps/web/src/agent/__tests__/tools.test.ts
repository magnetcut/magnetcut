import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { TOOLS } from "../tools";
import type { ToolResult } from "../tools-base";
import { context, open, setUp, tearDown } from "./test-editor";

function tool({ name }: { name: string }) {
	const found = TOOLS.find((one) => one.name === name);
	if (!found) throw new Error(`no tool ${name}`);
	return found;
}

const textOf = ({ result }: { result: ToolResult }) =>
	result.content
		.map((part) => (part.type === "text" ? part.text : ""))
		.join("\n");

beforeAll(setUp);
afterAll(tearDown);

describe("while a project is opening", () => {
	test("summary waits for it, and status says so", async () => {
		const editor = open();
		Object.assign(editor.project, { loadedProjectId: null });
		await expect(
			tool({ name: "summary" }).run({ args: {}, context: context({ editor }) }),
		).rejects.toThrow("still opening");
		const status = await tool({ name: "status" }).run({
			args: {},
			context: context({ editor }),
		});
		expect(textOf({ result: status })).toContain('opening: "Test"');
	});
});

describe("opening a project", () => {
	test("one that loads with no scene is refused at once, not after a minute", async () => {
		const editor = open();
		Object.assign(editor.project, {
			savedProjects: [
				{
					id: "damaged",
					name: "Damaged",
					duration: 0,
					createdAt: new Date(0),
					updatedAt: new Date(0),
				},
			],
		});
		// There's no storage to list projects from in a test.
		const quiet = spyOn(console, "error").mockImplementation(() => {});
		// As the editor's page does with a project that has no scenes.
		const navigate = () => {
			editor.scenes.clearScenes();
			Object.assign(editor.project, { loadedProjectId: "damaged" });
		};
		try {
			await expect(
				tool({ name: "project" }).run({
					args: { action: "open", id: "damaged" },
					context: context({ editor, navigate }),
				}),
			).rejects.toThrow("no scenes");
		} finally {
			quiet.mockRestore();
		}
	});
});

describe("importing media", () => {
	test("a file that can't be read is said, not skipped", async () => {
		const editor = open();
		// The desktop app's side: it opens any path, as a file of 10 bytes.
		Object.defineProperty(globalThis, "window", {
			configurable: true,
			value: {
				__TAURI_INTERNALS__: {
					invoke: async (_command: string, args: { path: string }) => ({
						path: args.path,
						name: args.path.split("/").pop(),
						size: 10,
						lastModified: 0,
					}),
				},
			},
		});
		try {
			const result = await tool({ name: "media" }).run({
				args: { action: "import", paths: ["/films/notes.txt"] },
				context: context({ editor }),
			});
			expect(textOf({ result })).toBe(
				"! /films/notes.txt: not a film, picture or sound MagnetCut can read",
			);
		} finally {
			Reflect.deleteProperty(globalThis, "window");
		}
	});
});
