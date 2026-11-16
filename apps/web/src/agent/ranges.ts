import { splitAnimationsAtTime } from "@/animation";
import type { SceneTracks, TimelineElement, TimelineTrack } from "@/timeline";
import { splitFadeParams } from "@/timeline/audio-fades";
import { dropBrokenTransitions, followSplitEnds } from "@/transitions";
import { generateUUID } from "@/utils/id";
import { mediaTime } from "@/wasm";

// Stretches of time taken out of the whole timeline, every track at once, and
// what follows closed up (docs/AUTOMATION.md): how an agent cuts a talk by
// its words or its silences. A clip across an edge is shortened, its media
// and keyframes still where they were; one across a whole stretch becomes
// two, joined at the cut, as a split leaves them (its fades and the
// transition at its end with the piece at that end); a transition whose clips
// no longer meet goes.

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

/** An element with one range taken out: what's left of it, at most two.
 * Two: `ends` gets the element's id to the second one's, which ends where it
 * did. */
function cutElement<T extends TimelineElement>({
	element,
	range,
	ends,
}: {
	element: T;
	range: Range;
	ends: Map<string, string>;
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
	const hasLeft = start < range.from;
	const hasRight = end > range.to;
	const fades =
		hasLeft && hasRight
			? splitFadeParams({ params: element.params })
			: { left: element.params, right: element.params };
	const pieces: T[] = [];
	if (hasLeft) {
		pieces.push({
			...element,
			duration: mediaTime({ ticks: range.from - start }),
			trimEnd: source
				? mediaTime({
						ticks: Math.round(element.trimEnd + (end - range.from) * rate),
					})
				: element.trimEnd,
			params: fades.left,
			animations: splitAnimationsAtTime({
				animations: element.animations,
				splitTime: mediaTime({ ticks: range.from - start }),
			}).leftAnimations,
		});
	}
	if (hasRight) {
		const id = hasLeft ? generateUUID() : element.id;
		if (hasLeft) ends.set(element.id, id);
		pieces.push({
			...element,
			id,
			startTime: mediaTime({ ticks: range.from }),
			duration: mediaTime({ ticks: end - range.to }),
			trimStart: source
				? mediaTime({
						ticks: Math.round(element.trimStart + (range.to - start) * rate),
					})
				: element.trimStart,
			params: fades.right,
			// Keyframes count from the clip's start, which now shows what was at
			// the range's end.
			animations: splitAnimationsAtTime({
				animations: element.animations,
				splitTime: mediaTime({ ticks: range.to - start }),
			}).rightAnimations,
		});
	}
	return pieces;
}

function cutTrack<T extends TimelineTrack>({
	track,
	range,
	ends,
}: {
	track: T;
	range: Range;
	ends: Map<string, string>;
}): T {
	const elements = track.elements.flatMap((element) =>
		cutElement({ element, range, ends }),
	);
	return { ...track, elements } as T;
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
		const ends = new Map<string, string>();
		const cut = {
			main: cutTrack({ track: result.main, range, ends }),
			overlay: result.overlay.map((track) => cutTrack({ track, range, ends })),
			audio: result.audio.map((track) => cutTrack({ track, range, ends })),
		};
		result = dropBrokenTransitions({
			tracks: followSplitEnds({ tracks: cut, ends }),
		});
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
