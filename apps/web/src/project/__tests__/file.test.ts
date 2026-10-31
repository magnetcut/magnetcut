import { expect, test } from "bun:test";
import type { MediaAsset } from "@/media/types";
import { buildDefaultScene } from "@/timeline/scenes";
import { mediaTime } from "@/wasm";
import { parseProjectFile, toProjectFile } from "../file";
import type { TProject } from "../types";

function project(): TProject {
	const scene = buildDefaultScene({ name: "Main scene", isMain: true });
	return {
		metadata: {
			id: "p1",
			name: "Trip",
			duration: mediaTime({ ticks: 0 }),
			createdAt: new Date("2026-10-01T10:00:00Z"),
			updatedAt: new Date("2026-10-02T10:00:00Z"),
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
		version: 1,
	};
}

test("a project file keeps the project and its media by path, and opens again", () => {
	const assets: MediaAsset[] = [
		{
			id: "m1",
			name: "beach.mp4",
			type: "video",
			path: "/films/beach.mp4",
			duration: 12,
			file: new File([], "beach.mp4"),
		},
		{
			id: "m2",
			name: "pasted.png",
			type: "image",
			file: new File([], "pasted.png"),
		},
	];
	const saved = project();
	const { text, leftOut } = toProjectFile({ project: saved, assets });
	expect(leftOut).toEqual(["pasted.png"]);
	const opened = parseProjectFile({ text });
	expect(opened.project.metadata.name).toBe("Trip");
	expect(opened.project.metadata.createdAt.toISOString()).toBe(
		"2026-10-01T10:00:00.000Z",
	);
	expect(opened.project.scenes[0].tracks).toEqual(saved.scenes[0].tracks);
	expect(opened.media).toEqual([
		{
			id: "m1",
			name: "beach.mp4",
			type: "video",
			path: "/films/beach.mp4",
			duration: 12,
			width: undefined,
			height: undefined,
			fps: undefined,
			hasAudio: undefined,
		},
	]);
});

test("a file that isn't a project says so", () => {
	expect(() => parseProjectFile({ text: "nope" })).toThrow("not JSON");
	expect(() => parseProjectFile({ text: "{}" })).toThrow(
		"isn't a MagnetCut project",
	);
	expect(() =>
		parseProjectFile({ text: JSON.stringify({ magnetcut: 9, project: {} }) }),
	).toThrow("another version");
});
