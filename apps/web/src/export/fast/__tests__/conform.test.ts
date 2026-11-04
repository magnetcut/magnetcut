import { describe, expect, test } from "bun:test";
import {
	chooseConformSound,
	chooseConformTarget,
	listConformCodecs,
	listConformSizes,
	planConform,
	type ConformFile,
} from "../conform";
import {
	chooseConvertedFormat,
	getConvertedPart,
	nameConvertedFile,
	PART_MARGIN,
} from "../convert";

const HD: VideoColorSpaceInit = {
	primaries: "bt709",
	transfer: "bt709",
	matrix: "bt709",
	fullRange: false,
};

function makeFile(file: Partial<ConformFile> & { id: string }): ConformFile {
	const { id, ...rest } = file;
	const width = rest.width ?? 1920;
	const height = rest.height ?? 1080;
	return {
		asset: {
			id,
			name: `${id}.mp4`,
			type: "video",
			duration: 60,
			file: new File([], `${id}.mp4`),
		},
		codec: "avc",
		width,
		height,
		codedWidth: width,
		codedHeight: height,
		rotation: 0,
		configKey: "a",
		colour: { ...HD },
		sound: { codec: "aac", sampleRate: 48000, channels: 2 },
		duration: 60,
		seconds: 10,
		clipCount: 1,
		usedFrom: 0,
		usedTo: 10,
		...rest,
	};
}

describe("the target", () => {
	test("is the size and codec most of the track is in", () => {
		const files = [
			makeFile({ id: "a", seconds: 30 }),
			makeFile({ id: "b", width: 1280, height: 720, seconds: 40 }),
			makeFile({ id: "c", seconds: 20 }),
		];
		expect(listConformSizes({ files }).map((s) => s.seconds)).toEqual([50, 40]);
		expect(chooseConformTarget({ files })).toEqual({
			codec: "avc",
			width: 1920,
			height: 1080,
		});
	});

	test("offers H.264 always, and VP9 when the track has some", () => {
		expect(
			listConformCodecs({ files: [makeFile({ id: "a", codec: "hevc" })] }),
		).toEqual(["avc"]);
		expect(
			listConformCodecs({
				files: [
					makeFile({ id: "a", codec: "vp9", seconds: 30 }),
					makeFile({ id: "b", seconds: 5 }),
				],
			}),
		).toEqual(["vp9", "avc"]);
	});

	test("gives the sound most of the track has", () => {
		const files = [
			makeFile({
				id: "a",
				seconds: 5,
				sound: { codec: "opus", sampleRate: 48000, channels: 2 },
			}),
			makeFile({ id: "b", seconds: 20 }),
			makeFile({ id: "c", sound: null, seconds: 50 }),
		];
		expect(chooseConformSound({ files })?.codec).toBe("aac");
	});
});

describe("the plan", () => {
	const target = { codec: "avc" as const, width: 1920, height: 1080 };

	test("converts the files of another size, codec or way up", () => {
		const files = [
			makeFile({ id: "same" }),
			makeFile({ id: "small", width: 1280, height: 720 }),
			makeFile({ id: "hevc", codec: "hevc" }),
			makeFile({
				id: "turned",
				width: 1920,
				height: 1080,
				codedWidth: 1080,
				codedHeight: 1920,
				rotation: 90,
			}),
		];
		const plan = planConform({ files, target });
		expect(plan.files.map(({ file }) => file.asset.id)).toEqual([
			"small",
			"hevc",
			"turned",
		]);
		expect(plan.seconds).toBe(30);
		expect(plan.files[2].difference).toContain("rotation");
	});

	test("lets H.264 files encoded differently join, but not VP9 ones", () => {
		const avc = planConform({
			files: [makeFile({ id: "a" }), makeFile({ id: "b", configKey: "b" })],
			target,
		});
		expect(avc.files).toHaveLength(0);
		const vp9 = planConform({
			files: [
				makeFile({ id: "a", codec: "vp9" }),
				makeFile({ id: "b", codec: "vp9", configKey: "b" }),
			],
			target: { ...target, codec: "vp9" },
		});
		expect(vp9.files.map(({ file }) => file.asset.id)).toEqual(["b"]);
		expect(vp9.files[0].difference).toContain("encoded differently");
	});

	test("writes the converted files in the colour of a file that joins", () => {
		const phone = { ...HD, fullRange: true };
		const plan = planConform({
			files: [
				makeFile({ id: "small", width: 1280, height: 720 }),
				makeFile({ id: "phone", colour: phone }),
			],
			target,
		});
		expect(plan.colour).toEqual(phone);
		// What it leaves unsaid stays unsaid, the range limited.
		const unsaid = { primaries: null, transfer: null, matrix: null };
		const camera = planConform({
			files: [
				makeFile({ id: "small", width: 1280, height: 720 }),
				makeFile({ id: "camera", colour: { ...unsaid, fullRange: null } }),
			],
			target,
		});
		expect(camera.colour).toEqual({ ...unsaid, fullRange: false });
		// None joins: BT.709, limited, said.
		const none = planConform({
			files: [makeFile({ id: "small", width: 1280, height: 720 })],
			target: { codec: "avc", width: 640, height: 360 },
		});
		expect(none.colour).toEqual(HD);
	});
});

describe("a converted file", () => {
	test("is a part with a margin, or the whole file when that's nearly all of it", () => {
		expect(
			getConvertedPart({ file: { usedFrom: 100, usedTo: 200, duration: 600 } }),
		).toEqual({ start: 100 - PART_MARGIN, end: 200 + PART_MARGIN });
		expect(
			getConvertedPart({ file: { usedFrom: 2, usedTo: 57, duration: 60 } }),
		).toBeNull();
	});

	test("is named for its size and part", () => {
		const target = { width: 1920, height: 1080 };
		expect(
			nameConvertedFile({
				name: "talk.mov",
				target,
				part: null,
				format: "mp4",
			}),
		).toBe("talk (1920×1080).mp4");
		expect(
			nameConvertedFile({
				name: "talk.mov",
				target,
				part: { start: 95.5, end: 205.2 },
				format: "mkv",
			}),
		).toBe("talk (1920×1080, 95-206 s).mkv");
	});

	test("goes in its codecs' usual container, or Matroska", () => {
		expect(
			chooseConvertedFormat({
				target: { codec: "avc" },
				sound: { codec: "aac" },
			}),
		).toBe("mp4");
		expect(
			chooseConvertedFormat({
				target: { codec: "vp9" },
				sound: { codec: "opus" },
			}),
		).toBe("webm");
		expect(
			chooseConvertedFormat({
				target: { codec: "vp9" },
				sound: { codec: "aac" },
			}),
		).toBe("mkv");
		expect(
			chooseConvertedFormat({ target: { codec: "avc" }, sound: null }),
		).toBe("mp4");
	});
});
