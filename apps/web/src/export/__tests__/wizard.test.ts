import { describe, expect, test } from "bun:test";
import { DEFAULT_EXPORT_CHOICES } from "../choices";
import {
	DEFAULT_WIZARD_ANSWERS,
	applyWizardAnswers,
	getUploadKbps,
	type WizardAnswers,
} from "../wizard";

const apply = ({
	answers,
	encodable = new Set(["avc", "hevc"] as const),
	projectShortSide = 2160,
	projectFps = 60000 / 1001,
}: {
	answers: Partial<WizardAnswers>;
	encodable?: Set<"avc" | "hevc" | "av1" | "prores" | "prores-hq">;
	projectShortSide?: number;
	projectFps?: number;
}) =>
	applyWizardAnswers({
		answers: { ...DEFAULT_WIZARD_ANSWERS, ...answers },
		choices: { ...DEFAULT_EXPORT_CHOICES, sharpen: "light" },
		encodable,
		projectShortSide,
		projectFps,
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
});
