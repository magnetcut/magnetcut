import { toast } from "sonner";
import type { EditorCore } from "@/core";
import type { MediaAsset } from "@/media/types";
import type { TimelineElement } from "@/timeline";
import {
	addMediaFile,
	canReplaceWith,
	isMediaElement,
	pickMediaFile,
	replaceClipsMedia,
} from "./replace";

const WHAT_REPLACES: Record<string, string> = {
	video: "Only a video can take a video clip's place.",
	image: "Only a picture can take a picture's place.",
	audio: "Only a file with sound can take a sound clip's place.",
};

/** A clip given another file, as Replace media and a drop on it do; false if it can't take it. */
export function replaceWithAsset({
	editor,
	trackId,
	element,
	asset,
}: {
	editor: EditorCore;
	trackId: string;
	element: TimelineElement;
	asset: MediaAsset;
}): boolean {
	if (!isMediaElement(element)) return false;
	if (!canReplaceWith({ element, asset })) {
		toast.error(`"${asset.name}" can't replace "${element.name}"`, {
			description: WHAT_REPLACES[element.type],
		});
		return false;
	}
	replaceClipsMedia({
		editor,
		replacements: [{ trackId, elementId: element.id, asset }],
	});
	return true;
}

/** Replace media: a file picked, added to the project, and put in the clip's place. */
export async function replaceFromPicker({
	editor,
	trackId,
	element,
}: {
	editor: EditorCore;
	trackId: string;
	element: TimelineElement;
}): Promise<void> {
	if (!isMediaElement(element)) return;
	try {
		const file = await pickMediaFile();
		if (!file) return;
		const asset = await addMediaFile({ editor, file });
		if (!asset) {
			toast.error(`Couldn't open "${file.name}"`);
			return;
		}
		replaceWithAsset({ editor, trackId, element, asset });
	} catch (error) {
		toast.error("Couldn't replace the media", {
			description: error instanceof Error ? error.message : String(error),
		});
	}
}
