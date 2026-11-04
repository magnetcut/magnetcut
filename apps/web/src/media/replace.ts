import type { EditorCore } from "@/core";
import type { MediaAsset } from "@/media/types";
import {
	getSourceSpanAtClipTime,
	getTimelineDurationForSourceSpan,
} from "@/retime";
import type { TimelineElement } from "@/timeline";
import { toElementDurationTicks } from "@/timeline/creation";
import { findTrackInSceneTracks } from "@/timeline/track-element-update";
import { roundMediaTime, TICKS_PER_SECOND } from "@/wasm";
import { canReadDiskFiles, pickDiskFiles, type MediaFile } from "./disk-file";
import { processMediaAssets } from "./processing";

type MediaElement = Extract<TimelineElement, { mediaId: string }>;

/** A clip whose media is a file: video, image, or sound from a file. */
export function isMediaElement(
	element: TimelineElement,
): element is MediaElement {
	return "mediaId" in element && typeof element.mediaId === "string";
}

/**
 * Whether a file can take a clip's place: a video for a video clip, a picture
 * for a picture, and for a sound clip anything with sound.
 */
export function canReplaceWith({
	element,
	asset,
}: {
	element: MediaElement;
	asset: MediaAsset;
}): boolean {
	switch (element.type) {
		case "video":
			return asset.type === "video";
		case "image":
			return asset.type === "image";
		case "audio":
			return (
				asset.type === "audio" ||
				(asset.type === "video" && asset.hasAudio !== false)
			);
		default:
			return false;
	}
}

/**
 * What changes on a clip when `asset` takes its file's place, its cuts kept:
 * the same moments of the new file, or, with `offset` (in ticks), those that
 * far earlier in it, as in a part of the old file converted. A file too short
 * for the clip keeps the clip's end in it, and a clip longer than the file is
 * shortened to it.
 */
export function buildReplacePatch({
	element,
	asset,
	offset = 0,
}: {
	element: MediaElement;
	asset: MediaAsset;
	offset?: number;
}): Partial<TimelineElement> {
	const name = element.name;
	const patch: Partial<TimelineElement> = { mediaId: asset.id, name };
	if (element.type === "image") return patch;

	const retime = element.type === "video" ? element.retime : undefined;
	const sourceDuration = toElementDurationTicks({ seconds: asset.duration });
	const span = getSourceSpanAtClipTime({ clipTime: element.duration, retime });
	const fits = Math.min(span, sourceDuration);
	const trimStart = Math.max(
		0,
		Math.min(element.trimStart - offset, sourceDuration - fits),
	);
	const duration =
		fits < span
			? roundMediaTime({
					time: getTimelineDurationForSourceSpan({ sourceSpan: fits, retime }),
				})
			: element.duration;
	return {
		...patch,
		trimStart: roundMediaTime({ time: trimStart }),
		trimEnd: roundMediaTime({
			time: Math.max(0, sourceDuration - trimStart - fits),
		}),
		sourceDuration,
		duration,
	};
}

export interface Replacement {
	trackId: string;
	elementId: string;
	asset: MediaAsset;
	/** Ticks into the old file where the new one starts. */
	offset?: number;
}

/** Clips given other files, in one step that Undo takes back. */
export function replaceClipsMedia({
	editor,
	replacements,
}: {
	editor: EditorCore;
	replacements: Replacement[];
}): void {
	const tracks = editor.scenes.getActiveScene().tracks;
	const updates = replacements.flatMap(
		({ trackId, elementId, asset, offset }) => {
			const track = findTrackInSceneTracks({ tracks, trackId });
			const element = track?.elements.find(
				(candidate) => candidate.id === elementId,
			);
			if (!element || !isMediaElement(element)) return [];
			if (!canReplaceWith({ element, asset })) return [];
			return [
				{
					trackId,
					elementId,
					patch: buildReplacePatch({ element, asset, offset }),
				},
			];
		},
	);
	if (updates.length > 0) editor.timeline.updateElements({ updates });
}

/** A file added to the project's media, as Import adds one; null if it can't be. */
export async function addMediaFile({
	editor,
	file,
}: {
	editor: EditorCore;
	file: MediaFile;
}): Promise<MediaAsset | null> {
	const project = editor.project.getActiveOrNull();
	if (!project) return null;
	const [processed] = await processMediaAssets({ files: [file] });
	if (!processed) return null;
	return editor.media.addMediaAsset({
		projectId: project.metadata.id,
		asset: processed,
	});
}

/** One file from the open dialog, or null if none was picked. */
export function pickMediaFile(): Promise<MediaFile | null> {
	if (canReadDiskFiles()) {
		return pickDiskFiles().then((files) => files[0] ?? null);
	}
	return new Promise((resolve) => {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = "video/*,audio/*,image/*";
		input.addEventListener("change", () => resolve(input.files?.[0] ?? null));
		input.addEventListener("cancel", () => resolve(null));
		input.click();
	});
}

/** Seconds of a file as the timeline's ticks. */
export const secondsToTicks = (seconds: number) =>
	Math.round(seconds * TICKS_PER_SECOND);
