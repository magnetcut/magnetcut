import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { EditorCore } from "@/core";
import type { ToolResult } from "../tools-base";
import { editTool, undoTool } from "../edit";
import {
	context,
	open,
	SETTINGS,
	setUp,
	spans,
	tearDown,
	tracks,
} from "./test-editor";

function edit({
	editor,
	args,
}: {
	editor: EditorCore;
	args: Record<string, unknown>;
}): Promise<ToolResult> {
	return editTool.run({ args, context: context({ editor }) });
}

beforeAll(setUp);
afterAll(tearDown);

describe("clips on a track never overlap", () => {
	test("a move onto another clip is refused, and nothing changes", async () => {
		const editor = open();
		await expect(
			edit({
				editor,
				args: { operations: [{ op: "move", id: "two00", to: 3 }] },
			}),
		).rejects.toThrow("one00 is there on V1");
		expect(spans({ editor })).toEqual(["one00 0-5", "two00 5-10"]);
		expect(editor.command.canUndo()).toBe(false);
	});

	test("a move into a gap, or to touch, is fine", async () => {
		const editor = open();
		await edit({
			editor,
			args: { operations: [{ op: "move", id: "two00", to: 12 }] },
		});
		await edit({
			editor,
			args: { operations: [{ op: "move", id: "two00", to: 5 }] },
		});
		expect(spans({ editor })).toEqual(["one00 0-5", "two00 5-10"]);
	});

	test("a trim over the next clip is refused", async () => {
		const editor = open();
		await expect(
			edit({
				editor,
				args: { operations: [{ op: "trim", id: "one00", end: 7 }] },
			}),
		).rejects.toThrow("two00 is there on V1");
		expect(spans({ editor })).toEqual(["one00 0-5", "two00 5-10"]);
	});

	test("an insert on a named track, over a clip there, is refused", async () => {
		const editor = open();
		await expect(
			edit({
				editor,
				args: {
					operations: [{ op: "insert", media: "film", at: 7, track: "V1" }],
				},
			}),
		).rejects.toThrow("two00 is there on V1");
	});
});

describe("an insert that can't be done says so", () => {
	test("music on V1 is refused, not reported as done", async () => {
		const editor = open();
		await expect(
			edit({
				editor,
				args: { operations: [{ op: "insert", media: "music", track: "V1" }] },
			}),
		).rejects.toThrow("V1 is for video: audio doesn't go there");
	});

	test("words on A1 are refused", async () => {
		const editor = open();
		await expect(
			edit({
				editor,
				args: {
					operations: [{ op: "text", text: "Hello", at: 20, track: "A1" }],
				},
			}),
		).rejects.toThrow("A1 is for audio: text doesn't go there");
	});
});

describe("a dry run, or a batch that fails, changes nothing", () => {
	test("the user's redo is still there", async () => {
		const editor = open();
		editor.timeline.deleteElements({
			elements: [{ trackId: "main", elementId: "two00" }],
		});
		editor.command.undo();
		expect(editor.command.canRedo()).toBe(true);

		await edit({
			editor,
			args: {
				operations: [{ op: "move", id: "one00", to: 20 }],
				dryRun: true,
			},
		});
		expect(editor.command.canRedo()).toBe(true);
		await expect(
			edit({
				editor,
				args: {
					operations: [
						{ op: "move", id: "one00", to: 20 },
						{ op: "move", id: "nothing" },
					],
				},
			}),
		).rejects.toThrow("Nothing was changed");
		expect(editor.command.canRedo()).toBe(true);
		expect(spans({ editor })).toEqual(["one00 0-5", "two00 5-10"]);

		editor.command.redo();
		expect(spans({ editor })).toEqual(["one00 0-5"]);
	});

	test("the first clip doesn't leave its size and frame rate behind", async () => {
		const editor = open({ timeline: tracks({ empty: true }) });
		const result = await edit({
			editor,
			args: { operations: [{ op: "insert", media: "film" }], dryRun: true },
		});
		expect(result.content[0]).toMatchObject({
			text: expect.stringContaining("would change"),
		});
		expect(editor.project.getActive().settings).toEqual(SETTINGS);
		expect(spans({ editor })).toEqual([]);
	});

	test("the selection stays as it was", async () => {
		const editor = open();
		editor.selection.setSelectedElements({
			elements: [{ trackId: "main", elementId: "one00" }],
		});
		await edit({
			editor,
			args: { operations: [{ op: "move", id: "two00", to: 20 }], dryRun: true },
		});
		expect(editor.selection.getSelectedElements()).toEqual([
			{ trackId: "main", elementId: "one00" },
		]);
	});
});

describe("a batch's undo step", () => {
	test("a redo puts it back as it was, whatever the ripple toggle says now", async () => {
		const editor = open();
		await edit({
			editor,
			args: { operations: [{ op: "trim", id: "one00", end: 3 }] },
		});
		expect(spans({ editor })).toEqual(["one00 0-3", "two00 5-10"]);
		await undoTool.run({ args: {}, context: context({ editor }) });
		expect(spans({ editor })).toEqual(["one00 0-5", "two00 5-10"]);

		editor.command.setRippleEnabled({ enabled: true });
		await undoTool.run({ args: { redo: true }, context: context({ editor }) });
		expect(spans({ editor })).toEqual(["one00 0-3", "two00 5-10"]);
	});

	test("the first clip's size and frame rate go with it, and come back", async () => {
		const editor = open({ timeline: tracks({ empty: true }) });
		await edit({
			editor,
			args: { operations: [{ op: "insert", media: "film" }] },
		});
		expect(editor.project.getActive().settings).toMatchObject({
			canvasSize: { width: 3840, height: 2160 },
			fps: { numerator: 25, denominator: 1 },
		});

		await undoTool.run({ args: {}, context: context({ editor }) });
		expect(spans({ editor })).toEqual([]);
		expect(editor.project.getActive().settings).toEqual(SETTINGS);

		await undoTool.run({ args: { redo: true }, context: context({ editor }) });
		expect(spans({ editor })).toHaveLength(1);
		expect(editor.project.getActive().settings).toMatchObject({
			canvasSize: { width: 3840, height: 2160 },
			fps: { numerator: 25, denominator: 1 },
		});
	});
});

describe("a transition's type", () => {
	test("one that isn't there is refused, with those that are", async () => {
		const editor = open();
		await expect(
			edit({
				editor,
				args: {
					operations: [{ op: "transition", from: "one00", type: "sparkle" }],
				},
			}),
		).rejects.toThrow("type is one of cross-dissolve, dip-to-black");
	});

	test("by default, a cross-dissolve", async () => {
		const editor = open();
		await edit({
			editor,
			args: { operations: [{ op: "transition", from: "one00" }] },
		});
		expect(
			editor.scenes.getActiveScene().tracks.main.transitions?.[0]?.type,
		).toBe("cross-dissolve");
	});
});

describe("while a project is opening", () => {
	test("edit and undo wait for it", async () => {
		const editor = open();
		Object.assign(editor.project, { loadedProjectId: null });
		await expect(
			edit({ editor, args: { operations: [{ op: "cut", at: 2 }] } }),
		).rejects.toThrow("still opening");
		await expect(
			undoTool.run({ args: {}, context: context({ editor }) }),
		).rejects.toThrow("still opening");
		expect(spans({ editor })).toEqual(["one00 0-5", "two00 5-10"]);
	});
});
