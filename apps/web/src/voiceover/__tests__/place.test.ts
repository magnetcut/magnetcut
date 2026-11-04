import { describe, expect, test } from "bun:test";
import type { SceneTracks } from "@/timeline";
import { buildEmptyTrack } from "@/timeline/placement/track-factory";
import { assignLanes, findLanes } from "../place";

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
