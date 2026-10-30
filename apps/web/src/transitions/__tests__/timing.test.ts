import { describe, expect, test } from "bun:test";
import type {
	ImageElement,
	Transition,
	VideoElement,
	VideoTrack,
} from "@/timeline";
import { getTransitionProgress, resolveTrackTransitions } from "@/transitions";
import { mediaTime, TICKS_PER_SECOND } from "@/wasm";

const seconds = (value: number) =>
	mediaTime({ ticks: Math.round(value * TICKS_PER_SECOND) });

function video({
	id,
	start,
	duration,
	trimStart = 0,
	trimEnd = 0,
	rate,
}: {
	id: string;
	start: number;
	duration: number;
	trimStart?: number;
	trimEnd?: number;
	rate?: number;
}): VideoElement {
	return {
		id,
		type: "video",
		name: id,
		mediaId: "clip",
		startTime: seconds(start),
		duration: seconds(duration),
		trimStart: seconds(trimStart),
		trimEnd: seconds(trimEnd),
		params: {},
		...(rate && { retime: { rate } }),
	};
}

function image({
	id,
	start,
	duration,
}: {
	id: string;
	start: number;
	duration: number;
}): ImageElement {
	return {
		id,
		type: "image",
		name: id,
		mediaId: "still",
		startTime: seconds(start),
		duration: seconds(duration),
		trimStart: seconds(0),
		trimEnd: seconds(0),
		params: {},
	};
}

function dissolve({
	duration = 1,
	alignment = "center",
}: {
	duration?: number;
	alignment?: Transition["alignment"];
} = {}): Transition {
	return {
		id: "t",
		fromElementId: "a",
		toElementId: "b",
		type: "cross-dissolve",
		duration: seconds(duration),
		alignment,
		params: {},
		crossfadeAudio: true,
	};
}

function track({
	elements,
	transitions,
}: {
	elements: (VideoElement | ImageElement)[];
	transitions: Transition[];
}): VideoTrack {
	return {
		id: "main",
		name: "Main",
		type: "video",
		elements,
		muted: false,
		hidden: false,
		transitions,
	};
}

function windowOf({ transitionTrack }: { transitionTrack: VideoTrack }) {
	const [resolved] = resolveTrackTransitions({ track: transitionTrack });
	return resolved
		? {
				start: resolved.window.start / TICKS_PER_SECOND,
				end: resolved.window.end / TICKS_PER_SECOND,
				clamped: resolved.window.clamped,
			}
		: null;
}

describe("transitions on a track", () => {
	test("centred on the cut, within the handles", () => {
		const transitionTrack = track({
			elements: [
				video({ id: "a", start: 0, duration: 5, trimEnd: 2 }),
				video({ id: "b", start: 5, duration: 5, trimStart: 2 }),
			],
			transitions: [dissolve()],
		});
		expect(windowOf({ transitionTrack })).toEqual({
			start: 4.5,
			end: 5.5,
			clamped: false,
		});
	});

	test("shortened to the media past the cut", () => {
		const transitionTrack = track({
			elements: [
				video({ id: "a", start: 0, duration: 5, trimEnd: 0.25 }),
				video({ id: "b", start: 5, duration: 5, trimStart: 2 }),
			],
			transitions: [dissolve()],
		});
		expect(windowOf({ transitionTrack })).toEqual({
			start: 4.75,
			end: 5.25,
			clamped: true,
		});
	});

	test("handles in timeline time, at the clip's speed", () => {
		// At 2x, 1 s of media past the end is 0.5 s of timeline.
		const transitionTrack = track({
			elements: [
				video({ id: "a", start: 0, duration: 5, trimEnd: 1, rate: 2 }),
				video({ id: "b", start: 5, duration: 5, trimStart: 2 }),
			],
			transitions: [dissolve({ duration: 2 })],
		});
		expect(windowOf({ transitionTrack })).toEqual({
			start: 4.5,
			end: 5.5,
			clamped: true,
		});
	});

	test("images have no limit but their own length", () => {
		const transitionTrack = track({
			elements: [
				image({ id: "a", start: 0, duration: 5 }),
				image({ id: "b", start: 5, duration: 5 }),
			],
			transitions: [dissolve({ duration: 2, alignment: "end" })],
		});
		expect(windowOf({ transitionTrack })).toEqual({
			start: 3,
			end: 5,
			clamped: false,
		});
	});

	test("none without media past the cut", () => {
		const transitionTrack = track({
			elements: [
				video({ id: "a", start: 0, duration: 5 }),
				video({ id: "b", start: 5, duration: 5 }),
			],
			transitions: [dissolve()],
		});
		expect(windowOf({ transitionTrack })).toBeNull();
	});

	test("none between clips that don't touch, or a hidden one", () => {
		const apart = track({
			elements: [
				image({ id: "a", start: 0, duration: 5 }),
				image({ id: "b", start: 6, duration: 5 }),
			],
			transitions: [dissolve()],
		});
		expect(windowOf({ transitionTrack: apart })).toBeNull();
		const hidden = track({
			elements: [
				image({ id: "a", start: 0, duration: 5 }),
				{ ...image({ id: "b", start: 5, duration: 5 }), hidden: true },
			],
			transitions: [dissolve()],
		});
		expect(windowOf({ transitionTrack: hidden })).toBeNull();
	});

	test("progress across the window", () => {
		const window = { start: seconds(4.5), end: seconds(5.5), clamped: false };
		expect(getTransitionProgress({ window, time: seconds(4.5) })).toBe(0);
		expect(getTransitionProgress({ window, time: seconds(5) })).toBe(0.5);
		expect(getTransitionProgress({ window, time: seconds(5.5) })).toBe(1);
	});
});
