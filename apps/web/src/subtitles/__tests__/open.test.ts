import { describe, expect, test } from "bun:test";
import { openSubtitleFile } from "../open";

const file = ({
	name,
	content,
}: {
	name: string;
	content: string | Uint8Array<ArrayBuffer>;
}) => new File([content], name);

describe("openSubtitleFile", () => {
	test("opens SRT as captions, italic cues styled as a whole", async () => {
		const result = await openSubtitleFile({
			file: file({
				name: "film.srt",
				content:
					"1\n00:00:01,500 --> 00:00:03,000\n<i>Hello</i>\n\n2\n00:00:04,000 --> 00:00:05,000\nSo <b>very</b> loud\n",
			}),
		});
		expect(result.captions).toEqual([
			{
				text: "Hello",
				startTime: 1.5,
				duration: 1.5,
				style: { fontStyle: "italic" },
			},
			{ text: "So very loud", startTime: 4, duration: 1 },
		]);
		expect(result.warnings).toHaveLength(1);
	});

	test("opens WebVTT, SubViewer and MicroDVD too", async () => {
		const cases = [
			{ name: "a.vtt", content: "WEBVTT\n\n00:01.000 --> 00:02.000\nHi\n" },
			{ name: "a.sub", content: "00:00:01.00,00:00:02.00\nHi\n" },
			{ name: "a.sub", content: "{1}{1}25\n{25}{50}Hi\n" },
		];
		for (const { name, content } of cases) {
			const result = await openSubtitleFile({ file: file({ name, content }) });
			expect(result.captions).toEqual([
				{ text: "Hi", startTime: 1, duration: 1 },
			]);
		}
	});

	test("reads a file in an old encoding", async () => {
		const bytes = new Uint8Array([
			...new TextEncoder().encode("1\n00:00:01,000 --> 00:00:02,000\nCaf"),
			0xe9,
		]);
		const result = await openSubtitleFile({
			file: file({ name: "a.srt", content: bytes }),
		});
		expect(result.captions[0].text).toBe("Café");
	});

	test("maps ASS styles as the captions have them", async () => {
		const content = `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Top,Georgia,108,&H0000FFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,3,0,0,8,96,96,54,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:02.00,Top,,0,0,0,,Exit
`;
		const result = await openSubtitleFile({
			file: file({ name: "a.ass", content }),
		});
		expect(result.warnings).toEqual([]);
		expect(result.captions[0]).toEqual({
			text: "Exit",
			startTime: 1,
			duration: 1,
			style: {
				fontFamily: "Georgia",
				fontSizeRatioOfPlayHeight: 0.1,
				color: "#ffff00",
				fontWeight: "bold",
				fontStyle: "normal",
				textAlign: "center",
				placement: {
					verticalAlign: "top",
					marginLeftRatio: 0.05,
					marginRightRatio: 0.05,
					marginVerticalRatio: 0.05,
				},
				background: { enabled: true, color: "rgba(0, 0, 0, 0.498)" },
			},
		});
	});

	test("says what it can't open", async () => {
		expect(
			openSubtitleFile({
				file: file({ name: "notes.txt", content: "just words" }),
			}),
		).rejects.toThrow();
	});
});
