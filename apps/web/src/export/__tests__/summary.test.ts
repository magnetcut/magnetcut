import { describe, expect, test } from "bun:test";
import { PLACE_WARNING } from "@/project/file-tags";
import { DEFAULT_EXPORT_CHOICES, type ExportChoices } from "../choices";
import type { PassthroughSound } from "../passthrough";
import { fitExportSize } from "../settings";
import {
	describeFileTags,
	describeSound,
	getCodecName,
	getFitMegabytes,
	summarizeExport,
} from "../summary";

const HD = { width: 1920, height: 1080 };
const UHD = { width: 3840, height: 2160 };
// A source's 5.1 sound, which can be copied.
const SURROUND: PassthroughSound = {
	codec: "aac",
	numberOfChannels: 6,
	sampleRate: 48000,
	bitrate: 384_000,
};

const summarize = ({
	choices: changed = {},
	picture = HD,
	duration = 60,
	passthrough = null,
	keepsQuality = false,
	tags = {},
}: {
	choices?: Partial<ExportChoices>;
	picture?: { width: number; height: number };
	duration?: number;
	passthrough?: PassthroughSound | null;
	keepsQuality?: boolean;
	tags?: Parameters<typeof summarizeExport>[0]["tags"];
}) => {
	const choices = { ...DEFAULT_EXPORT_CHOICES, ...changed };
	return summarizeExport({
		choices,
		picture,
		output: fitExportSize({
			canvas: picture,
			shortSide: choices.shortSide ?? undefined,
		}),
		fps: 30,
		duration,
		passthrough,
		keepsQuality,
		tags,
	});
};

describe("the names said", () => {
	test("a codec's, and one that isn't known in capitals", () => {
		expect(getCodecName({ codec: "avc" })).toBe("H.264");
		expect(getCodecName({ codec: "eac3" })).toBe("E-AC-3");
		expect(getCodecName({ codec: "alac" })).toBe("ALAC");
	});

	test("the sound's: copied, encoded, or none", () => {
		expect(
			describeSound({ sound: { kind: "copied", codec: "aac", channels: 6 } }),
		).toBe("AAC 5.1 copied");
		expect(describeSound({ sound: { kind: "copied", codec: "ac3" } })).toBe(
			"AC-3 sound copied",
		);
		expect(
			describeSound({
				sound: { kind: "encoded", codec: "opus", kbps: 128, channels: 2 },
			}),
		).toBe("Opus 128 kbit/s stereo");
		expect(describeSound({ sound: { kind: "none" } })).toBe("no sound");
	});
});

describe("an export's summary", () => {
	test("what the file holds, and about how big", () => {
		const summary = summarize({});
		expect(summary.details).toBe(
			"1920×1080, 30 fps, AAC 192 kbit/s stereo, MP4",
		);
		expect(summary.size).toMatch(/^\d+(\.\d)? MB$/);
		expect(summary.limitWarning).toBeNull();
		expect(summary.tags).toBeNull();
	});

	test("the source's sound copied, unless its loudness is changed", () => {
		expect(summarize({ passthrough: SURROUND }).details).toContain(
			"AAC 5.1 copied",
		);
		expect(
			summarize({ passthrough: SURROUND, choices: { loudness: -14 } }).details,
		).toContain("AAC 192 kbit/s stereo");
		expect(
			summarize({ passthrough: SURROUND, choices: { hasAudio: false } })
				.details,
		).toContain("no sound");
	});

	test("a constant quality's size varies", () => {
		const summary = summarize({ keepsQuality: true });
		expect(summary.size).toBeNull();
		expect(summary.details).toEndWith("size varies with the picture");
	});

	test("the filters, as they're applied", () => {
		expect(
			summarize({ choices: { deinterlace: true, sharpen: "light" } }).details,
		).toContain("deinterlaced, sharpened (light)");
	});
});

describe("a size limit's summary", () => {
	const film = 33 * 60 + 15;

	test("over: the sound alone more than the limit", () => {
		expect(
			summarize({
				choices: { qualityMode: "size", megabytes: 10, panelMode: "advanced" },
				duration: 3600,
			}).limitWarning,
		).toStartWith("1 h 0 min can't fit in 10 MB: about ");
	});

	test("starved: too little for the picture's size, said as each mode can", () => {
		const choices: Partial<ExportChoices> = {
			qualityMode: "size",
			megabytes: 100,
			videoCodec: "hevc",
		};
		expect(
			summarize({
				choices: { ...choices, panelMode: "advanced" },
				picture: UHD,
				duration: film,
			}).limitWarning,
		).toBe(
			"100 MB leaves 3840×2160 too little: the file may come out bigger. A smaller size keeps to it.",
		);
		expect(
			summarize({
				choices: { ...choices, panelMode: "simple" },
				picture: UHD,
				duration: film,
			}).limitWarning,
		).toBe(
			"100 MB leaves even 3840×2160 too little: the file may come out bigger.",
		);
	});

	test("none for ProRes, at its own rate", () => {
		expect(
			summarize({
				choices: {
					format: "mov",
					videoCodec: "prores",
					qualityMode: "size",
					megabytes: 1,
				},
				duration: film,
			}).limitWarning,
		).toBeNull();
	});

	test("the picture made smaller to fit, in the Simple mode", () => {
		const choices: ExportChoices = {
			...DEFAULT_EXPORT_CHOICES,
			shortSide: 480,
			wizard: { ...DEFAULT_EXPORT_CHOICES.wizard, maxMegabytes: 100 },
		};
		expect(getFitMegabytes({ choices, pictureShortSide: 2160 })).toBe(100);
		expect(
			summarize({ choices, picture: UHD, duration: film }).details,
		).toStartWith("854×480 to fit 100 MB, ");
		// As asked, it isn't said.
		expect(
			getFitMegabytes({
				choices: { ...choices, shortSide: null },
				pictureShortSide: 2160,
			}),
		).toBeNull();
		expect(
			getFitMegabytes({
				choices: {
					...choices,
					wizard: { ...choices.wizard, shortSide: 480 },
				},
				pictureShortSide: 2160,
			}),
		).toBeNull();
		// Nor in the Advanced mode, where the size is the one chosen.
		expect(
			getFitMegabytes({
				choices: { ...choices, panelMode: "advanced" },
				pictureShortSide: 2160,
			}),
		).toBeNull();
	});
});

describe("the project's details in the summary", () => {
	test("named as they're written, the place with its warning", () => {
		expect(
			describeFileTags({
				tags: {
					title: "A walk",
					date: "2026-11-13",
					location: "+48.8584+002.2945/",
				},
				format: "mp4",
			}),
		).toEqual({
			text: "With its title, date and place",
			warning: PLACE_WARNING,
		});
		expect(
			describeFileTags({
				tags: { title: "A walk", make: "Apple", model: "iPhone 17 Pro" },
				format: "mov",
			}),
		).toEqual({ text: "With its title and camera", warning: null });
		expect(describeFileTags({ tags: {}, format: "mp4" })).toBeNull();
	});

	test("Matroska and WebM have no place or camera", () => {
		expect(
			describeFileTags({
				tags: { location: "+48.8584+002.2945/", make: "Apple" },
				format: "mkv",
			}),
		).toBeNull();
		expect(
			describeFileTags({
				tags: { title: "A walk", location: "+48.8584+002.2945/" },
				format: "webm",
			}),
		).toEqual({ text: "With its title", warning: null });
	});
});
