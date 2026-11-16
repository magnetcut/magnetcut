import { describe, expect, test } from "bun:test";
import { RemoveTransitionCommand } from "@/commands";
import type { Transition } from "@/timeline";
import { clip, openEditor, s, tracksWith } from "./editor";

function dissolve({ id }: { id: string }): Transition {
	return {
		id,
		fromElementId: "one",
		toElementId: "two",
		type: "cross-dissolve",
		duration: s(1),
		alignment: "center",
		params: {},
		crossfadeAudio: true,
	};
}

function open() {
	return openEditor({
		tracks: tracksWith({
			elements: [
				clip({ id: "one", start: 0, length: 5 }),
				clip({ id: "two", start: 5, length: 5 }),
			],
			transitions: [dissolve({ id: "dissolve" })],
		}),
	});
}

describe("removing a transition", () => {
	test("deselects it, and undo selects it again", () => {
		const editor = open();
		const ref = { trackId: "main", transitionId: "dissolve" };
		editor.selection.setSelectedTransition({ transition: ref });

		editor.command.execute({ command: new RemoveTransitionCommand(ref) });
		expect(editor.selection.getSelectedTransition()).toBeNull();
		expect(editor.selection.getActiveSelectionKind()).toBeNull();

		editor.command.undo();
		expect(editor.selection.getSelectedTransition()).toEqual(ref);

		editor.command.redo();
		expect(editor.selection.getSelectedTransition()).toBeNull();
	});

	test("leaves the selection alone when another one is selected", () => {
		const editor = open();
		const selected = { trackId: "main", transitionId: "dissolve" };
		editor.selection.setSelectedTransition({ transition: selected });

		editor.command.execute({
			command: new RemoveTransitionCommand({
				trackId: "main",
				transitionId: "elsewhere",
			}),
		});
		expect(editor.selection.getSelectedTransition()).toEqual(selected);
	});
});
