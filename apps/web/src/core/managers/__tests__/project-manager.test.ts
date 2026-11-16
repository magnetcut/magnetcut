import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	spyOn,
	test,
} from "bun:test";
import { toast } from "sonner";
import { Command } from "@/commands";
import type { EditorCore } from "@/core";
import type { TProject } from "@/project/types";
import { CURRENT_PROJECT_VERSION } from "@/services/storage/migrations";
import { storageService } from "@/services/storage/service";
import type { TScene } from "@/timeline";
import { buildDefaultScene } from "@/timeline/scenes";
import { mediaTime } from "@/wasm";
import { CommandManager } from "../commands";
import { ProjectManager } from "../project-manager";
import { SaveManager } from "../save-manager";

/** Lets the promises and timers that can move on do so. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function makeProject({ id }: { id: string }): TProject {
	const scene = buildDefaultScene({ name: "Main scene", isMain: true });
	return {
		metadata: {
			id,
			name: id,
			duration: mediaTime({ ticks: 0 }),
			createdAt: new Date(),
			updatedAt: new Date(),
		},
		scenes: [scene],
		currentSceneId: scene.id,
		settings: {
			fps: { numerator: 30, denominator: 1 },
			canvasSize: { width: 1920, height: 1080 },
			canvasSizeMode: "preset",
			lastCustomCanvasSize: null,
			originalCanvasSize: null,
			background: { type: "color", color: "#000000" },
		},
		version: CURRENT_PROJECT_VERSION,
	};
}

/** A project in storage, with its thumbnail: one that opens without drawing. */
function makeStoredProject({ id }: { id: string }): TProject {
	const project = makeProject({ id });
	return {
		...project,
		metadata: { ...project.metadata, thumbnail: `${id}.png` },
	};
}

/** What reached storage, and what the editor cleared, in order. */
let events: string[] = [];
/** Saves that end when the test says, if it holds them. */
let heldSaves: Array<() => void> | null = null;
let failingSave: Error | null = null;
/** The projects in storage, besides the open one. */
let storedProjects: TProject[] = [];

const spies = [
	spyOn(storageService, "saveProject").mockImplementation(
		async ({ project }) => {
			if (failingSave) throw failingSave;
			if (heldSaves) {
				const held = heldSaves;
				await new Promise<void>((resolve) => held.push(resolve));
			}
			events.push(
				`save ${project.metadata.id}, ${project.scenes.length} scene(s)`,
			);
		},
	),
	spyOn(storageService, "loadProject").mockImplementation(async ({ id }) => {
		const stored = storedProjects.find(({ metadata }) => metadata.id === id);
		return stored ? { project: stored } : null;
	}),
	spyOn(storageService, "loadAllProjectsMetadata").mockImplementation(
		async () => [],
	),
	spyOn(storageService, "deleteProject").mockImplementation(async ({ id }) => {
		events.push(`delete ${id}`);
	}),
	spyOn(storageService, "deleteProjectMedia").mockImplementation(
		async () => {},
	),
	spyOn(console, "error").mockImplementation(() => {}),
	spyOn(toast, "error").mockImplementation(() => ""),
];

beforeEach(() => {
	events = [];
	heldSaves = null;
	failingSave = null;
	storedProjects = [];
});
afterEach(() => {
	for (const spy of spies) spy.mockClear();
});
afterAll(() => {
	for (const spy of spies) spy.mockRestore();
});

/** A project manager and a save manager, with stand-ins for the rest of the
 * editor, and project `a` open. */
