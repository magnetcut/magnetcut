import { beforeAll, describe, expect, test } from "bun:test";
import { EditorCore } from "@/core";
import type { SceneTracks, TScene, VideoElement } from "@/timeline";
import { mediaTime, TICKS_PER_SECOND } from "@/wasm";

const s = (seconds: number) => Math.round(seconds * TICKS_PER_SECOND);

function clip({ id, start }: { id: string; start: number }): VideoElement {
	return {
		id,
		type: "video",
		name: id,
		mediaId: "film",
		startTime: mediaTime({ ticks: s(start) }),
		duration: mediaTime({ ticks: s(5) }),
		trimStart: mediaTime({ ticks: 0 }),
		trimEnd: mediaTime({ ticks: 0 }),
		params: {},
	};
}

/** The editor with a project of two clips, A at 0-5 and B at 5-10, and, if
 * asked, a transition between them. */
function open({ transition = false }: { transition?: boolean } = {}) {
	const editor = EditorCore.getInstance();
	const tracks: SceneTracks = {
		overlay: [],
		main: {
			id: "main",
			name: "Main",
			type: "video",
			muted: false,
			hidden: false,
			elements: [clip({ id: "a", start: 0 }), clip({ id: "b", start: 5 })],
			transitions: transition
				? [
						{
							id: "t",
							fromElementId: "a",
							toElementId: "b",
							type: "cross-dissolve",
							duration: mediaTime({ ticks: s(0.5) }),
							alignment: "center",
							params: {},
							crossfadeAudio: true,
						},
					]
				: [],
		},
		audio: [],
	};
	const scene: TScene = {
		id: "scene",
		name: "Main scene",
		isMain: true,
		tracks,
		bookmarks: [],
		createdAt: new Date(0),
		updatedAt: new Date(0),
	};
	editor.project.setActiveProject({
		project: {
			metadata: {
				id: "project",
				name: "Test",
				duration: mediaTime({ ticks: 0 }),
				createdAt: new Date(0),
				updatedAt: new Date(0),
			},
			scenes: [scene],
			currentSceneId: scene.id,
			settings: {
				fps: { numerator: 30, denominator: 1 },
				canvasSize: { width: 1920, height: 1080 },
				background: { type: "color", color: "#000000" },
			},
			version: 31,
		},
	});
	editor.scenes.initializeScenes({ scenes: [scene], currentSceneId: scene.id });
	editor.command.clear();
	editor.selection.clearSelection();
	return editor;
}

const startOfB = ({ editor }: { editor: EditorCore }) =>
	(editor.scenes
		.getActiveScene()
		.tracks.main.elements.find((one) => one.id === "b")?.startTime ?? -1) /
	TICKS_PER_SECOND;

beforeAll(() => {
	// Nothing is stored in a test.
	EditorCore.getInstance().save.pause();
});

describe("a redo does what was done", () => {
	test("a delete that rippled ripples again, the toggle off since", () => {
		const editor = open();
		editor.command.setRippleEnabled({ enabled: true });
		editor.timeline.deleteElements({
			elements: [{ trackId: "main", elementId: "a" }],
		});
		expect(startOfB({ editor })).toBe(0);

		editor.command.undo();
		expect(startOfB({ editor })).toBe(5);
		editor.command.setRippleEnabled({ enabled: false });
		editor.command.redo();
		expect(startOfB({ editor })).toBe(0);
	});

	test("one that didn't, doesn't, the toggle on since", () => {
		const editor = open();
		editor.command.setRippleEnabled({ enabled: false });
		editor.timeline.deleteElements({
			elements: [{ trackId: "main", elementId: "a" }],
		});
		editor.command.undo();
		editor.command.setRippleEnabled({ enabled: true });
		editor.command.redo();
		expect(startOfB({ editor })).toBe(5);
		editor.command.setRippleEnabled({ enabled: false });
	});
});

describe("a selected transition that goes is deselected", () => {
	const transition = { trackId: "main", transitionId: "t" };

	test("dropped when its clips no longer touch, done or redone", () => {
		const editor = open({ transition: true });
		const trimA = () =>
			editor.timeline.updateElementTrim({
				elementId: "a",
				trimStart: mediaTime({ ticks: 0 }),
				trimEnd: mediaTime({ ticks: s(1) }),
				duration: mediaTime({ ticks: s(4) }),
			});
		editor.selection.setSelectedTransition({ transition });
		trimA();
		expect(editor.scenes.getActiveScene().tracks.main.transitions).toEqual([]);
		expect(editor.selection.getSelectedTransition()).toBeNull();

		editor.command.undo();
		editor.selection.setSelectedTransition({ transition });
		editor.command.redo();
		expect(editor.selection.getSelectedTransition()).toBeNull();
	});

	test("taken away by an undo", () => {
		const editor = open();
		const transitionId = editor.timeline.addTransition({
			trackId: "main",
			fromElementId: "a",
			toElementId: "b",
		});
		// As Add Transition does: selected outside the command.
		editor.selection.setSelectedTransition({
			transition: { trackId: "main", transitionId },
		});
		editor.command.undo();
		expect(editor.selection.getSelectedTransition()).toBeNull();
	});

	test("one still there stays selected", () => {
		const editor = open({ transition: true });
		editor.selection.setSelectedTransition({ transition });
		editor.timeline.updateElementTrim({
			elementId: "b",
			trimStart: mediaTime({ ticks: 0 }),
			trimEnd: mediaTime({ ticks: s(1) }),
			duration: mediaTime({ ticks: s(4) }),
		});
		expect(editor.selection.getSelectedTransition()).toEqual(transition);
	});
});
