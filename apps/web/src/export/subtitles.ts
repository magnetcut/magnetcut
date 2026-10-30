import type { SceneTracks } from "@/timeline";
import { getSubtitleTracks, saveTrack } from "@/subtitles/track";
import type { ExportFormat } from "./index";
import { createOutputFormat } from "./output-format";

// Subtitles in an export (docs/SUBTITLES.md, phase 6): in the picture, as
// they are on the timeline; as tracks a player turns on and off (WebVTT);
// or both.

export const EXPORT_SUBTITLE_MODES = ["picture", "track", "both"] as const;
export type ExportSubtitles = (typeof EXPORT_SUBTITLE_MODES)[number];

export const SUBTITLE_MODE_NAMES: Record<ExportSubtitles, string> = {
	picture: "In the picture",
	track: "As a track, to turn on and off",
	both: "Both",
};

/** Whether a container takes subtitle tracks: all but QuickTime, for now. */
export function canHoldSubtitleTracks({
	format,
}: {
	format: ExportFormat;
}): boolean {
	return createOutputFormat({ format, isStreamed: true })
		.getSupportedSubtitleCodecs()
		.includes("webvtt");
}

/** The timeline as the picture shows it: without its subtitles, if they go
 * only in tracks. */
export function getPictureTracks({
	tracks,
	subtitles,
}: {
	tracks: SceneTracks;
	subtitles: ExportSubtitles;
}): SceneTracks {
	if (subtitles !== "track") return tracks;
	return {
		...tracks,
		overlay: tracks.overlay.map((track) =>
			track.type === "text" && track.subtitles
				? { ...track, hidden: true }
				: track,
		),
	};
}

/** Each subtitle track as a WebVTT file, for a track of the export: none if
 * they go only in the picture. */
export function getSubtitleFiles({
	tracks,
	subtitles,
}: {
	tracks: SceneTracks;
	subtitles: ExportSubtitles;
}): Array<{ name: string; vtt: string }> {
	if (subtitles === "picture") return [];
	return getSubtitleTracks({ tracks }).map((track) => ({
		name: track.name,
		vtt: saveTrack({ track, format: "vtt" }),
	}));
}
