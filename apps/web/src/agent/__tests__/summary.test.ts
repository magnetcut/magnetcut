import { describe as group, expect, test } from "bun:test";
import type { MediaAsset } from "@/media/types";
import type {
	AudioElement,
	SceneTracks,
	TextElement,
	VideoElement,
} from "@/timeline";
import { mediaTime, TICKS_PER_SECOND } from "@/wasm";
import { resolveId, shortIds } from "../ids";
import { buildSummary, describe, type SummaryInput } from "../summary";
import { formatTime, parseTime } from "../time";

const seconds = (value: number) =>
	mediaTime({ ticks: Math.round(value * TICKS_PER_SECOND) });

group("times", () => {
	test("take seconds, minutes and seconds, or a frame", () => {
		expect(parseTime({ value: 12.5, fps: 30 })).toBe(12.5 * TICKS_PER_SECOND);
		expect(parseTime({ value: "1:02.5", fps: 30 })).toBe(
			62.5 * TICKS_PER_SECOND,
		);
		expect(parseTime({ value: "f45", fps: 30 })).toBe(1.5 * TICKS_PER_SECOND);
		expect(parseTime({ value: "3s", fps: 30 })).toBe(3 * TICKS_PER_SECOND);
		expect(parseTime({ value: "soon", fps: 30 })).toBeNull();
		expect(parseTime({ value: -1, fps: 30 })).toBeNull();
	});

	test("read as m:ss.s", () => {
		expect(formatTime({ ticks: 0 })).toBe("0:00.0");
		expect(formatTime({ ticks: 74.25 * TICKS_PER_SECOND })).toBe("1:14.3");
		expect(formatTime({ ticks: 3725 * TICKS_PER_SECOND })).toBe("1:02:05.0");
	});
});

group("short ids", () => {
	test("are five characters, more where two share them", () => {
		const ids = ["abcdef12", "abcdeX99", "zzzzzzzz"];
		const short = shortIds({ ids });
		expect(short.get("zzzzzzzz")).toBe("zzzzz");
		expect(short.get("abcdef12")).toBe("abcdef");
		expect(short.get("abcdeX99")).toBe("abcdeX");
		expect(resolveId({ short: "abcdef", ids })).toBe("abcdef12");
		expect(resolveId({ short: "abcde", ids })).toBeNull();
	});
});

function clip({
	id,
	start,
	length,
	trim = 0,
}: {
	id: string;
	start: number;
	length: number;
	trim?: number;
}): VideoElement {
	return {
		id,
		type: "video",
		name: "beach",
		mediaId: "m1aaaaaa",
		startTime: seconds(start),
		duration: seconds(length),
		trimStart: seconds(trim),
		trimEnd: seconds(0),
		params: {},
	};
}

function input(): SummaryInput {
	const assets: MediaAsset[] = [
		{
			id: "m1aaaaaa",
			name: "beach.mp4",
			type: "video",
			duration: 92,
			width: 3840,
			height: 2160,
			hasAudio: true,
			file: new File([], "beach.mp4"),
		},
		{
			id: "m2bbbbbb",
			name: "music.mp3",
			type: "audio",
			duration: 190,
			file: new File([], "music.mp3"),
		},
	];
	const line: TextElement = {
		id: "s1xxxxxx",
		type: "text",
		name: "line",
		startTime: seconds(1.2),
		duration: seconds(2),
		trimStart: seconds(0),
		trimEnd: seconds(0),
		params: { content: "Hello there" },
	};
	const music: AudioElement = {
		id: "c71d0cxx",
		type: "audio",
		sourceType: "upload",
		mediaId: "m2bbbbbb",
		name: "music",
		startTime: seconds(0),
		duration: seconds(30),
		trimStart: seconds(0),
		trimEnd: seconds(0),
		params: {},
	};
	const tracks: SceneTracks = {
		main: {
			id: "main",
			name: "Main",
			type: "video",
			muted: false,
			hidden: false,
			elements: [
				clip({ id: "c3f9a1xx", start: 0, length: 12.4, trim: 4 }),
				clip({ id: "c8b20exx", start: 12.4, length: 17.6 }),
			],
			transitions: [
				{
					id: "t1",
					fromElementId: "c3f9a1xx",
					toElementId: "c8b20exx",
					type: "cross-dissolve",
					duration: seconds(0.5),
					alignment: "center",
					params: {},
					crossfadeAudio: true,
				},
			],
		},
		overlay: [
			{
				id: "subs",
				name: "Subtitles",
				type: "text",
				hidden: false,
				subtitles: true,
				elements: [line],
			},
		],
		audio: [
			{
				id: "a1",
				name: "Music",
				type: "audio",
				muted: false,
				elements: [music],
			},
		],
	};
	return {
		name: "Trip",
		canvasSize: { width: 1920, height: 1080 },
		fps: 30,
		duration: seconds(30),
		revision: "3fa9c1",
		assets,
		tracks,
	};
}

group("the summary", () => {
	test("is a few lines, short ids and times, only what's set", () => {
		expect(buildSummary(input())).toBe(
			[
				'"Trip" 1920x1080 30fps 0:30.0 rev 3fa9c1',
				"media m1aaa beach.mp4 1:32.0 3840x2160 | m2bbb music.mp3 3:10.0",
				"T1 subtitles 1 lines 0:01.2-0:03.2",
				"V1 c3f9a m1aaa 0:00.0-0:12.4 src 0:04.0-0:16.4 >cross-dissolve 0.5 | c8b20 m1aaa 0:12.4-0:30.0",
				"A1 c71d0 m2bbb 0:00.0-0:30.0",
			].join("\n"),
		);
	});

	test("gives one thing's detail when it's asked for", () => {
		expect(describe({ id: "T1", input: input() })).toBe(
			's1xxx 0:01.2-0:03.2 "Hello there"',
		);
		const clip = describe({ id: "c3f9a", input: input() });
		expect(clip).toContain("c3f9a on V1, 0:00.0-0:12.4");
		expect(clip).toContain('"trimStart": "0:04.0"');
		expect(describe({ id: "m2bbb", input: input() })).toContain("music.mp3");
		expect(describe({ id: "nothing", input: input() })).toBeNull();
	});
});
