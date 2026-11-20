import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { EditorCore } from "@/core";
import { ThumbnailManager } from "../thumbnail-manager";

/** Lets the promises and timers that can move on do so. */
const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

type OpenProject = { metadata: { id: string; thumbnail?: string } };

/** An editor with only what the thumbnails read, and project `a` open. */
function makeEditor() {
	const listeners = new Set<() => void>();
	const a: OpenProject = { metadata: { id: "a" } };
	const state = {
		active: a as OpenProject | null,
		loadedProjectId: "a" as string | null,
		isPlaying: false,
		isExporting: false,
		thumbnails: [] as Array<string | undefined>,
	};
	const subscribe = (listener: () => void) => {
		listeners.add(listener);
		return () => listeners.delete(listener);
	};
	const editor = {
		scenes: { subscribe },
		timeline: { subscribe },
		playback: { getIsPlaying: () => state.isPlaying },
		project: {
			getActiveOrNull: () => state.active,
			getLoadedProjectId: () => state.loadedProjectId,
			getExportState: () => ({ isExporting: state.isExporting }),
			updateThumbnail: async ({
				thumbnail,
			}: {
				thumbnail: string | undefined;
			}) => {
				state.thumbnails.push(thumbnail);
				if (state.active) state.active.metadata.thumbnail = thumbnail;
			},
		},
	};
	const change = () => {
		for (const listener of listeners) listener();
	};
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- a stand-in with only what the thumbnails read.
	return { editor: editor as unknown as EditorCore, state, change };
}

const consoleError = spyOn(console, "error").mockImplementation(() => {});
afterEach(() => consoleError.mockClear());

describe("the open project's thumbnail", () => {
	test("is taken again once the timeline has been still a moment", async () => {
		const { editor, state, change } = makeEditor();
		let taken = 0;
		const thumbnails = new ThumbnailManager({
			editor,
			quietMs: 20,
			intervalMs: 0,
			capture: async () => `frame ${++taken}`,
		});
		thumbnails.start();

		change();
		await settle(10);
		change();
		await settle(10);
		expect(state.thumbnails).toEqual([]);
		await settle(30);
		expect(state.thumbnails).toEqual(["frame 1"]);
		thumbnails.stop();
	});

	test("isn't taken again sooner than the interval after the last", async () => {
		const { editor, state, change } = makeEditor();
		let now = 0;
		const thumbnails = new ThumbnailManager({
			editor,
			quietMs: 0,
			intervalMs: 1000,
			now: () => now,
			capture: async () => "frame",
		});
		thumbnails.start();

		await thumbnails.refresh();
		expect(state.thumbnails).toHaveLength(1);
		now = 100;
		change();
		await settle(20);
		expect(state.thumbnails).toHaveLength(1);
		thumbnails.stop();
	});

	test("for an empty timeline, doesn't hold back the next", async () => {
		const { editor, state, change } = makeEditor();
		let frame: string | null = null;
		const thumbnails = new ThumbnailManager({
			editor,
			quietMs: 5,
			intervalMs: 60_000,
			capture: async () => frame,
		});
		thumbnails.start();

		// As a new project opens.
		await thumbnails.refresh();
		frame = "frame";
		change();
		await settle(20);
		expect(state.thumbnails).toEqual(["frame"]);
		thumbnails.stop();
	});

	test("isn't taken while the project loads, plays or exports", async () => {
		const { editor, state, change } = makeEditor();
		const thumbnails = new ThumbnailManager({
			editor,
			quietMs: 5,
			intervalMs: 0,
			capture: async () => "frame",
		});
		thumbnails.start();

		// Its scenes arriving as it loads.
		state.loadedProjectId = null;
		change();
		await settle(20);
		expect(state.thumbnails).toEqual([]);

		state.loadedProjectId = "a";
		state.isPlaying = true;
		change();
		await settle(20);
		expect(state.thumbnails).toEqual([]);
		state.isPlaying = false;
		state.isExporting = true;
		await settle(20);
		expect(state.thumbnails).toEqual([]);
		// Once it's done.
		state.isExporting = false;
		await settle(20);
		expect(state.thumbnails).toEqual(["frame"]);
		thumbnails.stop();
	});

	test("isn't given to another project opened while it was drawn", async () => {
		const { editor, state } = makeEditor();
		let finish = (_: string) => {};
		const thumbnails = new ThumbnailManager({
			editor,
			capture: () =>
				new Promise<string>((resolve) => {
					finish = resolve;
				}),
		});

		const taking = thumbnails.refresh();
		state.active = { metadata: { id: "b" } };
		finish("a's frame");
		expect(await taking).toBe(false);
		expect(state.thumbnails).toEqual([]);
	});

	test("goes when the timeline is emptied, and isn't made for an empty one", async () => {
		const { editor, state } = makeEditor();
		let frame: string | null = null;
		const thumbnails = new ThumbnailManager({
			editor,
			capture: async () => frame,
		});

		expect(await thumbnails.refresh()).toBe(false);
		frame = "frame";
		expect(await thumbnails.refresh()).toBe(true);
		frame = null;
		expect(await thumbnails.refresh()).toBe(true);
		expect(state.thumbnails).toEqual(["frame", undefined]);
	});

	test("isn't taken for a project closed before the timer went", async () => {
		const { editor, state, change } = makeEditor();
		const thumbnails = new ThumbnailManager({
			editor,
			quietMs: 5,
			intervalMs: 0,
			capture: async () => "frame",
		});
		thumbnails.start();

		change();
		state.active = null;
		await settle(20);
		expect(state.thumbnails).toEqual([]);
		thumbnails.stop();
	});
});
