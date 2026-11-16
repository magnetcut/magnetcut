import { describe, expect, test } from "bun:test";
import { DeleteElementsCommand, SplitElementsCommand } from "@/commands";
import { allElements, clip, openEditor, s, tracksWith } from "./editor";

describe("splitting a clip", () => {
	test("its fade in stays on the left half and its fade out on the right", () => {
		const editor = openEditor({
			tracks: tracksWith({
				elements: [
					clip({
						id: "one",
						start: 0,
						length: 10,
						params: { fadeIn: 1, fadeOut: 2, fadeOutLevel: -12 },
					}),
				],
			}),
		});

		editor.command.execute({
			command: new SplitElementsCommand({
				elements: [{ trackId: "main", elementId: "one" }],
				splitTime: s(5),
			}),
		});

		const [left, right] = editor.scenes.getActiveScene().tracks.main.elements;
		expect(left.params).toMatchObject({ fadeIn: 1, fadeOut: 0 });
		expect(right.params).toMatchObject({
			fadeIn: 0,
			fadeOut: 2,
			fadeOutLevel: -12,
		});
	});

	test("keeping one side, that side keeps only its own end's fade", () => {
		const editor = openEditor({
			tracks: tracksWith({
				elements: [
					clip({
						id: "one",
						start: 0,
						length: 10,
						params: { fadeIn: 1, fadeOut: 2 },
					}),
				],
			}),
		});

		editor.command.execute({
			command: new SplitElementsCommand({
				elements: [{ trackId: "main", elementId: "one" }],
				splitTime: s(5),
				retainSide: "left",
			}),
		});

		const [left] = editor.scenes.getActiveScene().tracks.main.elements;
		expect(left.params).toMatchObject({ fadeIn: 1, fadeOut: 0 });
	});

	test("redone, the right half has the same id, so a later step redone still finds it", () => {
		const editor = openEditor({
			tracks: tracksWith({
				elements: [clip({ id: "one", start: 0, length: 10 })],
			}),
		});
		const split = new SplitElementsCommand({
			elements: [{ trackId: "main", elementId: "one" }],
			splitTime: s(4),
		});
		editor.command.execute({ command: split });
		const [right] = split.getRightSideElements();
		editor.command.execute({
			command: new DeleteElementsCommand({ elements: [right] }),
		});

		editor.command.undo();
		editor.command.undo();
		editor.command.redo();
		editor.command.redo();

		expect(
			allElements({ editor }).map(({ element }) => ({
				id: element.id,
				duration: element.duration,
			})),
		).toEqual([{ id: "one", duration: s(4) }]);
	});

	test("the halves it selects deselect a selected transition", () => {
		const editor = openEditor({
			tracks: tracksWith({
				elements: [
					clip({ id: "one", start: 0, length: 10 }),
					clip({ id: "two", start: 10, length: 10 }),
				],
				transitions: [
					{
						id: "dissolve",
						fromElementId: "one",
						toElementId: "two",
						type: "cross-dissolve",
						duration: s(1),
						alignment: "center",
						params: {},
						crossfadeAudio: true,
					},
				],
			}),
		});
		editor.selection.setSelectedTransition({
			transition: { trackId: "main", transitionId: "dissolve" },
		});

		const split = new SplitElementsCommand({
			elements: [{ trackId: "main", elementId: "two" }],
			splitTime: s(15),
		});
		editor.command.execute({ command: split });

		expect(editor.selection.getSelectedTransition()).toBeNull();
		expect(editor.selection.getActiveSelectionKind()).toBe("elements");
		expect(editor.selection.getSelectedElements()).toEqual(
			split.getRightSideElements(),
		);
	});
});
