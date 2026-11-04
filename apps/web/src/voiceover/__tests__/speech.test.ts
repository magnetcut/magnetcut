import { describe, expect, test } from "bun:test";
import {
	fitSpeech,
	hashSpeech,
	MAX_SPEED_UP,
	nameSpokenFile,
	toSpokenText,
	type SpeechChoice,
} from "../speech";

const CHOICE: SpeechChoice = {
	provider: "openai",
	voice: "alloy",
	model: null,
	instructions: null,
};

describe("speaking the subtitles", () => {
	test("a cue is spoken as one line, its tags taken out", () => {
		expect(toSpokenText({ text: "<i>Hello</i>\n{\\an8}there,  friend " })).toBe(
			"Hello there, friend",
		);
	});

	test("the same cue spoken the same way has the same key, and another way another", () => {
		const hash = hashSpeech({ choice: CHOICE, text: "Hello" });
		expect(hash).toMatch(/^[0-9a-f]{16}$/);
		expect(hashSpeech({ choice: CHOICE, text: "Hello" })).toBe(hash);
		expect(hashSpeech({ choice: CHOICE, text: "Hello." })).not.toBe(hash);
		expect(
			hashSpeech({ choice: { ...CHOICE, voice: "nova" }, text: "Hello" }),
		).not.toBe(hash);
		expect(
			hashSpeech({
				choice: { ...CHOICE, instructions: "calm" },
				text: "Hello",
			}),
		).not.toBe(hash);
	});

	test("a spoken cue's file is named by a few of its words and its key", () => {
		expect(
			nameSpokenFile({
				text: 'He said: "where/when?" and then a long while after',
				hash: "0123456789abcdef",
			}),
		).toBe("He said wherewhen and then a lon · 0123456789abcdef.wav");
		expect(nameSpokenFile({ text: "???", hash: "0123456789abcdef" })).toBe(
			"Cue · 0123456789abcdef.wav",
		);
	});

	test("speech that fits plays as it is", () => {
		expect(fitSpeech({ speech: 1.5, start: 0, end: 2, nextStart: 3 })).toEqual({
			rate: 1,
			length: 1.5,
			isTooLong: false,
		});
	});

	test("speech a little long is sped up to fit", () => {
		const fit = fitSpeech({ speech: 2.2, start: 0, end: 2, nextStart: 3 });
		expect(fit.rate).toBeCloseTo(1.1);
		expect(fit.length).toBeCloseTo(2);
		expect(fit.isTooLong).toBe(false);
	});

	test("speech much too long is sped up as far as it goes, and said to run over", () => {
		const fit = fitSpeech({ speech: 4, start: 0, end: 2, nextStart: null });
		expect(fit.rate).toBe(MAX_SPEED_UP);
		expect(fit.length).toBeCloseTo(4 / MAX_SPEED_UP);
		expect(fit.isTooLong).toBe(true);
	});
});
