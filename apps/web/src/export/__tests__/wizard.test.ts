import { describe, expect, test } from "bun:test";
import { DEFAULT_EXPORT_CHOICES } from "../choices";
import type { ExportFormat } from "../index";
import {
	DEFAULT_WIZARD_ANSWERS,
	applyWizardAnswers,
	fitToSize,
	getAskedShortSide,
	getUploadKbps,
	type WizardAnswers,
} from "../wizard";
import {
	fitExportSize,
	getLevelBitrate,
	getSizeLimitBitrate,
	type ExportVideoCodec,
} from "../settings";

const apply = ({
	answers,
	encodable = new Set(["avc", "hevc"] as const),
	picture = { width: 3840, height: 2160 },
	projectFps = 60000 / 1001,
	duration = 60,
	copiedBitrate = null,
	format,
}: {
	answers: Partial<WizardAnswers>;
	encodable?: Set<ExportVideoCodec>;
	picture?: { width: number; height: number };
	projectFps?: number;
	duration?: number;
	copiedBitrate?: number | null;
	format?: ExportFormat;
}) =>
	applyWizardAnswers({
		answers: { ...DEFAULT_WIZARD_ANSWERS, ...answers },
		choices: { ...DEFAULT_EXPORT_CHOICES, sharpen: "light" },
		encodable,
		picture,
		projectFps,
		duration,
		copiedBitrate,
		format,
	});

describe("the Simple export", () => {
	test("for old players: H.264 in MP4, 1080p at 30 at most", () => {
		const choices = apply({ answers: { destination: "anything" } });
		expect(choices).toMatchObject({
			format: "mp4",
			videoCodec: "avc",
			shortSide: 1080,
			fpsLabel: "29.97",
			qualityMode: "level",
			level: "high",
		});
		// What else was chosen, kept.
		expect(choices.sharpen).toBe("light");
	});

	test("for uploads: HEVC where it's encoded, at YouTube's bitrate for it", () => {
		expect(apply({ answers: { destination: "upload" } })).toMatchObject({
			videoCodec: "hevc",
			qualityMode: "bitrate",
			videoKbps: 36_000,
			fpsLabel: null,
		});
		expect(
			apply({
				answers: { destination: "upload" },
				encodable: new Set(["avc"]),
			}),
		).toMatchObject({ videoCodec: "avc", videoKbps: 60_000 });
		expect(
			apply({
				answers: { destination: "upload", shortSide: 1080, fpsLabel: "30" },
			}).videoKbps,
		).toBe(4_800);
		expect(getUploadKbps({ shortSide: 1080, fps: 30 })).toBe(8_000);
		expect(getUploadKbps({ shortSide: 720, fps: 60 })).toBe(7_500);
	});

	test("smallest: AV1 where it's encoded, else HEVC, else H.264", () => {
		expect(apply({ answers: { destination: "small" } }).videoCodec).toBe(
			"hevc",
		);
		expect(
			apply({
				answers: { destination: "small" },
				encodable: new Set(["avc", "av1"]),
			}).videoCodec,
		).toBe("av1");
		expect(
			apply({ answers: { destination: "small" }, encodable: new Set(["avc"]) })
				.videoCodec,
		).toBe("avc");
	});

	test("a master file: ProRes in QuickTime where there's ProRes", () => {
		expect(
			apply({
				answers: { destination: "master" },
				encodable: new Set(["avc", "hevc", "prores-hq"]),
			}),
		).toMatchObject({ format: "mov", videoCodec: "prores-hq" });
		expect(apply({ answers: { destination: "master" } }).videoCodec).toBe(
			"hevc",
		);
	});

	test("a size limit, and the sound as asked", () => {
		expect(apply({ answers: { maxMegabytes: 25 } })).toMatchObject({
			qualityMode: "size",
			megabytes: 25,
		});
		expect(apply({ answers: { sound: "original" } })).toMatchObject({
			hasAudio: true,
			audioPassthrough: true,
		});
		expect(apply({ answers: { sound: "mono" } })).toMatchObject({
			channels: 1,
			audioPassthrough: false,
		});
		expect(apply({ answers: { sound: "none" } }).hasAudio).toBe(false);
	});

	test("no sound keeps what's chosen for it, in what the container takes", () => {
		const choices = applyWizardAnswers({
			answers: {
				...DEFAULT_WIZARD_ANSWERS,
				destination: "master",
				sound: "none",
			},
			choices: { ...DEFAULT_EXPORT_CHOICES, audioCodec: "opus", audioKbps: 96 },
			encodable: new Set(["avc", "hevc"]),
			picture: { width: 1920, height: 1080 },
			projectFps: 30,
			duration: 60,
			copiedBitrate: null,
		});
		// QuickTime takes AAC alone.
		expect(choices).toMatchObject({
			format: "mov",
			hasAudio: false,
			audioCodec: "aac",
			audioKbps: 192,
		});
	});

	test("a container already chosen, as an agent's file's, is kept", () => {
		expect(
			apply({
				answers: { destination: "upload" },
				encodable: new Set(["vp9", "av1"]),
				format: "webm",
			}),
		).toMatchObject({ format: "webm", videoCodec: "vp9", audioCodec: "opus" });
		expect(
			apply({ answers: { destination: "anything" }, format: "mkv" }),
		).toMatchObject({ format: "mkv", videoCodec: "avc", audioCodec: "aac" });
	});

	test("the size asked: the answer's, within the destination's, and the picture's", () => {
		const asked = (answers: Partial<WizardAnswers>) =>
			getAskedShortSide({
				answers: { ...DEFAULT_WIZARD_ANSWERS, ...answers },
				pictureShortSide: 2160,
			});
		expect(asked({})).toBe(2160);
		expect(asked({ shortSide: 720 })).toBe(720);
		expect(asked({ destination: "anything" })).toBe(1080);
		expect(asked({ shortSide: 4320 })).toBe(2160);
	});
});

