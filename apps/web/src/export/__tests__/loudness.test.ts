import { describe, expect, test } from "bun:test";
import { LoudnessMeter } from "magnetcut-wasm";
import { computeLoudnessGain } from "@/media/audio-mix";
import {
	DEFAULT_EXPORT_CHOICES,
	getChosenAudio,
	sanitizeChoices,
} from "../choices";
import { DEFAULT_WIZARD_ANSWERS, applyWizardAnswers } from "../wizard";

const sine = ({
	db,
	seconds,
	sampleRate,
}: {
	db: number;
	seconds: number;
	sampleRate: number;
}) => {
	const amplitude = 10 ** (db / 20);
	return Float32Array.from(
		{ length: Math.round(seconds * sampleRate) },
		(_, index) =>
			amplitude * Math.sin((2 * Math.PI * 1000 * index) / sampleRate),
	);
};

describe("loudness at export", () => {
	test("the meter reads a -23 dBFS 1 kHz stereo sine as -23 LUFS (EBU Tech 3341)", () => {
		const meter = new LoudnessMeter(48000, 2);
		try {
			const tone = sine({ db: -23, seconds: 5, sampleRate: 48000 });
			for (let start = 0; start < tone.length; start += 48000) {
				const block = tone.slice(start, start + 48000);
				meter.push([block, block]);
			}
			expect(meter.integrated).toBeCloseTo(-23, 1);
		} finally {
			meter.free();
		}
	});

	test("the gain moves the mix to the target, at most 20 dB", () => {
		expect(computeLoudnessGain({ measured: -23, target: -14 })).toBeCloseTo(
			10 ** (9 / 20),
		);
		expect(computeLoudnessGain({ measured: -10, target: -16 })).toBeCloseTo(
			10 ** (-6 / 20),
		);
		expect(computeLoudnessGain({ measured: -60, target: -14 })).toBeCloseTo(10);
		expect(computeLoudnessGain({ measured: undefined, target: -14 })).toBe(1);
	});

	test("a target means the source's sound isn't copied", () => {
		expect(
			getChosenAudio({
				choices: { ...DEFAULT_EXPORT_CHOICES, loudness: -14 },
			}),
		).toMatchObject({ passthrough: false, loudness: -14 });
		expect(getChosenAudio({ choices: DEFAULT_EXPORT_CHOICES })).toMatchObject({
			passthrough: true,
			loudness: null,
		});
	});

	test("only the targets offered are read back", () => {
		expect(sanitizeChoices({ value: { loudness: -16 } }).loudness).toBe(-16);
		expect(sanitizeChoices({ value: { loudness: -3 } }).loudness).toBeNull();
		expect(sanitizeChoices({ value: {} }).loudness).toBeNull();
	});

	test("Simple's upload aims at -14 LUFS, and nothing else does", () => {
		const choicesFor = (destination: "upload" | "master") =>
			applyWizardAnswers({
				answers: { ...DEFAULT_WIZARD_ANSWERS, destination },
				choices: { ...DEFAULT_EXPORT_CHOICES, loudness: -23 },
				encodable: new Set(["avc", "hevc"] as const),
				projectShortSide: 1080,
				projectFps: 30,
			});
		expect(choicesFor("upload").loudness).toBe(-14);
		expect(choicesFor("master").loudness).toBeNull();
	});
});
