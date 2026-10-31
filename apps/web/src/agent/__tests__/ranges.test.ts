import { expect, test } from "bun:test";
import type { AudioElement, SceneTracks, VideoElement } from "@/timeline";
import { mediaTime, TICKS_PER_SECOND } from "@/wasm";
import { mergeRanges, removeRanges } from "../ranges";

const s = (seconds: number) => Math.round(seconds * TICKS_PER_SECOND);

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
		name: id,
		mediaId: "m",
		startTime: mediaTime({ ticks: s(start) }),
		duration: mediaTime({ ticks: s(length) }),
		trimStart: mediaTime({ ticks: s(trim) }),
		trimEnd: mediaTime({ ticks: 0 }),
		params: {},
	};
}

function tracks(): SceneTracks {
	const music: AudioElement = {
		id: "music",
		type: "audio",
		sourceType: "upload",
		mediaId: "a",
		name: "music",
		startTime: mediaTime({ ticks: s(15) }),
		duration: mediaTime({ ticks: s(5) }),
		trimStart: mediaTime({ ticks: 0 }),
		trimEnd: mediaTime({ ticks: 0 }),
		params: {},
	};
	return {
		main: {
			id: "main",
			name: "Main",
			type: "video",
			muted: false,
			hidden: false,
			elements: [
				clip({ id: "one", start: 0, length: 10 }),
				clip({ id: "two", start: 10, length: 10 }),
			],
			transitions: [
				{
					id: "t",
					fromElementId: "one",
					toElementId: "two",
					type: "cross-dissolve",
					duration: mediaTime({ ticks: s(0.5) }),
					alignment: "center",
					params: {},
					crossfadeAudio: true,
				},
			],
		},
		overlay: [],
		audio: [
			{ id: "a1", name: "A", type: "audio", muted: false, elements: [music] },
		],
	};
}

const view = (element: {
	id: string;
	startTime: number;
	duration: number;
	trimStart: number;
	trimEnd: number;
}) => ({
	id: element.id,
	start: element.startTime / TICKS_PER_SECOND,
	length: element.duration / TICKS_PER_SECOND,
	trimStart: element.trimStart / TICKS_PER_SECOND,
	trimEnd: element.trimEnd / TICKS_PER_SECOND,
});

test("a stretch across a cut shortens both clips and closes up, the media where it was", () => {
	const result = removeRanges({
		tracks: tracks(),
		ranges: [{ from: s(5), to: s(12) }],
	});
	expect(result.main.elements.map(view)).toEqual([
		{ id: "one", start: 0, length: 5, trimStart: 0, trimEnd: 5 },
		{ id: "two", start: 5, length: 8, trimStart: 2, trimEnd: 0 },
	]);
	// They still meet, so the transition stays.
	expect(result.main.transitions).toHaveLength(1);
	// What's after moves up by the stretch.
	expect(view(result.audio[0].elements[0])).toEqual({
		id: "music",
		start: 8,
		length: 5,
		trimStart: 0,
		trimEnd: 0,
	});
});

test("a stretch inside a clip leaves two pieces, joined where it was", () => {
	const result = removeRanges({
		tracks: tracks(),
		ranges: [{ from: s(2), to: s(4) }],
	});
	const [first, second, third] = result.main.elements.map(view);
	expect(first).toEqual({
		id: "one",
		start: 0,
		length: 2,
		trimStart: 0,
		trimEnd: 8,
	});
	expect(second.id).not.toBe("one");
	expect(second).toMatchObject({
		start: 2,
		length: 6,
		trimStart: 4,
		trimEnd: 0,
	});
	expect(third).toMatchObject({ id: "two", start: 8, length: 10 });
});

test("several stretches are each taken where they were given", () => {
	const result = removeRanges({
		tracks: tracks(),
		ranges: [
			{ from: s(2), to: s(3) },
			{ from: s(12), to: s(14) },
		],
	});
	expect(
		result.main.elements.map(view).map(({ start, length }) => [start, length]),
	).toEqual([
		[0, 2],
		[2, 7],
		[9, 2],
		[11, 6],
	]);
	expect(
		mergeRanges({
			ranges: [
				{ from: 5, to: 8 },
				{ from: 1, to: 2 },
				{ from: 7, to: 9 },
			],
		}),
	).toEqual([
		{ from: 1, to: 2 },
		{ from: 5, to: 9 },
	]);
});
