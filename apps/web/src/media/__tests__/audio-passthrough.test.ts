import { describe, expect, test } from "bun:test";
import { findPassthroughClip } from "../audio-mix";
import type { MediaAsset } from "../types";
import type { AudioElement, SceneTracks, VideoElement } from "@/timeline";
import { mediaTime, TICKS_PER_SECOND } from "@/wasm";

const seconds = (value: number) =>
	mediaTime({ ticks: Math.round(value * TICKS_PER_SECOND) });

const film: MediaAsset = {
	id: "film",
	name: "film.mp4",
	type: "video",
	file: new File([], "film.mp4"),
	duration: 60,
	hasAudio: true,
};

function filmClip(overrides: Partial<VideoElement> = {}): VideoElement {
	return {
		id: "v",
		type: "video",
		name: "film",
		mediaId: "film",
		startTime: seconds(0),
		duration: seconds(60),
		trimStart: seconds(0),
		trimEnd: seconds(0),
		params: {},
		...overrides,
	};
}

function timeline({
	main,
	audio = [],
}: {
	main: VideoElement[];
	audio?: AudioElement[];
}): SceneTracks {
	return {
		overlay: [],
		main: {
			id: "main",
			name: "Main",
			type: "video",
			elements: main,
			muted: false,
			hidden: false,
		},
		audio: [
			{ id: "a", name: "Audio", type: "audio", elements: audio, muted: false },
		],
	};
}

function find({
	tracks,
	duration = 60,
}: {
	tracks: SceneTracks;
	duration?: number;
}) {
	return findPassthroughClip({
		tracks,
		mediaAssets: [film],
		duration: seconds(duration),
	});
}

describe("findPassthroughClip", () => {
	test("is a film's sound played whole", () => {
		const clip = find({ tracks: timeline({ main: [filmClip()] }) });
		expect(clip?.asset.id).toBe("film");
		expect(clip?.end).toBeCloseTo(60);
	});

	test("may stop early, where the clip or the timeline does", () => {
		const shorter = filmClip({
			duration: seconds(40),
			trimEnd: seconds(20),
		});
		expect(find({ tracks: timeline({ main: [shorter] }) })?.end).toBeCloseTo(
			40,
		);
		expect(
			find({ tracks: timeline({ main: [filmClip()] }), duration: 30 })?.end,
		).toBeCloseTo(30);
	});

	test("is none when the sound starts anywhere but at the start of both", () => {
		const trimmed = filmClip({ trimStart: seconds(5), duration: seconds(55) });
		const late = filmClip({ startTime: seconds(2) });
		expect(find({ tracks: timeline({ main: [trimmed] }) })).toBeNull();
		expect(find({ tracks: timeline({ main: [late] }) })).toBeNull();
	});

	test("is none when the sound is changed", () => {
		const quieter = filmClip({ params: { volume: -3 } });
		const faster = filmClip({ retime: { rate: 1.5 } });
		expect(find({ tracks: timeline({ main: [quieter] }) })).toBeNull();
		expect(find({ tracks: timeline({ main: [faster] }) })).toBeNull();
		// A speed set back to normal changes nothing.
		const normal = filmClip({ retime: { rate: 1 } });
		expect(find({ tracks: timeline({ main: [normal] }) })).not.toBeNull();
	});

	test("is none when something else is heard", () => {
		const music: AudioElement = {
			id: "m",
			type: "audio",
			sourceType: "library",
			sourceUrl: "https://example.invalid/music.mp3",
			name: "music",
			startTime: seconds(10),
			duration: seconds(5),
			trimStart: seconds(0),
			trimEnd: seconds(0),
			params: {},
		};
		expect(
			find({ tracks: timeline({ main: [filmClip()], audio: [music] }) }),
		).toBeNull();
	});

	test("is none when nothing is heard", () => {
		const muted = filmClip({ params: { muted: true } });
		expect(find({ tracks: timeline({ main: [] }) })).toBeNull();
		expect(find({ tracks: timeline({ main: [muted] }) })).toBeNull();
	});
});
