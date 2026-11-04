import { describe, expect, test } from "bun:test";
import type { MediaAsset } from "@/media/types";
import type { SceneTracks, UploadAudioElement, VideoElement } from "@/timeline";
import { mediaTime, TICKS_PER_SECOND } from "@/wasm";
import {
	buildFastSoundTracks,
	collectFastClips,
	cutAudioElement,
	hasAudibleAudioTracks,
	isSoundUnchanged,
	listFastLosses,
	placeAudioTracks,
} from "../clips";

const ticks = (seconds: number) =>
	mediaTime({ ticks: Math.round(seconds * TICKS_PER_SECOND) });

function makeClip({
	id,
	start,
	duration,
	trim = 0,
	...rest
}: { id: string; start: number; duration: number; trim?: number } & Partial<
	Omit<VideoElement, "id" | "duration" | "startTime">
>): VideoElement {
	return {
		id,
		type: "video",
		name: id,
		mediaId: "film",
		startTime: ticks(start),
		duration: ticks(duration),
		trimStart: ticks(trim),
		trimEnd: ticks(0),
		params: {},
		...rest,
	};
}

function makeTracks({
	elements,
	...main
}: { elements: SceneTracks["main"]["elements"] } & Partial<
	SceneTracks["main"]
>): SceneTracks {
	return {
		overlay: [],
		audio: [],
		main: {
			id: "main",
			name: "Main",
			type: "video",
			muted: false,
			hidden: false,
			elements,
			...main,
		},
	};
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- a stand-in with only what Fast mode reads.
const assets = [
	{ id: "film", name: "film.mp4", type: "video" },
	{ id: "photo", name: "photo.jpg", type: "image" },
] as MediaAsset[];

describe("collectFastClips", () => {
	test("the main track's video clips in order, where they're cut in their file", () => {
		const tracks = makeTracks({
			elements: [
				makeClip({ id: "b", start: 4, duration: 2, trim: 10 }),
				makeClip({ id: "a", start: 0, duration: 4, trim: 1 }),
				makeClip({
					id: "fast",
					start: 6,
					duration: 1,
					trim: 20,
					retime: { rate: 2 },
				}),
			],
		});
		const clips = collectFastClips({ tracks, mediaAssets: assets });
		expect(
			clips.map(({ element, from, to }) => [element.id, from, to]),
		).toEqual([
			["a", 1, 5],
			["b", 10, 12],
			// A second at twice the speed is two seconds of its file.
			["fast", 20, 22],
		]);
	});

	test("leaves out hidden clips, missing files and pictures", () => {
		const tracks = makeTracks({
			elements: [
				makeClip({ id: "hidden", start: 0, duration: 1, hidden: true }),
				makeClip({ id: "missing", start: 1, duration: 1, mediaId: "gone" }),
				{
					...makeClip({ id: "picture", start: 2, duration: 1 }),
					type: "image",
					mediaId: "photo",
				},
				makeClip({ id: "kept", start: 3, duration: 1 }),
			],
		});
		expect(
			collectFastClips({ tracks, mediaAssets: assets }).map(
				(clip) => clip.element.id,
			),
		).toEqual(["kept"]);
	});

	test("nothing from a hidden main track", () => {
		const tracks = makeTracks({
			hidden: true,
			elements: [makeClip({ id: "a", start: 0, duration: 1 })],
		});
		expect(collectFastClips({ tracks, mediaAssets: assets })).toEqual([]);
	});
});

describe("listFastLosses", () => {
	test("nothing for plain cuts end to end", () => {
		const tracks = makeTracks({
			elements: [
				makeClip({ id: "a", start: 0, duration: 2 }),
				makeClip({ id: "b", start: 2, duration: 3, trim: 5 }),
			],
		});
		expect(listFastLosses({ tracks })).toEqual([]);
	});

	test("says what the timeline has that isn't copied", () => {
		const tracks: SceneTracks = {
			...makeTracks({
				elements: [
					makeClip({ id: "a", start: 0, duration: 2, retime: { rate: 1.5 } }),
					makeClip({ id: "b", start: 3, duration: 2 }),
					{
						...makeClip({ id: "picture", start: 5, duration: 1 }),
						type: "image",
						mediaId: "photo",
					},
				],
				transitions: [
					{
						id: "t",
						fromElementId: "a",
						toElementId: "b",
						type: "cross-dissolve",
						duration: ticks(0.5),
						alignment: "center",
						params: {},
						crossfadeAudio: false,
					},
				],
			}),
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- stand-ins with only what the list reads.
			overlay: [
				{
					id: "subs",
					name: "Subtitles",
					type: "text",
					hidden: false,
					subtitles: true,
					elements: [{}],
				},
				{
					id: "empty",
					name: "Text",
					type: "text",
					hidden: false,
					elements: [],
				},
			] as unknown as SceneTracks["overlay"],
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- as above.
			audio: [
				{
					id: "music",
					name: "Music",
					type: "audio",
					muted: false,
					elements: [{}],
				},
			] as unknown as SceneTracks["audio"],
		};
		expect(listFastLosses({ tracks })).toEqual([
			"transitions",
			"speed changes",
			"gaps between clips (closed up)",
			"pictures",
			"subtitles",
		]);
	});
});

describe("the clips' sound", () => {
	test("is unchanged unless muted or its volume moved", () => {
		const track = makeTracks({ elements: [] }).main;
		const clip = makeClip({ id: "a", start: 0, duration: 1 });
		expect(isSoundUnchanged({ element: clip, track })).toBe(true);
		expect(
			isSoundUnchanged({ element: { ...clip, params: { volume: -6 } }, track }),
		).toBe(false);
		expect(
			isSoundUnchanged({ element: clip, track: { ...track, muted: true } }),
		).toBe(false);
	});

	test("is mixed from a timeline of the clips as they're laid out", () => {
		const element = makeClip({
			id: "a",
			start: 7,
			duration: 2,
			trim: 3,
			retime: { rate: 2 },
		});
		const tracks = makeTracks({ elements: [element] });
		const sound = buildFastSoundTracks({
			tracks,
			placed: [
				{
					clip: { element, asset: assets[0], from: 3, to: 7 },
					start: 2.5,
					end: 7,
					outStart: 1,
				},
			],
		});
		expect(sound.overlay).toEqual([]);
		expect(sound.audio).toEqual([]);
		expect(sound.main.elements).toHaveLength(1);
		expect(sound.main.elements[0]).toMatchObject({
			id: "a",
			startTime: ticks(1),
			trimStart: ticks(2.5),
			duration: ticks(4.5),
			retime: undefined,
		});
	});
});

function makeSound({
	id,
	start,
	duration,
	trim = 0,
	...rest
}: { id: string; start: number; duration: number; trim?: number } & Partial<
	Omit<UploadAudioElement, "id" | "duration" | "startTime">
>): UploadAudioElement {
	return {
		id,
		type: "audio",
		sourceType: "upload",
		mediaId: "song",
		name: id,
		startTime: ticks(start),
		duration: ticks(duration),
		trimStart: ticks(trim),
		trimEnd: ticks(0),
		params: {},
		...rest,
	};
}

describe("the audio tracks in Fast mode", () => {
	test("a cut keeps the part heard, its trims moved", () => {
		const element = makeSound({ id: "m", start: 2, duration: 10, trim: 1 });
		expect(
			cutAudioElement({ element, from: ticks(4), to: ticks(7) }),
		).toMatchObject({
			startTime: ticks(4),
			duration: ticks(3),
			trimStart: ticks(3),
			trimEnd: ticks(5),
		});
		expect(
			cutAudioElement({ element, from: ticks(20), to: ticks(30) }),
		).toBeNull();
		const faster = makeSound({
			id: "f",
			start: 0,
			duration: 4,
			retime: { rate: 2 },
		});
		expect(
			cutAudioElement({ element: faster, from: ticks(1), to: ticks(4) }),
		).toMatchObject({
			duration: ticks(3),
			trimStart: ticks(2),
			trimEnd: ticks(0),
		});
	});

	test("each clip hears what's under it, moved to where it is in the output", () => {
		const first = makeClip({ id: "a", start: 0, duration: 4, trim: 10 });
		const second = makeClip({ id: "b", start: 10, duration: 5, trim: 0 });
		const music = makeSound({ id: "music", start: 0, duration: 20 });
		const tracks: SceneTracks = {
			...makeTracks({ elements: [first, second] }),
			audio: [
				{
					id: "t",
					name: "Music",
					type: "audio",
					muted: false,
					elements: [music],
				},
				{
					id: "quiet",
					name: "Muted",
					type: "audio",
					muted: true,
					elements: [{ ...music, id: "q" }],
				},
			],
		};
		expect(hasAudibleAudioTracks({ tracks })).toBe(true);
		const [placed] = placeAudioTracks({
			tracks,
			placed: [
				{
					clip: { element: first, asset: assets[0], from: 10, to: 14 },
					start: 10,
					end: 14,
					outStart: 0,
				},
				// Started at the key frame a second before its cut.
				{
					clip: { element: second, asset: assets[0], from: 0, to: 5 },
					start: -1,
					end: 5,
					outStart: 4,
				},
			],
		}).map((track) => track.elements);
		expect(placed).toHaveLength(2);
		expect(placed[0]).toMatchObject({
			id: "music:0",
			startTime: ticks(0),
			duration: ticks(4),
			trimStart: ticks(0),
		});
		// The gap from 4 to 10 s is closed up; the lead-in hears from 9 s.
		expect(placed[1]).toMatchObject({
			id: "music:1",
			startTime: ticks(4),
			duration: ticks(6),
			trimStart: ticks(9),
		});
	});

	test("are heard only when there's something on them", () => {
		const tracks = makeTracks({ elements: [] });
		expect(hasAudibleAudioTracks({ tracks })).toBe(false);
	});
});