describe("a size limit, worked back from", () => {
	// 33 minutes of 4K at 30 frames a second.
	const film = {
		picture: { width: 3840, height: 2160 },
		duration: 33 * 60 + 15,
		projectFps: 30,
	};
	const limited = ({
		destination,
		maxMegabytes,
		sound = "stereo",
		copiedBitrate = null,
	}: {
		destination: WizardAnswers["destination"];
		maxMegabytes: number;
		sound?: WizardAnswers["sound"];
		copiedBitrate?: number | null;
	}) =>
		applyWizardAnswers({
			answers: { ...DEFAULT_WIZARD_ANSWERS, destination, maxMegabytes, sound },
			choices: DEFAULT_EXPORT_CHOICES,
			encodable: new Set(["avc", "hevc"] as const),
			copiedBitrate,
			...film,
		});

	test("a smaller picture, and less of the sound, for a small file", () => {
		const choices = limited({ destination: "small", maxMegabytes: 100 });
		expect(choices).toMatchObject({
			videoCodec: "hevc",
			qualityMode: "size",
			megabytes: 100,
			shortSide: 480,
			audioKbps: 96,
		});
		// What's left for the picture carries the low quality level there.
		const size = fitExportSize({ canvas: film.picture, shortSide: 480 });
		const picture =
			getSizeLimitBitrate({
				megabytes: 100,
				duration: film.duration,
				fps: film.projectFps,
				hasSound: true,
			}) - 96_000;
		expect(picture).toBeGreaterThanOrEqual(
			getLevelBitrate({ level: "low", codec: "hevc", ...size }),
		);
	});

	test("the picture as made, and the sound as asked, when they fit", () => {
		expect(limited({ destination: "small", maxMegabytes: 2000 })).toMatchObject(
			{ shortSide: null, audioKbps: 192 },
		);
	});

	test("the destination's own quality, where the film comes out under it", () => {
		// 10 seconds of YouTube's 1080p take 6 MB: the limit isn't a target.
		const choices = applyWizardAnswers({
			answers: {
				...DEFAULT_WIZARD_ANSWERS,
				destination: "upload",
				shortSide: 1080,
				maxMegabytes: 100,
			},
			choices: DEFAULT_EXPORT_CHOICES,
			encodable: new Set(["avc", "hevc"]),
			picture: film.picture,
			projectFps: 30,
			duration: 10,
			copiedBitrate: null,
		});
		expect(choices).toMatchObject({
			qualityMode: "bitrate",
			videoKbps: 4_800,
			shortSide: 1080,
		});
	});

	test("copied sound at its own bitrate", () => {
		// 128 kbit/s leave 480p what it takes; 256 kbit/s only 240p.
		expect(
			limited({
				destination: "small",
				maxMegabytes: 100,
				sound: "original",
				copiedBitrate: 128_000,
			}).shortSide,
		).toBe(480);
		expect(
			limited({
				destination: "small",
				maxMegabytes: 100,
				sound: "original",
				copiedBitrate: 256_000,
			}).shortSide,
		).toBe(240);
		// Where it can't be copied, the mix is encoded, given its share.
		expect(
			limited({ destination: "small", maxMegabytes: 100, sound: "original" }),
		).toMatchObject({ shortSide: 480, audioKbps: 96 });
	});

	test("never larger than the destination allows", () => {
		const choices = limited({ destination: "anything", maxMegabytes: 2000 });
		expect(choices.shortSide).toBe(1080);
	});

	test("a master file with a limit is HEVC: ProRes has its own rate", () => {
		expect(
			limited({ destination: "master", maxMegabytes: 500 }).videoCodec,
		).toBe("hevc");
	});

	test("the smallest size, 240p, and AAC's least, when nothing fits", () => {
		expect(
			fitToSize({
				megabytes: 10,
				duration: film.duration,
				fps: film.projectFps,
				picture: film.picture,
				largest: 2160,
				codec: "hevc",
				audioCodec: "aac",
				sound: { isCopied: false, kbps: 192 },
			}),
		).toEqual({ shortSide: 240, audioKbps: 96 });
	});
});
