import { describe, expect, test } from "bun:test";
import type { Transform } from "@/rendering";
import type { SceneTracks, VideoElement } from "@/timeline";
import { applyElementUpdate } from "@/timeline/update-pipeline";
import { mediaTime, TICKS_PER_SECOND, ZERO_MEDIA_TIME } from "@/wasm";

function buildTransform(): Transform {
	return {
		scaleX: 1,
		scaleY: 1,
		position: { x: 0, y: 0 },
		rotate: 0,
	};
}

function buildVideoElement(overrides: Partial<VideoElement> = {}): VideoElement {
	return {
		id: "video-1",
		type: "video",
		name: "Video 1",
		startTime: ZERO_MEDIA_TIME,
		duration: mediaTime({ ticks: 10 }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		mediaId: "media-1",
		params: {
			"transform.positionX": 0,
			"transform.positionY": 0,
			"transform.scaleX": 1,
			"transform.scaleY": 1,
			"transform.rotate": 0,
			opacity: 1,
		},
		...overrides,
	};
}

function buildTracks(element: VideoElement): SceneTracks {
	return {
		overlay: [],
		main: {
			id: "main-track",
			type: "video",
			name: "Main",
			muted: false,
			hidden: false,
			elements: [element],
		},
		audio: [],
	};
}

describe("applyElementUpdate", () => {
	test("rounds retimed durations back to integer media time", () => {
		const element = buildVideoElement();
		const tracks = buildTracks(element);

		const updatedElement = applyElementUpdate({
			element,
			patch: {
				retime: { rate: 1.5 },
			},
			context: {
				tracks,
				trackId: tracks.main.id,
			},
		});

		expect(updatedElement.duration).toBe(mediaTime({ ticks: 7 }));
		expect(Number.isInteger(updatedElement.duration)).toBe(true);
	});
});

describe("a speed change", () => {
	const second = TICKS_PER_SECOND;
	/** Five seconds of a 20-second file, with B after it on its track. */
	function slowDown({ nextAt }: { nextAt: number | null }) {
		const a = buildVideoElement({
			duration: mediaTime({ ticks: 5 * second }),
			trimEnd: mediaTime({ ticks: 15 * second }),
			sourceDuration: mediaTime({ ticks: 20 * second }),
		});
		const tracks = buildTracks(a);
		if (nextAt !== null) {
			tracks.main.elements.push(
				buildVideoElement({
					id: "video-2",
					startTime: mediaTime({ ticks: nextAt * second }),
				}),
			);
		}
		const updated = applyElementUpdate({
			element: a,
			patch: { retime: { rate: 0.5 } },
			context: { tracks, trackId: tracks.main.id },
		});
		return {
			duration: updated.duration / second,
			trimEnd: updated.trimEnd / second,
		};
	}

	test("slowing a clip down lengthens it", () => {
		expect(slowDown({ nextAt: null })).toEqual({ duration: 10, trimEnd: 15 });
	});

	test("it stops where the next clip starts, the rest of its media after its end", () => {
		expect(slowDown({ nextAt: 5 })).toEqual({ duration: 5, trimEnd: 17.5 });
		expect(slowDown({ nextAt: 8 })).toEqual({ duration: 8, trimEnd: 16 });
	});
});
