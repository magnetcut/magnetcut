import { describe, expect, test } from "bun:test";
import {
	QUALITY_HIGH,
	QUALITY_LOW,
	QUALITY_MEDIUM,
	QUALITY_VERY_HIGH,
	type Quality,
} from "mediabunny";
import {
	EXPORT_VIDEO_CODECS,
	estimateExportBytes,
	fitAudioCodec,
	fitExportSize,
	fitVideoCodec,
	getLevelBitrate,
	getVideoBitrate,
} from "../settings";

/** mediabunny's own bitrate for a quality, which it keeps internal. */
function getMediabunnyBitrate({
	quality,
	codec,
	width,
	height,
}: {
	quality: Quality;
	codec: string;
	width: number;
	height: number;
}): number {
	const toVideoBitrate: unknown = Reflect.get(quality, "_toVideoBitrate");
	if (typeof toVideoBitrate !== "function") {
		throw new Error("mediabunny's Quality no longer has _toVideoBitrate");
	}
	const bitrate: unknown = Reflect.apply(toVideoBitrate, quality, [
		codec,
		width,
		height,
	]);
	if (typeof bitrate !== "number") throw new Error("Not a bitrate");
	return bitrate;
}

describe("fitExportSize", () => {
	test("keeps the project's shape at the shorter side chosen", () => {
		const canvas = { width: 1920, height: 1080 };
		expect(fitExportSize({ canvas, shortSide: 720 })).toEqual({
			width: 1280,
			height: 720,
		});
		expect(
			fitExportSize({ canvas: { width: 1080, height: 1920 }, shortSide: 720 }),
		).toEqual({ width: 720, height: 1280 });
	});

	test("is the project's size without a shorter side", () => {
		const canvas = { width: 1920, height: 1080 };
		expect(fitExportSize({ canvas })).toEqual(canvas);
	});

	test("is never larger than the project", () => {
		const canvas = { width: 1280, height: 720 };
		expect(fitExportSize({ canvas, shortSide: 2160 })).toEqual(canvas);
		expect(fitExportSize({ canvas: { width: 1921, height: 1081 } })).toEqual({
			width: 1920,
			height: 1080,
		});
	});

	test("gives the nearest even sizes", () => {
		expect(
			fitExportSize({ canvas: { width: 1280, height: 720 }, shortSide: 480 }),
		).toEqual({ width: 854, height: 480 });
		expect(
			fitExportSize({ canvas: { width: 1366, height: 768 }, shortSide: 480 }),
		).toEqual({ width: 854, height: 480 });
	});
});

describe("getVideoBitrate", () => {
	test("a level is the bitrate mediabunny would choose", () => {
		const levels = [
			["low", QUALITY_LOW],
			["medium", QUALITY_MEDIUM],
			["high", QUALITY_HIGH],
			["very_high", QUALITY_VERY_HIGH],
		] as const;
		const sizes = [
			[1920, 1080],
			[1280, 720],
			[3840, 2160],
			[1080, 1920],
		] as const;
		for (const [level, quality] of levels) {
			for (const codec of EXPORT_VIDEO_CODECS) {
				for (const [width, height] of sizes) {
					expect(getLevelBitrate({ level, codec, width, height })).toBe(
						getMediabunnyBitrate({ quality, codec, width, height }),
					);
				}
			}
		}
	});

	test("a bitrate is the one given", () => {
		const bitrate = getVideoBitrate({
			quality: { mode: "bitrate", kbps: 4500 },
			codec: "avc",
			width: 1920,
			height: 1080,
			duration: 60,
			audioBitrate: 192_000,
		});
		expect(bitrate).toBe(4_500_000);
	});

	test("a file size leaves room for the audio and comes out at that size", () => {
		const audioBitrate = 192_000;
		const duration = 60;
		const videoBitrate = getVideoBitrate({
			quality: { mode: "size", megabytes: 25 },
			codec: "avc",
			width: 1920,
			height: 1080,
			duration,
			audioBitrate,
		});
		expect(videoBitrate).toBe(3_108_000);
		const bytes = estimateExportBytes({ videoBitrate, audioBitrate, duration });
		expect(bytes).toBeLessThanOrEqual(25_000_000);
		expect(bytes).toBeGreaterThan(24_900_000);
	});

	test("a file size too small for the length still gets a picture", () => {
		const bitrate = getVideoBitrate({
			quality: { mode: "size", megabytes: 1 },
			codec: "avc",
			width: 1920,
			height: 1080,
			duration: 3600,
			audioBitrate: 192_000,
		});
		expect(bitrate).toBe(100_000);
	});
});

describe("codecs a container takes", () => {
	test("keep the one chosen when the container takes it", () => {
		expect(fitVideoCodec({ format: "mkv", codec: "hevc" })).toBe("hevc");
		expect(fitAudioCodec({ format: "mp4", codec: "opus" })).toBe("opus");
	});

	test("change to the container's usual one otherwise", () => {
		expect(fitVideoCodec({ format: "webm", codec: "avc" })).toBe("vp9");
		expect(fitVideoCodec({ format: "mov", codec: "av1" })).toBe("avc");
		expect(fitAudioCodec({ format: "webm", codec: "aac" })).toBe("opus");
		expect(fitAudioCodec({ format: "mov", codec: "opus" })).toBe("aac");
	});
});
