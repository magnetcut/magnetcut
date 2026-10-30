import { describe, expect, test } from "bun:test";
import {
	BUILT_IN_PRESETS,
	DEFAULT_EXPORT_CHOICES,
	getChosenOptions,
	isSameExport,
	sanitizeChoices,
	sanitizePresets,
	type ExportChoices,
} from "../choices";
import { FORMAT_CODECS } from "../settings";

describe("sanitizeChoices", () => {
	test("keeps choices that are valid", () => {
		const choices: ExportChoices = {
			...DEFAULT_EXPORT_CHOICES,
			format: "mkv",
			videoCodec: "hevc",
			qualityMode: "size",
			megabytes: 50,
			shortSide: 720,
			fpsLabel: "23.976",
			hasAudio: false,
			audioPassthrough: false,
			audioCodec: "opus",
			audioKbps: 96,
			channels: 1,
		};
		expect(sanitizeChoices({ value: choices })).toEqual(choices);
	});

	test("gives the defaults for what isn't there or isn't valid", () => {
		expect(sanitizeChoices({ value: undefined })).toEqual(
			DEFAULT_EXPORT_CHOICES,
		);
		expect(sanitizeChoices({ value: "mp4" })).toEqual(DEFAULT_EXPORT_CHOICES);
		expect(
			sanitizeChoices({
				value: {
					format: "avi",
					level: "best",
					videoKbps: -1,
					megabytes: Number.NaN,
					constantQuality: 101,
					shortSide: 8,
					fpsLabel: "61",
					hasAudio: "yes",
					channels: 6,
				},
			}),
		).toEqual(DEFAULT_EXPORT_CHOICES);
	});

	test("fits the codecs and the audio bitrate to the container", () => {
		const choices = sanitizeChoices({
			value: {
				format: "webm",
				videoCodec: "avc",
				audioCodec: "aac",
				audioKbps: 192,
			},
		});
		expect(choices.videoCodec).toBe("vp9");
		expect(choices.audioCodec).toBe("opus");
		// 192 is an Opus bitrate too, so it stays.
		expect(choices.audioKbps).toBe(192);
		expect(
			sanitizeChoices({ value: { audioCodec: "aac", audioKbps: 256 } })
				.audioKbps,
		).toBe(192);
	});

	test("keeps ProRes in a QuickTime file and a constant quality", () => {
		const choices: ExportChoices = {
			...DEFAULT_EXPORT_CHOICES,
			format: "mov",
			videoCodec: "prores-hq",
			qualityMode: "constant",
			constantQuality: 80,
		};
		expect(sanitizeChoices({ value: choices })).toEqual(choices);
		expect(getChosenOptions({ choices }).quality).toEqual({
			mode: "constant",
			quality: 80,
		});
		// No ProRes in MP4.
		expect(
			sanitizeChoices({ value: { format: "mp4", videoCodec: "prores" } })
				.videoCodec,
		).toBe("avc");
	});
});

describe("sanitizePresets", () => {
	test("keeps presets with an id and a name, their choices sanitized", () => {
		const presets = sanitizePresets({
			value: [
				{
					id: "a",
					name: "Mine",
					choices: { format: "mov", audioCodec: "opus" },
				},
				{ id: "b", name: "" },
				{ name: "No id" },
				null,
				"preset",
			],
		});
		expect(presets).toHaveLength(1);
		expect(presets[0].name).toBe("Mine");
		expect(presets[0].choices.format).toBe("mov");
		expect(presets[0].choices.audioCodec).toBe("aac");
	});

	test("is empty for what isn't a list", () => {
		expect(sanitizePresets({ value: { id: "a" } })).toEqual([]);
	});
});

describe("isSameExport", () => {
	test("ignores what's kept for a mode or a sound not in use", () => {
		const a = DEFAULT_EXPORT_CHOICES;
		expect(isSameExport({ a, b: { ...a, videoKbps: 1234 } })).toBe(true);
		expect(
			isSameExport({
				a: { ...a, hasAudio: false },
				b: { ...a, hasAudio: false, audioKbps: 96 },
			}),
		).toBe(true);
		expect(isSameExport({ a, b: { ...a, level: "low" } })).toBe(false);
		expect(isSameExport({ a, b: { ...a, fpsLabel: "25" } })).toBe(false);
	});
});

describe("getChosenOptions", () => {
	test("is the export the choices make", () => {
		expect(
			getChosenOptions({
				choices: {
					...DEFAULT_EXPORT_CHOICES,
					qualityMode: "bitrate",
					videoKbps: 4000,
					shortSide: 720,
					fpsLabel: "29.97",
					channels: 1,
				},
			}),
		).toEqual({
			format: "mp4",
			videoCodec: "avc",
			quality: { mode: "bitrate", kbps: 4000 },
			shortSide: 720,
			fps: { numerator: 30000, denominator: 1001 },
			audio: { codec: "aac", kbps: 192, channels: 1, passthrough: true },
		});
	});
});

test("built-in presets are valid and tell apart", () => {
	for (const preset of BUILT_IN_PRESETS) {
		expect(sanitizeChoices({ value: preset.choices })).toEqual(preset.choices);
		const codecs = FORMAT_CODECS[preset.choices.format];
		expect(codecs.video).toContain(preset.choices.videoCodec);
		expect(codecs.audio).toContain(preset.choices.audioCodec);
	}
	for (const a of BUILT_IN_PRESETS) {
		for (const b of BUILT_IN_PRESETS) {
			expect(isSameExport({ a: a.choices, b: b.choices })).toBe(a === b);
		}
	}
});
