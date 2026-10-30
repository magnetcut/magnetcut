import {
	fixSubtitleDurations,
	fixSubtitleOverlaps,
	retimeCues,
	saveSubtitles,
	snapSubtitleEdges,
	type Retime,
	type SubtitleCueData,
	type SubtitleFormat,
} from "magnetcut-wasm";
import type { SceneTracks, TextTrack, TimelineElement } from "@/timeline";
import type { CaptionChunk } from "@/transcription/types";
import { mediaTimeFromSeconds, mediaTimeToSeconds } from "@/wasm";

// A subtitle track's lines (docs/SUBTITLES.md, phase 3): its text elements
// read as the Rust core's cues, and the core's changes written back as
// element updates, which undo as one.

/** The scene's text tracks of subtitles, top first. */
export function getSubtitleTracks({
	tracks,
}: {
	tracks: SceneTracks;
}): TextTrack[] {
	return tracks.overlay.filter(
		(track): track is TextTrack => track.type === "text" && !!track.subtitles,
	);
}

export interface SubtitleLine {
	elementId: string;
	cue: SubtitleCueData;
}

/** The track's lines in the order they show. */
export function getSubtitleLines({
	track,
}: {
	track: TextTrack;
}): SubtitleLine[] {
	return track.elements
		.map((element) => {
			const start = mediaTimeToSeconds({ time: element.startTime });
			return {
				elementId: element.id,
				cue: {
					start,
					end: start + mediaTimeToSeconds({ time: element.duration }),
					text:
						typeof element.params.content === "string"
							? element.params.content
							: "",
				},
			};
		})
		.sort((a, b) => a.cue.start - b.cue.start);
}

export interface ElementUpdate {
	trackId: string;
	elementId: string;
	patch: Partial<TimelineElement>;
}

// Closer than this, two times are the same.
const SAME_TIME = 1e-6;

/** What gives the lines these cues' times and texts: for those changed. */
export function getLineUpdates({
	track,
	lines,
	cues,
}: {
	track: TextTrack;
	lines: SubtitleLine[];
	cues: SubtitleCueData[];
}): ElementUpdate[] {
	const updates: ElementUpdate[] = [];
	lines.forEach((line, index) => {
		const cue = cues[index];
		const element = track.elements.find(({ id }) => id === line.elementId);
		if (!cue || !element) return;
		const patch: Partial<TimelineElement> = {};
		const isMoved =
			Math.abs(cue.start - line.cue.start) > SAME_TIME ||
			Math.abs(cue.end - line.cue.end) > SAME_TIME;
		if (isMoved) {
			patch.startTime = mediaTimeFromSeconds({ seconds: cue.start });
			patch.duration = mediaTimeFromSeconds({
				seconds: Math.max(0, cue.end - cue.start),
			});
		}
		if (cue.text !== line.cue.text) {
			patch.params = { ...element.params, content: cue.text };
		}
		if (Object.keys(patch).length > 0) {
			updates.push({ trackId: track.id, elementId: line.elementId, patch });
		}
	});
	return updates;
}

/** The track's lines retimed: `scale * time + offset`. */
export function retimeTrack({
	track,
	retime,
}: {
	track: TextTrack;
	retime: Retime;
}): ElementUpdate[] {
	const lines = getSubtitleLines({ track });
	const cues = retimeCues(
		lines.map(({ cue }) => cue),
		retime,
	);
	return getLineUpdates({ track, lines, cues });
}

/** Each line ending `gap` seconds before the next starts. */
export function fixTrackOverlaps({
	track,
	gap,
}: {
	track: TextTrack;
	gap: number;
}): ElementUpdate[] {
	const lines = getSubtitleLines({ track });
	const cues = fixSubtitleOverlaps(
		lines.map(({ cue }) => cue),
		gap,
	);
	return getLineUpdates({ track, lines, cues });
}

/** Lines long enough to read and short enough not to linger, by Netflix's
 * rules. */
export function fixTrackDurations({
	track,
}: {
	track: TextTrack;
}): ElementUpdate[] {
	const lines = getSubtitleLines({ track });
	const cues = fixSubtitleDurations(
		lines.map(({ cue }) => cue),
		undefined,
	);
	return getLineUpdates({ track, lines, cues });
}

/** The track as a subtitle file's text. MicroDVD needs the frame rate. */
export function saveTrack({
	track,
	format,
	frameRate,
}: {
	track: TextTrack;
	format: SubtitleFormat;
	frameRate?: number;
}): string {
	const cues = getSubtitleLines({ track }).map(({ cue }) => cue);
	return saveSubtitles({ cues }, format, frameRate);
}

