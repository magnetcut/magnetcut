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
	fitAudioChoice,
	fitAudioCodec,
	fitExportSize,
	fitVideoCodec,
	getConstantQualityBitrate,
	getLevelBitrate,
	getSizeLimitBitrate,
	getSizeLimitFit,
	getVideoBitrate,
	isNativeOnlyCodec,
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
				if (isNativeOnlyCodec(codec)) continue;
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
			fps: 30,
			duration: 60,
			audioBitrate: 192_000,
		});
		expect(bitrate).toBe(4_500_000);
	});

	test("a file size leaves room for the audio, and comes out under it", () => {
		const audioBitrate = 192_000;
		const duration = 60;
		const videoBitrate = getVideoBitrate({
			quality: { mode: "size", megabytes: 25 },
			codec: "avc",
			width: 1920,
			height: 1080,
			fps: 30,
			duration,
			audioBitrate,
		});
		expect(videoBitrate).toBe(3_006_865);
		// Under it with the encoders over as they run, and the index.
		const bytes = estimateExportBytes({
			videoBitrate,
			audioBitrate,
			duration,
			fps: 30,
		});
		expect(bytes).toBeLessThanOrEqual(25_000_000);
		expect(bytes).toBeGreaterThan(24_900_000);
	});

	test("ProRes is at its own rate, whatever's chosen", () => {
		const prores = ({
			codec,
			fps,
		}: {
			codec: "prores" | "prores-hq";
			fps: number;
		}) =>
			getVideoBitrate({
				quality: { mode: "size", megabytes: 1 },
				codec,
				width: 1920,
				height: 1080,
				fps,
				duration: 60,
				audioBitrate: 192_000,
			});
		// Apple's: 147 and 220 Mbit/s at 1080p and 29.97.
		expect(prores({ codec: "prores", fps: 30000 / 1001 })).toBe(147_000_000);
		expect(prores({ codec: "prores-hq", fps: 30000 / 1001 })).toBe(220_000_000);
		expect(prores({ codec: "prores", fps: 60000 / 1001 })).toBe(294_000_000);
	});

	test("a constant quality stands in as a bitrate: medium at 60, doubling each 10", () => {
		const at = (quality: number) =>
			getConstantQualityBitrate({
				quality,
				codec: "avc",
				width: 1920,
				height: 1080,
			});
		expect(at(60)).toBe(
			getLevelBitrate({
				level: "medium",
				codec: "avc",
				width: 1920,
				height: 1080,
			}),
		);
		expect(at(70)).toBe(
			getLevelBitrate({
				level: "high",
				codec: "avc",
				width: 1920,
				height: 1080,
			}),
		);
		expect(at(80)).toBe(
			getLevelBitrate({
				level: "very_high",
				codec: "avc",
				width: 1920,
				height: 1080,
			}),
		);
		expect(at(50)).toBeLessThan(at(60));
	});

	test("a file size too small for the length still gets a picture", () => {
		const bitrate = getVideoBitrate({
			quality: { mode: "size", megabytes: 1 },
			codec: "avc",
			width: 1920,
			height: 1080,
			fps: 30,
			duration: 3600,
			audioBitrate: 192_000,
		});
		expect(bitrate).toBe(100_000);
	});

	test("a file size for a short film gives no more than a picture takes", () => {
		// 10 GB for a second: within the 32 bits the desktop app reads it in.
		const bitrate = getVideoBitrate({
			quality: { mode: "size", megabytes: 10_000 },
			codec: "avc",
			width: 1920,
			height: 1080,
			fps: 30,
			duration: 1,
			audioBitrate: 192_000,
		});
		expect(bitrate).toBe(1_000_000_000);
		expect(bitrate).toBeLessThan(2 ** 32);
	});
});

describe("getSizeLimitFit", () => {
	// 33 minutes at 30 frames a second, the sound at AAC's least.
	const film = {
		duration: 33 * 60 + 15,
		fps: 30,
		codec: "hevc" as const,
		audioBitrate: 96_000,
	};

	test("fits where the picture gets the low level's bitrate at its size", () => {
		expect(
			getSizeLimitFit({ ...film, megabytes: 100, width: 854, height: 480 }),
		).toBe("fits");
	});

	test("starved where it gets less, which a hardware encoder doesn't keep to", () => {
		expect(
			getSizeLimitFit({ ...film, megabytes: 100, width: 3840, height: 2160 }),
		).toBe("starved");
	});

	test("over where it gets less than the least a picture's given", () => {
		expect(
			getSizeLimitFit({ ...film, megabytes: 10, width: 854, height: 480 }),
		).toBe("over");
		// The sound alone more than the limit.
		expect(
			getSizeLimitFit({
				...film,
				megabytes: 20,
				audioBitrate: 192_000,
				width: 854,
				height: 480,
			}),
		).toBe("over");
	});

	test("the index counts: the more frames, the less a limit leaves", () => {
		const at = (fps: number) =>
			getSizeLimitBitrate({
				megabytes: 10,
				duration: 600,
				fps,
				hasSound: true,
			});
		expect(at(60)).toBeLessThan(at(24));
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

	test("keep the sound's bitrate with its codec, else take the new one's usual", () => {
		expect(fitAudioChoice({ format: "mkv", codec: "opus", kbps: 96 })).toEqual({
			codec: "opus",
			kbps: 96,
		});
		expect(fitAudioChoice({ format: "mov", codec: "opus", kbps: 96 })).toEqual({
			codec: "aac",
			kbps: 192,
		});
	});
});
