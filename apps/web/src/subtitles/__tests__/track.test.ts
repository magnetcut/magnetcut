import { describe, expect, test } from "bun:test";
import type { SceneTracks, TextTrack } from "@/timeline";
import { DEFAULTS } from "@/timeline/defaults";
import {
	ZERO_MEDIA_TIME,
	mediaTimeFromSeconds,
	mediaTimeToSeconds,
} from "@/wasm";
import {
	fixTrackOverlaps,
	formatClock,
	getOriginalLine,
	getTypedCaption,
	snapTrack,
	parseClock,
	getReadingSpeed,
	getSubtitleLines,
	getSubtitleTracks,
	retimeTrack,
	saveTrack,
} from "../track";

function subtitleTrack({
	lines,
}: {
	lines: Array<[number, number, string]>;
}): TextTrack {
	return {
		id: "subs",
		name: "Subtitles",
		type: "text",
		hidden: false,
		subtitles: true,
		elements: lines.map(([start, end, text], index) => ({
			...DEFAULTS.text.element,
			id: `line-${index}`,
			startTime: mediaTimeFromSeconds({ seconds: start }),
			duration: mediaTimeFromSeconds({ seconds: end - start }),
			params: { ...DEFAULTS.text.element.params, content: text },
		})),
	};
}

describe("subtitle tracks", () => {
	test("are found among the scene's tracks", () => {
		const subtitles = subtitleTrack({ lines: [[1, 2, "Hi"]] });
		const text: TextTrack = { ...subtitles, id: "text", subtitles: undefined };
		const tracks: SceneTracks = {
			overlay: [text, subtitles],
			main: {
				id: "main",
				name: "Main",
				type: "video",
				elements: [],
				muted: false,
				hidden: false,
			},
			audio: [],
		};
		expect(getSubtitleTracks({ tracks })).toEqual([subtitles]);
	});

	test("give their lines in order, as cues", () => {
		const track = subtitleTrack({
			lines: [
				[3, 4, "Second"],
				[1, 2.5, "First"],
			],
		});
		expect(getSubtitleLines({ track }).map(({ cue }) => cue)).toEqual([
			{ start: 1, end: 2.5, text: "First" },
			{ start: 3, end: 4, text: "Second" },
		]);
		expect(
			getReadingSpeed({ cue: { start: 0, end: 2, text: "<i>Hello</i>\nyou" } }),
		).toBe(4);
	});

	test("are retimed as element updates for the lines that move", () => {
		const track = subtitleTrack({
			lines: [
				[1, 2, "a"],
				[3, 4, "b"],
			],
		});
		const updates = retimeTrack({ track, retime: { scale: 1, offset: 0.5 } });
		expect(updates).toHaveLength(2);
		const [first] = updates;
		expect(first.elementId).toBe("line-0");
		expect(
			mediaTimeToSeconds({ time: first.patch.startTime ?? ZERO_MEDIA_TIME }),
		).toBeCloseTo(1.5, 6);
		expect(
			mediaTimeToSeconds({ time: first.patch.duration ?? ZERO_MEDIA_TIME }),
		).toBeCloseTo(1, 6);
		expect(retimeTrack({ track, retime: { scale: 1, offset: 0 } })).toEqual([]);
	});

	test("have overlaps fixed by ending lines sooner", () => {
		const track = subtitleTrack({
			lines: [
				[1, 3.2, "a"],
				[3, 4, "b"],
			],
		});
		const updates = fixTrackOverlaps({ track, gap: 0.1 });
		expect(updates.map(({ elementId }) => elementId)).toEqual(["line-0"]);
		expect(
			mediaTimeToSeconds({
				time: updates[0].patch.duration ?? ZERO_MEDIA_TIME,
			}),
		).toBeCloseTo(1.9, 6);
	});

	test("are saved as subtitle files", () => {
		const track = subtitleTrack({ lines: [[1.5, 3, "Hello\nthere"]] });
		expect(saveTrack({ track, format: "srt" })).toBe(
			"1\n00:00:01,500 --> 00:00:03,000\nHello\nthere\n\n",
		);
	});

	test("write and read clock times", () => {
		expect(formatClock({ seconds: 61.5 })).toBe("1:01.500");
		expect(formatClock({ seconds: 3723.25 })).toBe("1:02:03.250");
		expect(parseClock({ text: "1:01.5" })).toBe(61.5);
		expect(parseClock({ text: "1:02:03,25" })).toBe(3723.25);
		expect(parseClock({ text: "7" })).toBe(7);
		expect(parseClock({ text: "1:x" })).toBeNull();
	});

	test("snap to speech and cuts", () => {
		const track = subtitleTrack({ lines: [[1.1, 2.9, "a"]] });
		const [update] = snapTrack({ track, starts: [1], ends: [3] });
		expect(
			mediaTimeToSeconds({ time: update.patch.startTime ?? ZERO_MEDIA_TIME }),
		).toBeCloseTo(1, 6);
		expect(
			mediaTimeToSeconds({ time: update.patch.duration ?? ZERO_MEDIA_TIME }),
		).toBeCloseTo(2, 6);
	});

	test("take a typed line, readable and before the next", () => {
		const track = subtitleTrack({ lines: [[10, 12, "next"]] });
		expect(getTypedCaption({ track, text: "Hi", start: 2 })).toEqual({
			text: "Hi",
			startTime: 2,
			duration: 1,
		});
		const long = "x".repeat(60);
		expect(
			getTypedCaption({ track, text: long, start: 7 }).duration,
		).toBeCloseTo(3 - 2 / 24, 6);
	});

	test("find the original line a translated one stands for", () => {
		const original = subtitleTrack({
			lines: [
				[1, 3, "Hello"],
				[3.5, 5, "Bye"],
			],
		});
		const line = getOriginalLine({
			original,
			cue: { start: 2.5, end: 4.8, text: "Au revoir" },
		});
		expect(line?.cue.text).toBe("Bye");
		expect(
			getOriginalLine({ original, cue: { start: 6, end: 7, text: "?" } }),
		).toBeNull();
	});
});
