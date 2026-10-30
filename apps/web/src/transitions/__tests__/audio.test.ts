import { describe, expect, test } from "bun:test";
import type { SceneTracks, Transition, VideoElement } from "@/timeline";
import {
	getAudioCrossfades,
	getCrossfadeGain,
	getCrossfadeTimes,
} from "@/transitions";
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
		trimStart: seconds(2),
		trimEnd: seconds(2),
		params: {},
	};
}

function transition({
	from,
	to,
	crossfadeAudio = true,
}: {
	from: string;
	to: string;
	crossfadeAudio?: boolean;
}): Transition {
	return {
		id: `${from}-${to}`,
		fromElementId: from,
		toElementId: to,
		type: "cross-dissolve",
		duration: seconds(1),
		alignment: "center",
		params: {},
		crossfadeAudio,
	};
}

// Cuts at 4 and 8 s, each with a 1 s transition centred on it.
function scene({ crossfadeAudio = true } = {}): SceneTracks {
	return {
		main: {
			id: "main",
			name: "Main",
			type: "video",
			elements: [
				video({ id: "a", start: 0, duration: 4 }),
				video({ id: "b", start: 4, duration: 4 }),
				video({ id: "c", start: 8, duration: 4 }),
			],
			muted: false,
			hidden: false,
			transitions: [
				transition({ from: "a", to: "b", crossfadeAudio }),
				transition({ from: "b", to: "c", crossfadeAudio }),
			],
		},
		overlay: [],
		audio: [],
	};
}

describe("audio crossfades", () => {
	test("each clip plays into its handles across the windows", () => {
		const crossfades = getAudioCrossfades({ tracks: scene() });
		expect(crossfades.get("a")).toEqual({
			head: 0,
			tail: 0.5,
			fadeOut: { start: 3.5, end: 4.5 },
		});
		expect(crossfades.get("b")).toEqual({
			head: 0.5,
			tail: 0.5,
			fadeIn: { start: 3.5, end: 4.5 },
			fadeOut: { start: 7.5, end: 8.5 },
		});
		expect(crossfades.get("c")?.fadeIn).toEqual({ start: 7.5, end: 8.5 });
	});

	test("none where the transition leaves the audio alone", () => {
		const crossfades = getAudioCrossfades({
			tracks: scene({ crossfadeAudio: false }),
		});
		expect(crossfades.size).toBe(0);
	});

	test("equal power: the two gains squared add up to one", () => {
		const crossfades = getAudioCrossfades({ tracks: scene() });
		const gain = ({ id, time }: { id: string; time: number }) =>
			getCrossfadeGain({ crossfade: crossfades.get(id), time });

		expect(gain({ id: "a", time: 3.5 })).toBeCloseTo(1);
		expect(gain({ id: "b", time: 3.5 })).toBeCloseTo(0);
		expect(gain({ id: "a", time: 4.5 })).toBeCloseTo(0);
		expect(gain({ id: "b", time: 4.5 })).toBeCloseTo(1);
		expect(gain({ id: "b", time: 6 })).toBe(1);
		for (const time of [3.6, 3.9, 4, 4.2, 4.4]) {
			const out = gain({ id: "a", time });
			const into = gain({ id: "b", time });
			expect(out * out + into * into).toBeCloseTo(1);
		}
		expect(getCrossfadeGain({ crossfade: undefined, time: 4 })).toBe(1);
	});

	test("gain points across the fades only", () => {
		const crossfade = getAudioCrossfades({ tracks: scene() }).get("b");
		if (!crossfade) throw new Error("no crossfade");
		const times = getCrossfadeTimes({ crossfade, from: 4, to: 9, step: 0.25 });
		expect(times).toEqual([4, 4.25, 4.5, 7.5, 7.75, 8, 8.25, 8.5]);
	});
});
