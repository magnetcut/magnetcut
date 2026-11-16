import { expect, test } from "bun:test";
import { InsertElementCommand } from "@/commands";
import type { CreateVideoElement } from "@/timeline";
import { openEditor, s, SETTINGS, tracksWith } from "./editor";

test("the first clip's size and rate given to the project are undone with it", () => {
	const editor = openEditor({ tracks: tracksWith({}) });
	const element: CreateVideoElement = {
		type: "video",
		name: "film",
		mediaId: "film",
		startTime: s(0),
		duration: s(5),
		trimStart: s(0),
		trimEnd: s(0),
		params: {},
	};

	editor.command.execute({
		command: new InsertElementCommand({
			element,
			placement: { mode: "auto" },
		}),
	});
	const settings = () => {
		const { canvasSize, originalCanvasSize, fps } =
			editor.project.getActive().settings;
		return { canvasSize, originalCanvasSize, fps };
	};
	const film = {
		canvasSize: { width: 3840, height: 2160 },
		originalCanvasSize: { width: 3840, height: 2160 },
		fps: { numerator: 25, denominator: 1 },
	};
	expect(settings()).toEqual(film);

	editor.command.undo();
	expect(editor.scenes.getActiveScene().tracks.main.elements).toHaveLength(0);
	expect(settings()).toEqual({
		canvasSize: SETTINGS.canvasSize,
		originalCanvasSize: undefined,
		fps: SETTINGS.fps,
	});

	editor.command.redo();
	expect(settings()).toEqual(film);
});
