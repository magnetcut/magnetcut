import { describe, expect, test } from "bun:test";
import type { MediaAsset } from "@/media/types";
import type {
	ImageElement,
	UploadAudioElement,
	VideoElement,
} from "@/timeline";
import { mediaTime, TICKS_PER_SECOND } from "@/wasm";
import { buildReplacePatch, canReplaceWith } from "../replace";

const ticks = (seconds: number) =>
	mediaTime({ ticks: Math.round(seconds * TICKS_PER_SECOND) });

function makeVideo(
	clip: Omit<Partial<VideoElement>, "duration"> & {
		trim: number;
		duration: number;
	},
): VideoElement {
	const { trim, duration, ...rest } = clip;
	return {
		id: "clip",
		type: "video",
		name: "a.mp4",
		mediaId: "a",
		startTime: ticks(10),
		duration: ticks(duration),
		trimStart: ticks(trim),
		trimEnd: ticks(0),
		sourceDuration: ticks(60),
		params: {},
		...rest,
	};
}

function makeAsset(asset: Partial<MediaAsset>): MediaAsset {
	// A stand-in with only what replacing reads.
	return {
		id: "b",
		name: "b.mp4",
		type: "video",
		duration: 60,
		file: new File([], "b.mp4"),
		...asset,
	} as MediaAsset;
}

describe("canReplaceWith", () => {
	test("a video for a video, a picture for a picture, sound for sound", () => {
		const video = makeVideo({ trim: 0, duration: 5 });
		expect(canReplaceWith({ element: video, asset: makeAsset({}) })).toBe(true);
		expect(
			canReplaceWith({ element: video, asset: makeAsset({ type: "image" }) }),
		).toBe(false);
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- only its type is read.
		const sound = { type: "audio", mediaId: "a" } as UploadAudioElement;
		expect(
			canReplaceWith({ element: sound, asset: makeAsset({ type: "audio" }) }),
		).toBe(true);
		expect(
			canReplaceWith({ element: sound, asset: makeAsset({ hasAudio: false }) }),
		).toBe(false);
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- only its type is read.
		const picture = { type: "image", mediaId: "a" } as ImageElement;
		expect(
			canReplaceWith({ element: picture, asset: makeAsset({ type: "image" }) }),
		).toBe(true);
	});
});

describe("buildReplacePatch", () => {
	test("the same moments of a file as long", () => {
		const patch = buildReplacePatch({
			element: makeVideo({ trim: 12, duration: 5 }),
			asset: makeAsset({}),
		});
		expect(patch).toEqual({
			mediaId: "b",
			name: "a.mp4",
			trimStart: ticks(12),
			trimEnd: ticks(43),
			sourceDuration: ticks(60),
			duration: ticks(5),
		});
	});

	test("a part of the old file: its moments that far earlier", () => {
		const patch = buildReplacePatch({
			element: makeVideo({ trim: 12, duration: 5 }),
			asset: makeAsset({ duration: 15 }),
			offset: ticks(7),
		});
		expect(patch).toMatchObject({
			trimStart: ticks(5),
			trimEnd: ticks(5),
			sourceDuration: ticks(15),
			duration: ticks(5),
		});
	});

	test("a shorter file keeps the clip's end in it, or shortens the clip", () => {
		expect(
			buildReplacePatch({
				element: makeVideo({ trim: 12, duration: 5 }),
				asset: makeAsset({ duration: 14 }),
			}),
		).toMatchObject({
			trimStart: ticks(9),
			trimEnd: ticks(0),
			duration: ticks(5),
		});
		expect(
			buildReplacePatch({
				element: makeVideo({ trim: 12, duration: 5 }),
				asset: makeAsset({ duration: 3 }),
			}),
		).toMatchObject({
			trimStart: ticks(0),
			trimEnd: ticks(0),
			duration: ticks(3),
		});
	});

	test("a clip played faster covers more of the file", () => {
		const patch = buildReplacePatch({
			element: makeVideo({
				trim: 0,
				duration: 5,
				retime: { rate: 2, maintainPitch: false },
			}),
			asset: makeAsset({ duration: 8 }),
		});
		// 5 s at twice the speed is 10 s of file: 8 s of it, in 4 s.
		expect(patch).toMatchObject({ trimStart: ticks(0), duration: ticks(4) });
	});

	test("a picture just takes the new file", () => {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- only what replacing reads.
		const picture = {
			type: "image",
			mediaId: "a",
			name: "p.png",
		} as ImageElement;
		expect(
			buildReplacePatch({
				element: picture,
				asset: makeAsset({ type: "image" }),
			}),
		).toEqual({ mediaId: "b", name: "p.png" });
	});
});
