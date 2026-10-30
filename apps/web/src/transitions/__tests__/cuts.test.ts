import { describe, expect, test } from "bun:test";
import type { SceneTracks, VideoElement, VideoTrack } from "@/timeline";
import { findNearestCut, getTrackCuts } from "@/transitions";
import { mediaTime, TICKS_PER_SECOND } from "@/wasm";

const seconds = (value: number) =>
	mediaTime({ ticks: Math.round(value * TICKS_PER_SECOND) });

function video({
	id,
	start,
	duration,
}: {
	id: string;
	start: number;
	duration: number;
}): VideoElement {
	return {
		id,
		type: "video",
		name: id,
		mediaId: "clip",
		startTime: seconds(start),
		duration: seconds(duration),
		trimStart: seconds(0),
		trimEnd: seconds(0),
		params: {},
	};
}

function track({
	id,
	elements,
}: {
	id: string;
	elements: VideoElement[];
}): VideoTrack {
	return { id, name: id, type: "video", elements, muted: false, hidden: false };
}

// Cuts at 2 and 5 on the main track, and at 3 on an overlay; a gap from 6 to 7.
const tracks: SceneTracks = {
	main: track({
		id: "main",
		elements: [
			video({ id: "c", start: 5, duration: 1 }),
			video({ id: "a", start: 0, duration: 2 }),
			video({ id: "b", start: 2, duration: 3 }),
			video({ id: "d", start: 7, duration: 1 }),
		],
	}),
	overlay: [
		track({
			id: "overlay",
			elements: [
				video({ id: "x", start: 1, duration: 2 }),
				video({ id: "y", start: 3, duration: 2 }),
			],
		}),
	],
	audio: [],
};

const cutAt = ({
	time,
	elementIds,
}: {
	time: number;
	elementIds?: string[];
}) => {
	const cut = findNearestCut({ tracks, time: seconds(time), elementIds });
	return cut && `${cut.trackId} ${cut.from.id}|${cut.to.id}`;
};

describe("cuts", () => {
	test("where touching clips meet, in time order, not across gaps", () => {
		const cuts = getTrackCuts({ track: tracks.main });
		expect(cuts.map(({ from, to }) => `${from.id}|${to.id}`)).toEqual([
			"a|b",
			"b|c",
		]);
	});

	test("the nearest on any track", () => {
		expect(cutAt({ time: 1.8 })).toBe("main a|b");
		expect(cutAt({ time: 3.2 })).toBe("overlay x|y");
		expect(cutAt({ time: 9 })).toBe("main b|c");
	});

	test("the nearest beside the selected clips", () => {
		expect(cutAt({ time: 3.2, elementIds: ["b"] })).toBe("main a|b");
		expect(cutAt({ time: 3.2, elementIds: ["c"] })).toBe("main b|c");
		expect(cutAt({ time: 3.2, elementIds: ["d"] })).toBeNull();
	});
});
