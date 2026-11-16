import { describe, expect, test } from "bun:test";
import {
	DeleteElementsCommand,
	DuplicateElementsCommand,
	InsertElementCommand,
	PasteCommand,
	ToggleSourceAudioSeparationCommand,
} from "@/commands";
import type { Command } from "@/commands";
import { EditorCore } from "@/core";
import type { CreateVideoElement, ElementRef } from "@/timeline";
import { allElements, clip, openEditor, s, tracksWith } from "./editor";

// A command redone makes what it made the first time, with the same ids: the
// steps after it in the history refer to them. Each case makes something,
// deletes it, undoes both and redoes both: the delete must find it again.

function makeThenDelete({
	command,
	made,
}: {
	command: Command;
	made: () => ElementRef[];
}) {
	const editor = openEditor({
		tracks: tracksWith({
			elements: [clip({ id: "one", start: 0, length: 5 })],
		}),
	});
	editor.command.execute({ command });
	const refs = made();
	expect(refs).toHaveLength(1);
	editor.command.execute({
		command: new DeleteElementsCommand({ elements: refs }),
	});

	editor.command.undo();
	editor.command.undo();
	editor.command.redo();
	editor.command.redo();

	return allElements({ editor }).map(({ element }) => element.id);
}

describe("redoing what makes new clips", () => {
	test("paste", () => {
		const paste = new PasteCommand({
			time: s(20),
			clipboardItems: [
				{
					trackId: "main",
					trackType: "video",
					element: clip({ id: "copied", start: 0, length: 5 }),
				},
			],
		});
		expect(
			makeThenDelete({
				command: paste,
				made: () => paste.getPastedElements(),
			}),
		).toEqual(["one"]);
	});

	test("duplicate, onto a new track", () => {
		const duplicate = new DuplicateElementsCommand({
			elements: [{ trackId: "main", elementId: "one" }],
		});
		expect(
			makeThenDelete({
				command: duplicate,
				made: () => duplicate.getDuplicatedElements(),
			}),
		).toEqual(["one"]);
	});

	test("insert, onto a new track", () => {
		const element: CreateVideoElement = {
			type: "video",
			name: "new",
			mediaId: "film",
			startTime: s(0),
			duration: s(5),
			trimStart: s(0),
			trimEnd: s(0),
			params: {},
		};
		const insert = new InsertElementCommand({
			element,
			placement: { mode: "auto", trackType: "video", insertIndex: 0 },
		});
		expect(
			makeThenDelete({
				command: insert,
				made: () => {
					const trackId = insert.getTrackId();
					return trackId ? [{ trackId, elementId: insert.getElementId() }] : [];
				},
			}),
		).toEqual(["one"]);
	});

	test("extract audio", () => {
		const extract = new ToggleSourceAudioSeparationCommand({
			trackId: "main",
			elementId: "one",
		});
		const ids = makeThenDelete({
			command: extract,
			made: () =>
				EditorCore.getInstance()
					.scenes.getActiveScene()
					.tracks.audio.flatMap((track) =>
						track.elements.map((element) => ({
							trackId: track.id,
							elementId: element.id,
						})),
					),
		});
		expect(ids).toEqual(["one"]);
	});
});
