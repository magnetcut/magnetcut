import type {
	SceneTracks,
	TimelineElement,
	TimelineTrack,
	Transition,
} from "@/timeline";
import { generateUUID } from "@/utils/id";
import { mediaTime } from "@/wasm";

// Stretches of time taken out of the whole timeline, every track at once, and
// what follows closed up (docs/AUTOMATION.md): how an agent cuts a talk by
// its words or its silences. A clip across an edge is shortened, its media
// still where it was; one across a whole stretch becomes two, joined at the
// cut; a transition whose clips no longer meet goes.

/** A stretch, in ticks. */
export interface Range {
	from: number;
	to: number;
}

/** How fast a clip plays its media: what's under a tick of timeline. */
function rateOf({ element }: { element: TimelineElement }): number {
	return (element.type === "video" || element.type === "audio") &&
		element.retime
		? element.retime.rate
		: 1;
}

function hasSource({ element }: { element: TimelineElement }): boolean {
	return element.type === "video" || element.type === "audio";
}

/** An element with one range taken out: what's left of it, at most two. */
function cutElement<T extends TimelineElement>({
	element,
	range,
}: {
	element: T;
	range: Range;
}): T[] {
	const start = element.startTime;
	const end = element.startTime + element.duration;
	const removed = range.to - range.from;
	if (end <= range.from) return [element];
	if (start >= range.to) {
		return [{ ...element, startTime: mediaTime({ ticks: start - removed }) }];
	}
	const rate = rateOf({ element });
	const source = hasSource({ element });
	const pieces: T[] = [];
	if (start < range.from) {
		pieces.push({
			...element,
			duration: mediaTime({ ticks: range.from - start }),
			trimEnd: source
				? mediaTime({
						ticks: Math.round(element.trimEnd + (end - range.from) * rate),
					})
				: element.trimEnd,
		});
	}
	if (end > range.to) {
		const keepsId = pieces.length === 0;
		pieces.push({
			...element,
			id: keepsId ? element.id : generateUUID(),
			startTime: mediaTime({ ticks: range.from }),
			duration: mediaTime({ ticks: end - range.to }),
			trimStart: source
				? mediaTime({
						ticks: Math.round(element.trimStart + (range.to - start) * rate),
					})
				: element.trimStart,
		});
	}
	return pieces;
}

function cutTrack<T extends TimelineTrack>({
	track,
	range,
}: {
	track: T;
	range: Range;
}): T {
	const elements = track.elements.flatMap((element) =>
		cutElement({ element, range }),
	);
	if (track.type !== "video") return { ...track, elements } as T;
	const byId = new Map(elements.map((element) => [element.id, element]));
	const transitions = (track.transitions ?? []).filter(
		(transition: Transition) => {
			const from = byId.get(transition.fromElementId);
			const to = byId.get(transition.toElementId);
			return !!from && !!to && from.startTime + from.duration === to.startTime;
		},
	);
	return { ...track, elements, transitions } as T;
}

/** The tracks with `ranges` taken out, the latest first so that each is
 * where it was given. */
export function removeRanges({
	tracks,
	ranges,
}: {
	tracks: SceneTracks;
	ranges: Range[];
}): SceneTracks {
	const ordered = [...ranges]
		.filter((range) => range.to > range.from)
		.sort((a, b) => b.from - a.from);
	let result = tracks;
	for (const range of ordered) {
		result = {
			main: cutTrack({ track: result.main, range }),
			overlay: result.overlay.map((track) => cutTrack({ track, range })),
			audio: result.audio.map((track) => cutTrack({ track, range })),
		};
	}
	return result;
}

/** Overlapping or touching ranges as one each. */
export function mergeRanges({ ranges }: { ranges: Range[] }): Range[] {
	const sorted = [...ranges].sort((a, b) => a.from - b.from);
	const merged: Range[] = [];
	for (const range of sorted) {
		const last = merged[merged.length - 1];
		if (last && range.from <= last.to) last.to = Math.max(last.to, range.to);
		else merged.push({ ...range });
	}
	return merged;
}
