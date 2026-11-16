import { describe, expect, test } from "bun:test";
import type { SubtitleFormat } from "magnetcut-wasm";
import type { SceneTracks, TextTrack } from "@/timeline";
import { DEFAULTS } from "@/timeline/defaults";
import {
	ZERO_MEDIA_TIME,
	mediaTimeFromSeconds,
	mediaTimeToSeconds,
} from "@/wasm";
import { buildSubtitleTextElement } from "../build-subtitle-text-element";
import { openSubtitleFile } from "../open";
import {
	fixTrackOverlaps,
	formatClock,
	getEditedCue,
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
	lines: Array<[number, number, string, Record<string, string>?]>;
}): TextTrack {
	return {
		id: "subs",
		name: "Subtitles",
		type: "text",
		hidden: false,
		subtitles: true,
		elements: lines.map(([start, end, text, style], index) => ({
			...DEFAULTS.text.element,
			id: `line-${index}`,
			startTime: mediaTimeFromSeconds({ seconds: start }),
			duration: mediaTimeFromSeconds({ seconds: end - start }),
			params: { ...DEFAULTS.text.element.params, content: text, ...style },
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

	test("are saved with each line's italics, bold and underline", () => {
		const italic = { fontStyle: "italic" };
		const bold = { fontWeight: "bold" };
		const track = subtitleTrack({
			lines: [
				[1, 2, "One\ntwo", italic],
				[3, 4, "Loud", { ...bold, textDecoration: "underline" }],
				[5, 6, "Plain"],
			],
		});
		expect(saveTrack({ track, format: "srt" })).toBe(
			"1\n00:00:01,000 --> 00:00:02,000\n<i>One\ntwo</i>\n\n" +
				"2\n00:00:03,000 --> 00:00:04,000\n<b><u>Loud</u></b>\n\n" +
				"3\n00:00:05,000 --> 00:00:06,000\nPlain\n\n",
		);
		// Every line bold, as subtitles are unless a file says: nothing said.
		const allBold = subtitleTrack({
			lines: [
				[1, 2, "a", bold],
				[3, 4, "b", bold],
			],
		});
		expect(saveTrack({ track: allBold, format: "srt" })).not.toContain("<b>");
	});

	test("are saved and opened again as they were", async () => {
		const text = "5 < 6 and 7 > 3 {note}";
		const track = subtitleTrack({
			lines: [
				[1, 2, text],
				[61.6, 63, "Two\nlines", { fontStyle: "italic" }],
			],
		});
		const formats: SubtitleFormat[] = [
			"srt",
			"vtt",
			"ass",
			"ssa",
			"subviewer",
			"microdvd",
		];
		const rounded = (time: number) => Math.round(time * 1000) / 1000;
		for (const format of formats) {
			const saved = saveTrack({ track, format, frameRate: 25 });
			// MicroDVD opened at the rate it was saved at, not the one given.
			const { captions } = await openSubtitleFile({
				file: new File([saved], `film.${format}`),
				frameRate: 30,
			});
			expect(
				captions.map((caption) => ({
					text: caption.text,
					start: rounded(caption.startTime),
					duration: rounded(caption.duration),
					isItalic: caption.style?.fontStyle === "italic",
				})),
			).toEqual([
				{ text, start: 1, duration: 1, isItalic: false },
				{
					text: "Two\nlines",
					start: 61.6,
					duration: 1.4,
					// SubViewer has no italics.
					isItalic: format !== "subviewer",
				},
			]);
		}
	});

	test("opened from an ASS file, are saved with its header and styles", async () => {
		const script = `[Script Info]
Title: Film
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 720

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,10,10,30,1
Style: Sign,Georgia,36,&H0000FFFF,&H000000FF,&H00000000,&H00000000,0,1,0,0,100,100,0,0,1,2,1,8,10,10,20,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.50,0:00:03.25,Default,,0,0,0,,Hello,\\Nthere
Dialogue: 0,0:00:04.00,0:00:05.00,Sign,,0,0,0,,Exit
Dialogue: 0,0:00:06.00,0:00:07.00,Default,,0,0,0,,{\\i1}Whispered{\\i0}
`;
		const opened = await openSubtitleFile({
			file: new File([script], "film.ass"),
		});
		// As the import puts them on a track.
		const track: TextTrack = {
			...subtitleTrack({ lines: [] }),
			assScript: opened.assScript,
			elements: opened.captions.map((caption, index) => ({
				...buildSubtitleTextElement({
					index,
					caption,
					canvasSize: { width: 1920, height: 1080 },
				}),
				id: `line-${index}`,
			})),
		};
		expect(saveTrack({ track, format: "ass" })).toBe(script);
		// In another format, the styles' italics said as markup.
		const srt = saveTrack({ track, format: "srt" });
		expect(srt).toContain("\n<i>Exit</i>\n");
		expect(srt).toContain("\n<i>Whispered</i>\n");
		// As SSA, a default style: its own are ASS's.
		expect(saveTrack({ track, format: "ssa" })).not.toContain("Sign");
	});

	test("are edited over the line as it is now", () => {
		// Shifted by half a second after its editor opened: the times left
		// alone are the line's now, not the ones the editor first showed.
		const cue = { start: 1.5, end: 2.5, text: "Hello" };
		expect(getEditedCue({ cue, start: null, end: null, text: "Hi" })).toEqual({
			start: 1.5,
			end: 2.5,
			text: "Hi",
		});
		expect(
			getEditedCue({ cue, start: "0:02.000", end: null, text: null }),
		).toEqual({ start: 2, end: 2.5, text: "Hello" });
		expect(
			getEditedCue({ cue, start: "0:03", end: null, text: null }),
		).toBeNull();
		expect(getEditedCue({ cue, start: "x", end: null, text: null })).toBeNull();
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
