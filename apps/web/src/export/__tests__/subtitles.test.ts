import { describe, expect, test } from "bun:test";
import type { SceneTracks, TextTrack } from "@/timeline";
import { DEFAULTS } from "@/timeline/defaults";
import { mediaTimeFromSeconds } from "@/wasm";
import {
	canHoldSubtitleTracks,
	getPictureTracks,
	getSubtitleFiles,
} from "../subtitles";

const subtitles: TextTrack = {
	id: "subs",
	name: "Subtitles",
	type: "text",
	hidden: false,
	subtitles: true,
	elements: [
		{
			...DEFAULTS.text.element,
			id: "line",
			startTime: mediaTimeFromSeconds({ seconds: 1 }),
			duration: mediaTimeFromSeconds({ seconds: 1.5 }),
			params: { ...DEFAULTS.text.element.params, content: "Hello" },
		},
	],
};
const title: TextTrack = { ...subtitles, id: "title", subtitles: undefined };
const tracks: SceneTracks = {
	overlay: [title, subtitles],
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

describe("subtitles in an export", () => {
	test("leave the picture only when they go in tracks alone", () => {
		const [titleTrack, subtitleTrack] = getPictureTracks({
			tracks,
			subtitles: "track",
		}).overlay;
		expect(titleTrack.type === "text" && titleTrack.hidden).toBe(false);
		expect(subtitleTrack.type === "text" && subtitleTrack.hidden).toBe(true);
		expect(getPictureTracks({ tracks, subtitles: "both" })).toBe(tracks);
	});

	test("become WebVTT files for their tracks", () => {
		expect(getSubtitleFiles({ tracks, subtitles: "picture" })).toEqual([]);
		expect(getSubtitleFiles({ tracks, subtitles: "both" })).toEqual([
			{
				name: "Subtitles",
				vtt: "WEBVTT\n\n00:00:01.000 --> 00:00:02.500\nHello\n\n",
			},
		]);
	});

	test("go in every container but QuickTime", () => {
		expect(canHoldSubtitleTracks({ format: "mp4" })).toBe(true);
		expect(canHoldSubtitleTracks({ format: "webm" })).toBe(true);
		expect(canHoldSubtitleTracks({ format: "mov" })).toBe(false);
	});
});
