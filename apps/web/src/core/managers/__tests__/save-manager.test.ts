import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { toast } from "sonner";
import type { EditorCore } from "@/core";
import { SaveManager } from "../save-manager";

/** Lets the promises that can move on do so. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A save the test ends: done, or failed. */
type PendingSave = { done: () => void; fail: (error: Error) => void };

/** An editor with only what the save manager asks of its project. */
function makeEditor({ hasProject }: { hasProject: boolean }) {
	const saves: PendingSave[] = [];
	const project = {
		getActive: () => {
			if (!hasProject) throw new Error("No active project");
			return {};
		},
		getActiveOrNull: () => (hasProject ? {} : null),
		getIsLoading: () => false,
		getMigrationState: () => ({ isMigrating: false }),
		saveCurrentProject: () =>
			new Promise<void>((resolve, reject) => {
				saves.push({ done: resolve, fail: reject });
			}),
	};
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- a stand-in with only what saving reads.
	return { editor: { project } as unknown as EditorCore, saves };
}

describe("flushing the save before an update installs", () => {
	test("with no project open, as on the projects page, there's nothing to save", async () => {
		const { editor, saves } = makeEditor({ hasProject: false });
		const save = new SaveManager({ editor });

		await save.flush();

		expect(saves).toHaveLength(0);
		expect(save.getIsDirty()).toBe(false);
	});

	test("a save under way is waited for, then the latest changes saved", async () => {
		const { editor, saves } = makeEditor({ hasProject: true });
		const save = new SaveManager({ editor, debounceMs: 60_000 });

		const first = save.flush();
		let isFlushed = false;
		const second = save.flush().then(() => {
			isFlushed = true;
		});
		await settle();
		expect(saves).toHaveLength(1);

		saves[0].done();
		await first;
		await settle();
		expect(saves).toHaveLength(2);
		expect(isFlushed).toBe(false);

		saves[1].done();
		await second;
		expect(isFlushed).toBe(true);
		expect(save.getIsDirty()).toBe(false);
	});
});

describe("a save that fails", () => {
	const errors = spyOn(toast, "error");
	const dismissals = spyOn(toast, "dismiss");
	afterEach(() => {
		errors.mockClear();
		dismissals.mockClear();
	});
	afterAll(() => {
		errors.mockRestore();
		dismissals.mockRestore();
	});

	test("is said once, kept to save again, and tried at the next change", async () => {
		const { editor, saves } = makeEditor({ hasProject: true });
		const save = new SaveManager({ editor, debounceMs: 0 });

		const flushed = save.flush();
		await settle();
		saves[0].fail(new Error("The quota has been exceeded."));
		await expect(flushed).rejects.toThrow("quota");
		await settle();
		expect(save.getIsDirty()).toBe(true);
		expect(errors).toHaveBeenCalledTimes(1);
		// Not tried again by itself, in a loop.
		expect(saves).toHaveLength(1);

		save.markDirty();
		await settle();
		expect(saves).toHaveLength(2);
		saves[1].fail(new Error("The quota has been exceeded."));
		await settle();
		expect(errors).toHaveBeenCalledTimes(1);

		save.markDirty();
		await settle();
		saves[2].done();
		await settle();
		expect(save.getIsDirty()).toBe(false);
		expect(dismissals).toHaveBeenCalledTimes(1);
	});
});

describe("while a project loads", () => {
	test("a save that was due waits, and happens once it has", async () => {
		const { editor, saves } = makeEditor({ hasProject: true });
		const save = new SaveManager({ editor, debounceMs: 0 });

		save.markDirty();
		save.pause();
		await settle();
		expect(saves).toHaveLength(0);

		save.resume();
		await settle();
		expect(saves).toHaveLength(1);
	});
});

describe("discarding, as the open project is deleted", () => {
	test("the save under way is waited for, and nothing is saved after it", async () => {
		const { editor, saves } = makeEditor({ hasProject: true });
		const save = new SaveManager({ editor, debounceMs: 0 });

		void save.flush();
		await settle();
		save.markDirty();
		save.pause();
		let isDiscarded = false;
		const discarded = save.discard().then(() => {
			isDiscarded = true;
		});
		await settle();
		expect(isDiscarded).toBe(false);

		saves[0].done();
		await discarded;
		save.resume();
		await settle();
		expect(saves).toHaveLength(1);
		expect(save.getIsDirty()).toBe(false);
	});
});
