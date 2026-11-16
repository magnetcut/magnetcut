import { EditorCore } from "@/core";
import type { MediaAsset } from "@/media/types";
import type { TProject } from "@/project/types";
import type { SceneTracks, TScene, VideoElement } from "@/timeline";
import { mediaTime, TICKS_PER_SECOND } from "@/wasm";

// The real editor with a small project open, for commands to run on, undo
// and redo: as the window has it, minus storage.

export const s = (seconds: number) =>
	mediaTime({ ticks: Math.round(seconds * TICKS_PER_SECOND) });

export function clip({
	id,
	start,
	length,
	head = 10,
	tail = 10,
	params = {},
}: {
	id: string;
	start: number;
	length: number;
	head?: number;
	tail?: number;
	params?: VideoElement["params"];
}): VideoElement {
	return {
		id,
		type: "video",
		name: id,
		mediaId: "film",
		startTime: s(start),
		duration: s(length),
		trimStart: s(head),
		trimEnd: s(tail),
		sourceDuration: s(head + length + tail),
		params,
	};
}

/** A main track with `elements`, and no other track. */
export function tracksWith({
	elements = [],
	transitions = [],
}: {
	elements?: VideoElement[];
	transitions?: NonNullable<SceneTracks["main"]["transitions"]>;
}): SceneTracks {
	return {
		overlay: [],
		main: {
			id: "main",
			name: "Main",
			type: "video",
			muted: false,
			hidden: false,
			elements,
			transitions,
		},
		audio: [],
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
		hasAudio: true,
	},
];

export const SETTINGS: TProject["settings"] = {
	fps: { numerator: 30, denominator: 1 },
	canvasSize: { width: 1920, height: 1080 },
	background: { type: "color", color: "#000000" },
};

/** The editor with a project of `tracks` open, its history empty. */
export function openEditor({ tracks }: { tracks: SceneTracks }): EditorCore {
	Object.defineProperty(globalThis, "location", {
		value: { pathname: "/editor" },
		configurable: true,
	});
	const editor = EditorCore.getInstance();
	editor.save.pause();
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
			settings: SETTINGS,
			version: 31,
		},
	});
	editor.scenes.initializeScenes({ scenes: [scene], currentSceneId: scene.id });
	editor.media.setAssets({ assets: ASSETS });
	editor.command.clear();
	editor.command.setRippleEnabled({ enabled: false });
	editor.selection.clearSelection();
	return editor;
}

/** Every clip on the timeline, by id, its track's id with it. */
export function allElements({ editor }: { editor: EditorCore }) {
	const { tracks } = editor.scenes.getActiveScene();
	return [...tracks.overlay, tracks.main, ...tracks.audio].flatMap((track) =>
		track.elements.map((element) => ({ trackId: track.id, element })),
	);
}
