import { describe, expect, test } from "bun:test";
import {
	fitSpeech,
	hashSpeech,
	isSpokenFile,
	listCuesToSend,
	MAX_SPEED_UP,
	nameSpokenFile,
	SPOKEN_TRACK_NAME,
	spokenTrackName,
	toSpokenText,
	type CueToSpeak,
	type SpeechChoice,
} from "../speech";
import type { MediaAsset } from "@/media/types";
import type { TextTrack } from "@/timeline";

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
		expect(
			nameSpokenFile({ text: "Bell\u0007 rings", hash: "0123456789abcdef" }),
		).toBe("Bell  rings · 0123456789abcdef.wav");
	});

	test("a spoken cue is found by its key, also where its file got a number", () => {
		const hash = "0123456789abcdef";
		expect(isSpokenFile({ name: `Hello · ${hash}.wav`, hash })).toBe(true);
		expect(isSpokenFile({ name: `Hello · ${hash} 2.wav`, hash })).toBe(true);
		expect(isSpokenFile({ name: `Hello · ${hash}2.wav`, hash })).toBe(false);
		expect(isSpokenFile({ name: "Hello · fedcba9876543210.wav", hash })).toBe(
			false,
		);
	});

	test("each text is sent once, and none spoken before", () => {
		const cue = ({ text, asset }: { text: string; asset?: MediaAsset }) =>
			({
				start: 0,
				end: 1,
				nextStart: null,
				text,
				hash: hashSpeech({ choice: CHOICE, text }),
				asset: asset ?? null,
			}) satisfies CueToSpeak;
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- a stand-in: only whether there is one counts.
		const spoken = { id: "a" } as MediaAsset;
		const sent = listCuesToSend({
			cues: [
				cue({ text: "Yes." }),
				cue({ text: "No." }),
				cue({ text: "Yes." }),
				cue({ text: "Maybe.", asset: spoken }),
			],
		});
		expect(sent.map(({ text }) => text)).toEqual(["Yes.", "No."]);
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

	test("a translation is spoken onto a track of its own, beside the original's", () => {
		const original: TextTrack = {
			id: "en",
			name: "Subtitles",
			type: "text",
			elements: [],
			hidden: false,
			subtitles: true,
		};
		const translation: TextTrack = {
			...original,
			id: "it",
			name: "Italiano",
			translationOf: "en",
		};
		expect(spokenTrackName({ track: original })).toBe(SPOKEN_TRACK_NAME);
		expect(spokenTrackName({ track: translation })).toBe(
			`${SPOKEN_TRACK_NAME}: Italiano`,
		);
	});
});
