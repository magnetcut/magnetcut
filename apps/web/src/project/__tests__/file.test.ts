import { expect, test } from "bun:test";
import type { MediaAsset } from "@/media/types";
import { CURRENT_PROJECT_VERSION } from "@/services/storage/migrations";
import { serializeProject } from "@/services/storage/service";
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
		version: CURRENT_PROJECT_VERSION,
	};
}

test("a project file keeps the project and its media by path, and opens again", async () => {
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
	const opened = await parseProjectFile({ text, projectId: "new" });
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

test("a file that isn't a project says so", async () => {
	const parse = ({ text }: { text: string }) =>
		parseProjectFile({ text, projectId: "new" });
	await expect(parse({ text: "nope" })).rejects.toThrow("not JSON");
	await expect(parse({ text: "{}" })).rejects.toThrow(
		"isn't a MagnetCut project",
	);
	await expect(
		parse({ text: JSON.stringify({ magnetcut: 9, project: {} }) }),
	).rejects.toThrow("another version");
});

/** A project file whose project is changed by `change`. */
function fileWith({
	change,
}: {
	change: (project: Record<string, unknown>) => Record<string, unknown>;
}): string {
	const saved = { ...serializeProject({ project: project() }) };
	return JSON.stringify({ magnetcut: 1, project: change(saved), media: [] });
}

test("a project from a newer MagnetCut, or without settings or scenes, isn't opened", async () => {
	await expect(
		parseProjectFile({
			text: fileWith({
				change: (saved) => ({
					...saved,
					version: CURRENT_PROJECT_VERSION + 1,
				}),
			}),
			projectId: "new",
		}),
	).rejects.toThrow("newer MagnetCut");
	await expect(
		parseProjectFile({
			text: fileWith({
				change: ({ settings: _settings, ...saved }) => saved,
			}),
			projectId: "new",
		}),
	).rejects.toThrow("damaged");
	await expect(
		parseProjectFile({
			text: fileWith({ change: (saved) => ({ ...saved, scenes: [] }) }),
			projectId: "new",
		}),
	).rejects.toThrow("damaged");
});

test("a project from an older MagnetCut is brought up to date", async () => {
	const text = fileWith({
		change: (saved) => ({
			...saved,
			version: 30,
			scenes: [
				{
					id: "s1",
					name: "Main scene",
					isMain: true,
					bookmarks: [],
					createdAt: "2026-10-01T10:00:00.000Z",
					updatedAt: "2026-10-01T10:00:00.000Z",
					tracks: {
						overlay: [],
						audio: [],
						main: {
							id: "t1",
							elements: [
								{
									id: "image-1",
									type: "image",
									masks: [{ id: "mask-1", type: "custom", params: {} }],
								},
							],
						},
					},
				},
			],
		}),
	});

	const opened = await parseProjectFile({ text, projectId: "new" });

	expect(opened.project.version).toBe(CURRENT_PROJECT_VERSION);
	expect(JSON.stringify(opened.project.scenes)).toContain('"type":"freeform"');
});
