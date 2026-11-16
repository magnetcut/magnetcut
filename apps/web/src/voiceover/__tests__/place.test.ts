import { describe, expect, test } from "bun:test";
import type { SceneTracks } from "@/timeline";
import { buildEmptyTrack } from "@/timeline/placement/track-factory";
import type { MediaAsset } from "@/media/types";
import { mediaTimeFromSeconds } from "@/wasm";
import { assignLanes, buildSoundElement, findLanes } from "../place";

describe("lanes for sounds", () => {
	test("a sound goes on the first lane where it overlaps nothing", () => {
		expect(
			assignLanes({
				kept: [[{ start: 0, end: 2 }], []],
				sounds: [
					{ start: 1, end: 3 },
					{ start: 2, end: 4 },
					{ start: 2.5, end: 5 },
				],
			}),
		).toEqual([1, 0, 2]);
	});

	test("sounds that touch share a lane", () => {
		expect(
			assignLanes({
				kept: [],
				sounds: [
					{ start: 0, end: 1 },
					{ start: 1, end: 2 },
				],
			}),
		).toEqual([0, 0]);
	});

	test("the lanes are the tracks with the name, then numbered", () => {
		const tracks: SceneTracks = {
			main: buildEmptyTrack({ id: "main", type: "video" }),
			overlay: [],
			audio: [
				buildEmptyTrack({ id: "c", type: "audio", name: "Voice-over 3" }),
				buildEmptyTrack({ id: "m", type: "audio", name: "Music" }),
				buildEmptyTrack({ id: "a", type: "audio", name: "Voice-over" }),
				buildEmptyTrack({ id: "x", type: "audio", name: "Voice-over two" }),
				buildEmptyTrack({ id: "b", type: "audio", name: "Voice-over 2" }),
			],
		};
		expect(
			findLanes({ tracks, name: "Voice-over" }).map(({ id }) => id),
		).toEqual(["a", "b", "c"]);
	});
});

describe("a sound's clip", () => {
	test("sped up to fit, it keeps the file's length, so 1x plays all of it", () => {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- a stand-in with only what a clip reads.
		const asset = {
			id: "cue",
			name: "Hello · 0123456789abcdef.wav",
			duration: 2.5,
		} as MediaAsset;
		const element = buildSoundElement({
			sound: {
				asset,
				startTime: mediaTimeFromSeconds({ seconds: 1 }),
				duration: mediaTimeFromSeconds({ seconds: 2 }),
				retime: { rate: 1.25, maintainPitch: true },
			},
		});
		expect(element.duration).toBe(mediaTimeFromSeconds({ seconds: 2 }));
		expect("sourceDuration" in element ? element.sourceDuration : null).toBe(
			mediaTimeFromSeconds({ seconds: 2.5 }),
		);
	});
});
