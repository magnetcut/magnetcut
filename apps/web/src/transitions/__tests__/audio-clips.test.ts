import { describe, expect, test } from "bun:test";
import { collectAudioClips } from "@/media/audio";
import type { MediaAsset } from "@/media/types";
import type { SceneTracks, VideoElement } from "@/timeline";
import { mediaTime, TICKS_PER_SECOND } from "@/wasm";

const seconds = (value: number) =>
	mediaTime({ ticks: Math.round(value * TICKS_PER_SECOND) });

function video({
	id,
	start,
	rate,
}: {
	id: string;
	start: number;
	rate?: number;
}): VideoElement {
	return {
		id,
		type: "video",
		name: id,
		mediaId: "clip",
		startTime: seconds(start),
		duration: seconds(4),
		trimStart: seconds(2),
		trimEnd: seconds(2),
		params: {},
		...(rate && { retime: { rate } }),
	};
}

const clip: MediaAsset = {
	id: "clip",
	name: "clip.mp4",
	type: "video",
	file: new File([], "clip.mp4"),
	hasAudio: true,
};

// A 1 s crossfade centred on the cut at 4 s.
function scene({ rate }: { rate?: number } = {}): SceneTracks {
	return {
		main: {
			id: "main",
			name: "Main",
			type: "video",
			elements: [
				video({ id: "a", start: 0, rate }),
				video({ id: "b", start: 4, rate }),
			],
			muted: false,
			hidden: false,
			transitions: [
				{
					id: "t",
					fromElementId: "a",
					toElementId: "b",
					type: "cross-dissolve",
					duration: seconds(1),
					alignment: "center",
					params: {},
					crossfadeAudio: true,
				},
			],
		},
		overlay: [],
		audio: [],
	};
}

const timing = async ({ tracks }: { tracks: SceneTracks }) =>
	(await collectAudioClips({ tracks, mediaAssets: [clip] })).map(
		({ id, startTime, duration, trimStart, trimEnd }) => ({
			id,
			startTime,
			duration,
			trimStart,
			trimEnd,
		}),
	);

describe("clips' audio under a crossfade", () => {
	test("reaches into the handles across the window", async () => {
		expect(await timing({ tracks: scene() })).toEqual([
			// Half a second of the outgoing clip's tail, after the cut.
			{ id: "a", startTime: 0, duration: 4.5, trimStart: 2, trimEnd: 1.5 },
			// Half a second of the incoming clip's head, before it.
			{ id: "b", startTime: 3.5, duration: 4.5, trimStart: 1.5, trimEnd: 2 },
		]);
	});

	test("in source time when the clips are sped up", async () => {
		const [a, b] = await timing({ tracks: scene({ rate: 2 }) });
		expect(a.trimEnd).toBeCloseTo(1);
		expect(b.trimStart).toBeCloseTo(1);
	});
});
