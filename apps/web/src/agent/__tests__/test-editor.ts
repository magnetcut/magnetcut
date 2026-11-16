import { EditorCore } from "@/core";
import type { MediaAsset } from "@/media/types";
import type { TProject } from "@/project/types";
import type {
	AudioElement,
	SceneTracks,
	TScene,
	VideoElement,
} from "@/timeline";
import { mediaTime, TICKS_PER_SECOND } from "@/wasm";
import type { ToolContext } from "../tools-base";

// The real editor, with a small project open in it, for the agent's tools to
// work on in tests: as the window has it, minus storage.

const s = (seconds: number) => Math.round(seconds * TICKS_PER_SECOND);

function clip({
	id,
	start,
	length,
}: {
	id: string;
	start: number;
	length: number;
}): VideoElement {
	return {
		id,
		type: "video",
		name: id,
		mediaId: "film",
		startTime: mediaTime({ ticks: s(start) }),
		duration: mediaTime({ ticks: s(length) }),
		trimStart: mediaTime({ ticks: 0 }),
		trimEnd: mediaTime({ ticks: s(60) }),
		params: {},
	};
}

function sound({ id, start }: { id: string; start: number }): AudioElement {
	return {
		id,
		type: "audio",
		sourceType: "upload",
		mediaId: "music",
		name: id,
		startTime: mediaTime({ ticks: s(start) }),
		duration: mediaTime({ ticks: s(5) }),
		trimStart: mediaTime({ ticks: 0 }),
		trimEnd: mediaTime({ ticks: 0 }),
		params: {},
	};
}

/** V1 with one 0-5 and two 5-10; A1 with music 0-5. Or, `empty`, nothing. */
export function tracks({
	empty = false,
}: { empty?: boolean } = {}): SceneTracks {
	return {
		overlay: [],
		main: {
			id: "main",
			name: "Main",
			type: "video",
			muted: false,
			hidden: false,
			elements: empty
				? []
				: [
						clip({ id: "one00", start: 0, length: 5 }),
						clip({ id: "two00", start: 5, length: 5 }),
					],
			transitions: [],
		},
		audio: empty
			? []
			: [
					{
						id: "audio",
						name: "Audio",
						type: "audio",
						muted: false,
						elements: [sound({ id: "song0", start: 0 })],
					},
				],
	};
}

export const ASSETS: MediaAsset[] = [
	{
		id: "film",
		name: "film.mp4",
		type: "video",
		file: new File([], "film.mp4", { type: "video/mp4" }),
		duration: 60,
		width: 3840,
		height: 2160,
		fps: 25,
	},
	{
		id: "music",
		name: "music.mp3",
		type: "audio",
		file: new File([], "music.mp3", { type: "audio/mpeg" }),
		duration: 5,
	},
];

export const SETTINGS: TProject["settings"] = {
	fps: { numerator: 30, denominator: 1 },
	canvasSize: { width: 1920, height: 1080 },
	background: { type: "color", color: "#000000" },
};

/** The editor with a test project open in it, loaded, as the agent finds it. */
export function open({ timeline = tracks() }: { timeline?: SceneTracks } = {}) {
	const editor = EditorCore.getInstance();
	const scene: TScene = {
		id: "scene",
		name: "Main scene",
		isMain: true,
		tracks: timeline,
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
			settings: SETTINGS,
			version: 31,
		},
	});
	editor.scenes.initializeScenes({ scenes: [scene], currentSceneId: scene.id });
	editor.media.setAssets({ assets: ASSETS });
	editor.command.clear();
	editor.command.setRippleEnabled({ enabled: false });
	editor.selection.clearSelection();
	Object.assign(editor.project, { loadedProjectId: "project" });
	return editor;
}

/** A call's context: `navigate` stands for the window going to a page. */
export function context({
	editor,
	navigate = () => {},
}: {
	editor: EditorCore;
	navigate?: ToolContext["navigate"];
}): ToolContext {
	return {
		editor,
		call: 1,
		agent: "test",
		navigate,
		progress: () => {},
		isStopped: () => false,
	};
}

/** On the editor's page, with nothing stored: once, before the tests. */
export function setUp(): void {
	Object.defineProperty(globalThis, "location", {
		value: { pathname: "/editor" },
		configurable: true,
	});
	EditorCore.getInstance().save.pause();
}

/** Off the editor's page again, for the tests after. */
export function tearDown(): void {
	Reflect.deleteProperty(globalThis, "location");
}

/** The main track's clips, by id and seconds. */
export const spans = ({ editor }: { editor: EditorCore }) =>
	editor.scenes
		.getActiveScene()
		.tracks.main.elements.map(
			(one) =>
				`${one.id} ${one.startTime / TICKS_PER_SECOND}-${(one.startTime + one.duration) / TICKS_PER_SECOND}`,
		);
