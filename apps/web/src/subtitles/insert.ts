import type { AssScriptData } from "magnetcut-wasm";
import type { EditorCore } from "@/core";
import {
	AddTrackCommand,
	BatchCommand,
	InsertElementCommand,
} from "@/commands";
import type { TextTrack } from "@/timeline";
import { buildSubtitleTextElement } from "./build-subtitle-text-element";
import type { SubtitleCue } from "./types";

export function insertCaptionChunksAsTextTrack({
	editor,
	captions,
	assScript,
}: {
	editor: EditorCore;
	captions: SubtitleCue[];
	/** The ASS or SSA file they were opened from, to save them back in. */
	assScript?: AssScriptData;
}): string | null {
	if (captions.length === 0) {
		return null;
	}

	const addTrackCommand = new AddTrackCommand({
		type: "text",
		index: 0,
		subtitles: true,
		assScript,
	});
	const trackId = addTrackCommand.getTrackId();
	const canvasSize = editor.project.getActive().settings.canvasSize;
	const insertCommands = captions.map(
		(caption, index) =>
			new InsertElementCommand({
				placement: { mode: "explicit", trackId },
				element: buildSubtitleTextElement({
					index,
					caption,
					canvasSize,
				}),
			}),
	);
	editor.command.execute({
		command: new BatchCommand([addTrackCommand, ...insertCommands]),
	});

	return trackId;
}

/**
 * A translation of `track`: a subtitle track above it, timed as it is, its
 * lines copied to be written over in the other language (Captions'
 * Translate), and spoken in it, a dubbed version (docs/VOICEOVER.md).
 */
export function addTranslationTrack({
	editor,
	track,
}: {
	editor: EditorCore;
	track: TextTrack;
}): string {
	const addTrack = new AddTrackCommand({
		type: "text",
		index: 0,
		subtitles: true,
		name: `${track.name} (translation)`,
		translationOf: track.id,
		assScript: track.assScript,
	});
	const trackId = addTrack.getTrackId();
	const inserts = track.elements.map(
		({ id: _id, ...element }) =>
			new InsertElementCommand({
				placement: { mode: "explicit", trackId },
				element,
			}),
	);
	editor.command.execute({
		command: new BatchCommand([addTrack, ...inserts]),
	});
	return trackId;
}
