import { describe, expect, test } from "bun:test";
import type {
	SceneTracks,
	TextTrack,
	Transition,
	VideoElement,
	VideoTrack,
} from "@/timeline";
import { dropBrokenTransitions, followSplitEnds } from "@/transitions";
import { mediaTime, TICKS_PER_SECOND } from "@/wasm";

const seconds = (value: number) =>
	mediaTime({ ticks: Math.round(value * TICKS_PER_SECOND) });

function video({
	id,
	start,
	duration,
}: {
	id: string;
	start: number;
	duration: number;
}): VideoElement {
	return {
		id,
		type: "video",
		name: id,
		mediaId: "clip",
		startTime: seconds(start),
		duration: seconds(duration),
		trimStart: seconds(0),
		trimEnd: seconds(2),
		params: {},
	};
}

function transition({
	id,
	from,
	to,
}: {
	id: string;
	from: string;
	to: string;
}): Transition {
	return {
		id,
		fromElementId: from,
		toElementId: to,
		type: "cross-dissolve",
		duration: seconds(0.5),
		alignment: "center",
		params: {},
		crossfadeAudio: true,
	};
}

const text: TextTrack = {
	id: "titles",
	name: "Titles",
	type: "text",
	elements: [],
	hidden: false,
};

function scene({
	elements,
	transitions,
}: {
	elements: VideoElement[];
	transitions: Transition[];
}): SceneTracks {
	const main: VideoTrack = {
		id: "main",
		name: "Main",
		type: "video",
		elements,
		muted: false,
		hidden: false,
		transitions,
	};
	return { main, overlay: [text], audio: [] };
}

const ids = ({ tracks }: { tracks: SceneTracks }) =>
	(tracks.main.transitions ?? []).map(
		({ id, fromElementId, toElementId }) =>
			`${id} ${fromElementId}|${toElementId}`,
	);

describe("transitions after edits", () => {
	test("kept while their clips touch, the same tracks back", () => {
		const tracks = scene({
			elements: [
				video({ id: "a", start: 0, duration: 2 }),
				video({ id: "b", start: 2, duration: 2 }),
			],
			transitions: [transition({ id: "t", from: "a", to: "b" })],
		});
		expect(dropBrokenTransitions({ tracks })).toBe(tracks);
	});

	test("dropped when a clip is gone or no longer touches", () => {
		const deleted = scene({
			elements: [video({ id: "a", start: 0, duration: 2 })],
			transitions: [transition({ id: "t", from: "a", to: "b" })],
		});
		expect(ids({ tracks: dropBrokenTransitions({ tracks: deleted }) })).toEqual(
			[],
		);

		const apart = scene({
			elements: [
				video({ id: "a", start: 0, duration: 2 }),
				video({ id: "b", start: 3, duration: 2 }),
			],
			transitions: [transition({ id: "t", from: "a", to: "b" })],
		});
		expect(ids({ tracks: dropBrokenTransitions({ tracks: apart }) })).toEqual(
			[],
		);
	});

	test("the last one at a cut wins", () => {
		const tracks = scene({
			elements: [
				video({ id: "a", start: 0, duration: 2 }),
				video({ id: "b", start: 2, duration: 2 }),
			],
			transitions: [
				transition({ id: "first", from: "a", to: "b" }),
				transition({ id: "second", from: "a", to: "b" }),
			],
		});
		expect(ids({ tracks: dropBrokenTransitions({ tracks }) })).toEqual([
			"second a|b",
		]);
	});

	test("a split clip's transition follows its end", () => {
		// "a" split at 1 s: "a" is now 0 to 1, "a2" 1 to 2, before "b".
		const tracks = scene({
			elements: [
				video({ id: "a", start: 0, duration: 1 }),
				video({ id: "a2", start: 1, duration: 1 }),
				video({ id: "b", start: 2, duration: 2 }),
			],
			transitions: [
				transition({ id: "out", from: "a", to: "b" }),
				transition({ id: "in", from: "z", to: "a" }),
			],
		});
		const split = followSplitEnds({ tracks, ends: new Map([["a", "a2"]]) });
		expect(ids({ tracks: split })).toEqual(["out a2|b", "in z|a"]);
		expect(followSplitEnds({ tracks, ends: new Map() })).toBe(tracks);
	});
});
