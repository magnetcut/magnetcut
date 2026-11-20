import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { EditorCore } from "@/core";
import type { DiskFileInfo } from "@/media/disk-file";
import type { importMediaFiles } from "@/media/import";
import { openOpenedFiles, projectNameFor } from "../opened-files";

// What the desktop app would answer: the files opened with it, once.
let opened: DiskFileInfo[] = [];
let projects: Array<{ path: string; text: string }> = [];
const globals = globalThis as Record<string, unknown>;
beforeAll(() => {
	globals.window ??= globalThis;
	globals.isTauri = true;
	globals.__TAURI_INTERNALS__ = {
		invoke: (command: string) =>
			Promise.resolve().then(() => {
				if (command !== "take_opened_files") {
					throw new Error(`unexpected command ${command}`);
				}
				const taken = { media: opened, projects, unreadable: [] };
				opened = [];
				projects = [];
				return taken;
			}),
	};
});
afterAll(() => {
	delete globals.isTauri;
	delete globals.__TAURI_INTERNALS__;
	delete globals.location;
});

const trip: DiskFileInfo = {
	path: "/Movies/Trip.mov",
	name: "Trip.mov",
	size: 10,
	lastModified: 0,
};

/** An editor with only what opening files reads, `open` the project open. */
function makeEditor({ open }: { open: string | null }) {
	const made: string[] = [];
	const editor = {
		project: {
			getActiveOrNull: () => (open ? { metadata: { id: open } } : null),
			createNewProject: async ({ name }: { name: string }) => {
				made.push(name);
				open = "new";
				return "new";
			},
		},
	};
	const imported: Array<{ project: string | null; paths: string[] }> = [];
	const importFiles: typeof importMediaFiles = async ({ files }) => {
		imported.push({
			project: open,
			paths: files.map((file) => ("path" in file ? String(file.path) : "")),
		});
	};
	return {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- a stand-in with only what opening files reads.
		editor: editor as unknown as EditorCore,
		made,
		imported,
		importFiles,
	};
}

describe("files opened with MagnetCut", () => {
	test("go into the project open in the editor", async () => {
		globals.location = { pathname: "/editor" };
		opened = [trip];
		const { editor, made, imported, importFiles } = makeEditor({ open: "a" });
		const visited: string[] = [];

		await openOpenedFiles({
			navigate: (url) => visited.push(url),
			editor,
			importFiles,
		});

		expect(made).toEqual([]);
		expect(imported).toEqual([{ project: "a", paths: ["/Movies/Trip.mov"] }]);
		expect(visited).toEqual([]);
	});

	test("with none open, are a new project of their own", async () => {
		// As MagnetCut starts: the projects list.
		globals.location = { pathname: "/" };
		opened = [trip, { ...trip, path: "/Movies/More.mp4", name: "More.mp4" }];
		const { editor, made, imported, importFiles } = makeEditor({ open: null });
		const visited: string[] = [];

		await openOpenedFiles({
			navigate: (url) => visited.push(url),
			editor,
			importFiles,
		});

		expect(made).toEqual(["Trip"]);
		expect(imported).toEqual([
			{ project: "new", paths: ["/Movies/Trip.mov", "/Movies/More.mp4"] },
		]);
		expect(visited).toEqual(["/editor?id=new"]);
	});

	test("on the projects list, aren't given to the project open before", async () => {
		globals.location = { pathname: "/projects" };
		opened = [trip];
		const { editor, made, imported, importFiles } = makeEditor({ open: "a" });

		await openOpenedFiles({ navigate: () => {}, editor, importFiles });

		expect(made).toEqual(["Trip"]);
		expect(imported[0]?.project).toBe("new");
	});

	test("a project file opens as a project of its own, after the media", async () => {
		globals.location = { pathname: "/editor" };
		opened = [trip];
		projects = [{ path: "/Movies/Cut.magnetcut", text: "{ cut }" }];
		const { editor, imported, importFiles } = makeEditor({ open: "a" });
		const order: string[] = [];

		await openOpenedFiles({
			navigate: () => {},
			editor,
			importFiles: async (args) => {
				order.push("media");
				await importFiles(args);
			},
			openProject: async ({ text }) => {
				order.push(`project ${text}`);
			},
		});

		expect(imported[0]?.project).toBe("a");
		expect(order).toEqual(["media", "project { cut }"]);
	});

	test("none: nothing happens", async () => {
		globals.location = { pathname: "/editor" };
		opened = [];
		const { editor, made, imported, importFiles } = makeEditor({ open: "a" });

		await openOpenedFiles({ navigate: () => {}, editor, importFiles });

		expect(made).toEqual([]);
		expect(imported).toEqual([]);
	});

	test("name a new project after the first", () => {
		expect(projectNameFor({ files: [{ name: "Trip.final.MP4" }] })).toBe(
			"Trip.final",
		);
		expect(projectNameFor({ files: [{ name: ".mov" }] })).toBe("New project");
		expect(projectNameFor({ files: [] })).toBe("New project");
	});
});