async function openProjectA() {
	let scenes: TScene[] = [];
	const scenesStandIn = {
		getScenes: () => scenes,
		initializeScenes: ({ scenes: next }: { scenes: TScene[] }) => {
			scenes = next;
		},
		clearScenes: () => {
			events.push("clear scenes");
			scenes = [];
		},
	};
	const media = {
		clearAllAssets: () => {
			events.push("clear media");
		},
		loadProjectMedia: async () => {},
	};
	const selection = { getSnapshot: () => ({}) };
	const editor = { scenes: scenesStandIn, media, selection };
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- a stand-in with only what these read.
	const core = editor as unknown as EditorCore;
	const project = new ProjectManager(core);
	const save = new SaveManager({ editor: core, debounceMs: 0 });
	const command = new CommandManager(core);
	Object.assign(editor, { project, save, command });
	// The storage migrations, already run.
	Object.assign(project, { storageMigrationPromise: Promise.resolve() });
	await project.loadAllProjects();

	const a = makeProject({ id: "a" });
	project.setActiveProject({ project: a });
	scenesStandIn.initializeScenes({ scenes: a.scenes });
	events = [];
	return { project, save, command };
}

/** A change to project `a`, whose undo says so. */
class ChangeToA extends Command {
	execute() {
		return undefined;
	}

	undo() {
		events.push("undo a change to a");
	}
}

describe("opening another project", () => {
	test("saves the open one first, before its scenes go", async () => {
		const { project, save } = await openProjectA();
		save.markDirty();

		await expect(project.loadProject({ id: "b" })).rejects.toThrow("not found");

		expect(events).toEqual([
			"save a, 1 scene(s)",
			"clear media",
			"clear scenes",
		]);
	});

	test("keeps the open one if it can't be saved", async () => {
		const { project, save } = await openProjectA();
		save.markDirty();
		failingSave = new Error("The quota has been exceeded.");

		await expect(project.loadProject({ id: "b" })).rejects.toThrow(
			"Couldn't save the open project first",
		);

		expect(events).toEqual([]);
		expect(project.getActive().metadata.id).toBe("a");
		expect(save.getIsDirty()).toBe(true);
		expect(project.getLoadError()).toEqual({
			projectId: "b",
			message:
				"Couldn't save the open project first: The quota has been exceeded.",
		});
	});

	test("that isn't there says so, until the next load starts", async () => {
		const { project } = await openProjectA();

		await expect(project.loadProject({ id: "b" })).rejects.toThrow();
		expect(project.getLoadError()?.projectId).toBe("b");

		storedProjects = [makeStoredProject({ id: "c" })];
		await project.loadProject({ id: "c" });
		expect(project.getLoadError()).toBeNull();
	});

	test("leaves the open one's undo history behind", async () => {
		const { project, command } = await openProjectA();
		command.push({ command: new ChangeToA() });
		storedProjects = [makeStoredProject({ id: "b" })];

		await project.loadProject({ id: "b" });
		command.undo();

		expect(events).not.toContain("undo a change to a");
		expect(command.canUndo()).toBe(false);
	});

	test("a new one saves the open one first", async () => {
		const { project, save } = await openProjectA();
		save.markDirty();

		const id = await project.createNewProject({ name: "New project" });

		expect(events[0]).toBe("save a, 1 scene(s)");
		expect(events).toContain(`save ${id}, 1 scene(s)`);
	});

	test("closing the open one leaves its undo history behind", async () => {
		const { project, command } = await openProjectA();
		command.push({ command: new ChangeToA() });

		project.closeProject();

		expect(command.canUndo()).toBe(false);
	});
});

describe("deleting the open project", () => {
	test("while it saves doesn't bring it back", async () => {
		const { project, save } = await openProjectA();
		heldSaves = [];
		void save.flush();
		await settle();
		// A change while it saves: its save would come after the delete.
		save.markDirty();

		const deleting = project.deleteProjects({ ids: ["a"] });
		await settle();
		expect(events).toEqual([]);

		heldSaves[0]();
		await deleting;
		await settle();
		await settle();

		expect(events).toEqual([
			"save a, 1 scene(s)",
			"delete a",
			"clear media",
			"clear scenes",
		]);
		expect(project.getActiveOrNull()).toBeNull();
		expect(project.getSavedProjects().map(({ id }) => id)).toEqual([]);
	});
});
