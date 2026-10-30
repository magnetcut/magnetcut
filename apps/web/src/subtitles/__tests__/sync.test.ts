import { describe, expect, test } from "bun:test";
import type { TextTrack } from "@/timeline";
import { DEFAULTS } from "@/timeline/defaults";
import { mediaTimeFromSeconds } from "@/wasm";
import {
	fitTrackToSpeech,
	getWordsFromSegments,
	syncLinesToSpeech,
} from "../sync";

describe("syncing", () => {
	test("places a segment's words in it by their length", () => {
		const words = getWordsFromSegments({
			segments: [{ text: " Hi there", start: 1, end: 3.8 }],
		});
		const rounded = (time: number) => Math.round(time * 1000) / 1000;
		expect(
			words.map(({ text, start, end }) => [text, rounded(start), rounded(end)]),
		).toEqual([
			["Hi", 1, 1.8],
			["there", 1.8, 3.8],
		]);
	});

	test("times pasted lines to what was heard", () => {
		const captions = syncLinesToSpeech({
			text: "Hello there.\n\nHow are you?\n",
			segments: [
				{ text: " Hello there.", start: 1, end: 2 },
				{ text: " How are you?", start: 3, end: 4.1 },
			],
		});
		expect(captions?.map(({ text }) => text)).toEqual([
			"Hello there.",
			"How are you?",
		]);
		expect(captions?.[1].startTime).toBeCloseTo(3, 6);
		expect(syncLinesToSpeech({ text: "", segments: [] })).toBeNull();
	});

	test("uses Whisper's own word times when it has them", () => {
		const captions = syncLinesToSpeech({
			text: "Hello there.\nHow are you?",
			segments: [{ text: " Hello there. How are you?", start: 0, end: 10 }],
			words: [
				{ text: " Hello", start: 1, end: 1.4 },
				{ text: " there.", start: 1.5, end: 2 },
				{ text: " How", start: 7, end: 7.2 },
				{ text: " are", start: 7.2, end: 7.4 },
				{ text: " you?", start: 7.4, end: 8 },
			],
		});
		expect(captions?.map(({ startTime }) => startTime)).toEqual([1, 7]);
		expect(captions?.[1].duration).toBeCloseTo(1, 6);
	});

	test("lines a late track up with the speech", () => {
		// Speech every 3 s for 2 s; the lines 1.5 s late.
		const speech = Array.from({ length: 40 }, (_, index) => ({
			start: index * 3 + (index % 3) * 0.4,
			end: index * 3 + 2,
		}));
		const track: TextTrack = {
			id: "subs",
			name: "Subtitles",
			type: "text",
			hidden: false,
			subtitles: true,
			elements: speech.map((span, index) => ({
				...DEFAULTS.text.element,
				id: `line-${index}`,
				startTime: mediaTimeFromSeconds({ seconds: span.start + 1.5 }),
				duration: mediaTimeFromSeconds({ seconds: span.end - span.start }),
				params: { ...DEFAULTS.text.element.params, content: "line" },
			})),
		};
		const result = fitTrackToSpeech({ track, speech });
		expect(result?.fit.retime.offset).toBeCloseTo(-1.5, 1);
		expect(result?.updates).toHaveLength(40);
	});
});
