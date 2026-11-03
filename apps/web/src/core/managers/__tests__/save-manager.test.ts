import { describe, expect, test } from "bun:test";
import type { EditorCore } from "@/core";
import { SaveManager } from "../save-manager";

/** Lets the promises that can move on do so. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** An editor with only what the save manager asks of its project. */
function makeEditor({ hasProject }: { hasProject: boolean }) {
	const saves: Array<() => void> = [];
	const project = {
		getActive: () => {
			if (!hasProject) throw new Error("No active project");
			return {};
		},
		getActiveOrNull: () => (hasProject ? {} : null),
		getIsLoading: () => false,
		getMigrationState: () => ({ isMigrating: false }),
		saveCurrentProject: () =>
			new Promise<void>((resolve) => {
				saves.push(resolve);
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

		saves[0]();
		await first;
		await settle();
		expect(saves).toHaveLength(2);
		expect(isFlushed).toBe(false);

		saves[1]();
		await second;
		expect(isFlushed).toBe(true);
		expect(save.getIsDirty()).toBe(false);
	});
});
