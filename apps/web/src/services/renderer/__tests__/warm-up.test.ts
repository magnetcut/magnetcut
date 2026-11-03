import { describe, expect, test } from "bun:test";
import type { MediaAsset } from "@/media/types";
import type { SceneTracks, Transition, VideoElement } from "@/timeline";
import { mediaTime, TICKS_PER_SECOND } from "@/wasm";
import { getVideoSourceTime } from "../resolve";
import { buildScene } from "../scene-builder";
import { findVideoWarmUps } from "../warm-up";

const seconds = (value: number) =>
	mediaTime({ ticks: Math.round(value * TICKS_PER_SECOND) });

// Three 5 s clips of one file, each with 2 s trimmed off either end.
function clip({ id, start }: { id: string; start: number }): VideoElement {
	return {
		id,
		type: "video",
		name: id,
		mediaId: "file",
		startTime: seconds(start),
		duration: seconds(5),
		trimStart: seconds(2),
		trimEnd: seconds(2),
		params: {},
	};
}

function scene({ transitions }: { transitions: Transition[] }) {
	const tracks: SceneTracks = {
		overlay: [],
		main: {
			id: "main",
			name: "Main",
			type: "video",
			elements: [
				clip({ id: "a", start: 0 }),
				clip({ id: "b", start: 5 }),
				clip({ id: "c", start: 10 }),
			],
			muted: false,
			hidden: false,
			transitions,
		},
		audio: [],
	};
	return buildScene({
		canvasSize: { width: 1920, height: 1080 },
		tracks,
		mediaAssets: [
			{
				id: "file",
				name: "file",
				type: "video",
				file: new File([], "file"),
				url: "blob:file",
			} satisfies MediaAsset,
		],
		duration: seconds(15),
		background: { type: "color", color: "transparent" },
	});
}

// A second's crossfade from a to b, centred on their cut at 5 s.
const crossfade: Transition = {
	id: "ab",
	fromElementId: "a",
	toElementId: "b",
	type: "cross-dissolve",
	duration: seconds(1),
	alignment: "center",
	params: {},
	crossfadeAudio: true,
};

const warmUpsAt = ({
	root,
	at,
}: {
	root: ReturnType<typeof scene>;
	at: number;
}) =>
	findVideoWarmUps({ root, time: seconds(at), lookahead: seconds(3) }).map(
		({ sinkKey, start }) => ({ sinkKey, start }),
	);

describe("decoders sought ahead while the preview plays", () => {
	test("a transition's incoming side, not its outgoing one", () => {
		const root = scene({ transitions: [crossfade] });
		// a goes on into the window on its own decoder; b after the window
		// takes the one its side in the window has.
		expect(warmUpsAt({ root, at: 3 })).toEqual([
			{ sinkKey: "file#transition-1", start: seconds(4.5) },
		]);
	});

	test("nothing further than the lookahead", () => {
		const root = scene({ transitions: [crossfade] });
		expect(warmUpsAt({ root, at: 1 })).toEqual([]);
	});

	test("a clip whose decoder nothing plays from until it comes", () => {
		const root = scene({ transitions: [crossfade] });
		// c isn't in a transition: the file's usual decoder, which a and b
		// don't use.
		expect(warmUpsAt({ root, at: 8 })).toEqual([
			{ sinkKey: "file", start: seconds(10) },
		]);
	});

	test("not a clip whose decoder the one playing uses", () => {
		const root = scene({ transitions: [] });
		expect(warmUpsAt({ root, at: 3 })).toEqual([]);
	});

	test("sought to the frame the render asks for, in the handle", () => {
		const root = scene({ transitions: [crossfade] });
		const [warmUp] = findVideoWarmUps({
			root,
			time: seconds(3),
			lookahead: seconds(3),
		});
		// b starts 2 s into its file; its side, half a second before b.
		expect(
			getVideoSourceTime({ params: warmUp.node.params, time: warmUp.start }),
		).toBe(1.5);
	});
});