/** How fast a line asks to be read, in characters a second. */
export function getReadingSpeed({ cue }: { cue: SubtitleCueData }): number {
	const characters = cue.text.replace(/<\/?[ibu]>|\n/g, "").length;
	return characters / Math.max(cue.end - cue.start, 0.001);
}

/** Seconds as "m:ss.mmm", with hours when there are any. */
export function formatClock({ seconds }: { seconds: number }): string {
	const milliseconds = Math.round(Math.max(0, seconds) * 1000);
	const hours = Math.floor(milliseconds / 3_600_000);
	const minutes = Math.floor(milliseconds / 60_000) % 60;
	const rest = ((milliseconds % 60_000) / 1000).toFixed(3).padStart(6, "0");
	return hours > 0
		? `${hours}:${String(minutes).padStart(2, "0")}:${rest}`
		: `${minutes}:${rest}`;
}

/** "h:mm:ss.mmm", "m:ss.mmm" or seconds, with a comma or a full stop: none
 * if it isn't a time. */
export function parseClock({ text }: { text: string }): number | null {
	const parts = text.trim().replace(",", ".").split(":");
	if (parts.length > 3 || parts.some((part) => !/^\d+(\.\d+)?$/.test(part))) {
		return null;
	}
	return parts.reduce((total, part) => total * 60 + Number(part), 0);
}

/** Where the timeline cuts: each clip's start and end on its video and
 * audio tracks, in seconds. */
export function getCuts({ tracks }: { tracks: SceneTracks }): number[] {
	const cuts = new Set<number>();
	for (const track of [tracks.main, ...tracks.overlay, ...tracks.audio]) {
		if (track.type !== "video" && track.type !== "audio") continue;
		for (const element of track.elements) {
			const start = mediaTimeToSeconds({ time: element.startTime });
			cuts.add(start);
			cuts.add(start + mediaTimeToSeconds({ time: element.duration }));
		}
	}
	return [...cuts].sort((a, b) => a - b);
}

// How far a line's edge is pulled to one nearby, and the shortest it's left.
const SNAP_REACH = 0.3;
const SHORTEST_LINE = 0.2;

/** The track's lines with their starts snapped to the nearest of `starts`,
 * their ends to the nearest of `ends`, within reach. */
export function snapTrack({
	track,
	starts,
	ends,
}: {
	track: TextTrack;
	starts: number[];
	ends: number[];
}): ElementUpdate[] {
	const lines = getSubtitleLines({ track });
	const cues = snapSubtitleEdges(
		lines.map(({ cue }) => cue),
		Float64Array.from(starts),
		Float64Array.from(ends),
		SNAP_REACH,
		SHORTEST_LINE,
	);
	return getLineUpdates({ track, lines, cues });
}

// A line typed while the film plays shows long enough to be read at this
// speed, within these bounds, and ends this long before the next line.
const TYPED_READING_SPEED = 15;
const TYPED_SHORTEST = 1;
const TYPED_LONGEST = 7;
const TYPED_GAP = 2 / 24;

/** A line typed while it plays, from where the typing began. */
export function getTypedCaption({
	track,
	text,
	start,
}: {
	track: TextTrack;
	text: string;
	start: number;
}): CaptionChunk {
	const wanted = Math.min(
		TYPED_LONGEST,
		Math.max(TYPED_SHORTEST, text.length / TYPED_READING_SPEED),
	);
	const next = getSubtitleLines({ track }).find(({ cue }) => cue.start > start);
	const end = next
		? Math.max(
				start + 0.1,
				Math.min(start + wanted, next.cue.start - TYPED_GAP),
			)
		: start + wanted;
	return { text, startTime: start, duration: end - start };
}

/** The line of `original` a translated line stands for: the one it
 * overlaps most in time, if any. */
export function getOriginalLine({
	original,
	cue,
}: {
	original: TextTrack;
	cue: SubtitleCueData;
}): SubtitleLine | null {
	let best: { line: SubtitleLine; overlap: number } | null = null;
	for (const line of getSubtitleLines({ track: original })) {
		const overlap =
			Math.min(cue.end, line.cue.end) - Math.max(cue.start, line.cue.start);
		if (overlap > 0 && (!best || overlap > best.overlap)) {
			best = { line, overlap };
		}
	}
	return best?.line ?? null;
}
