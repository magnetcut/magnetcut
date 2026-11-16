import { describe, expect, test } from "bun:test";
import type {
	SceneTracks,
	TransitionAlignment,
	VideoElement,
} from "@/timeline";
import { buildSeparatedAudioElement } from "@/timeline/audio-separation";
import { getFadeGain, readClipFades } from "@/timeline/audio-fades";
import { getAudioCrossfades, getCrossfadeGain } from "@/transitions";
import { mediaTime, TICKS_PER_SECOND } from "@/wasm";

const s = (seconds: number) =>
	mediaTime({ ticks: Math.round(seconds * TICKS_PER_SECOND) });

function clip({
	id,
	start,
	params = {},
}: {
	id: string;
	start: number;
	params?: VideoElement["params"];
}): VideoElement {
	return {
		id,
		type: "video",
		name: id,
		mediaId: "film",
		startTime: s(start),
		duration: s(5),
		trimStart: s(10),
		trimEnd: s(10),
		sourceDuration: s(25),
		params,
	};
}

/** One 0-5 and two 5-10, a second's dissolve centred on the cut, the sound
 * crossfading. */
function scene({
	alignment = "center",
}: { alignment?: TransitionAlignment } = {}) {
	const one = clip({
		id: "one",
		start: 0,
		params: { volume: -3, noiseReduction: 0.5, fadeIn: 0.5 },
	});
	const two = clip({ id: "two", start: 5 });
	const tracks: SceneTracks = {
		overlay: [],
		main: {
			id: "main",
			name: "Main",
			type: "video",
			muted: false,
			hidden: false,
			elements: [one, two],
			transitions: [
				{
					id: "dissolve",
					fromElementId: "one",
					toElementId: "two",
					type: "cross-dissolve",
					duration: s(1),
					alignment,
					params: {},
					crossfadeAudio: true,
				},
			],
		},
		audio: [],
	};
	return { tracks, one, two };
}

describe("a video clip's sound as an audio clip", () => {
	test("keeps its volume, effects and fades", () => {
		const { one } = scene();
		expect(buildSeparatedAudioElement({ sourceElement: one }).params).toEqual({
			volume: -3,
			muted: false,
			noiseReduction: 0.5,
			fadeIn: 0.5,
		});
	});

	test("reaches into the handles and fades across a crossfade, sounding as it did", () => {
		const { tracks, one, two } = scene();
		const crossfades = getAudioCrossfades({ tracks });
		for (const source of [one, two]) {
			const crossfade = crossfades.get(source.id);
			const audio = buildSeparatedAudioElement({
				sourceElement: source,
				crossfade,
			});
			// The same media under the same times: start and trims move alike.
			expect(audio.startTime - source.startTime).toBe(
				audio.trimStart - source.trimStart,
			);
			expect(audio.trimStart + audio.duration + audio.trimEnd).toBe(
				source.sourceDuration ?? 0,
			);

			const sourceFades = readClipFades({ element: source, crossfade });
			const audioFades = readClipFades({
				element: { ...audio, id: "audio" },
			});
			for (let time = 0; time <= 10; time += 0.125) {
				const inSource =
					time >=
						(source.startTime - s(crossfade?.head ?? 0)) / TICKS_PER_SECOND &&
					time <=
						(source.startTime + source.duration) / TICKS_PER_SECOND +
							(crossfade?.tail ?? 0);
				const before = inSource
					? getCrossfadeGain({ crossfade, time }) *
						getFadeGain({
							fades: sourceFades,
							clipTime: time - source.startTime / TICKS_PER_SECOND,
						})
					: 0;
				const audioStart = audio.startTime / TICKS_PER_SECOND;
				const audioEnd = audioStart + audio.duration / TICKS_PER_SECOND;
				const after =
					time >= audioStart && time <= audioEnd
						? getFadeGain({ fades: audioFades, clipTime: time - audioStart })
						: 0;
				expect(after).toBeCloseTo(before, 6);
			}
		}
	});

	test("a crossfade after the cut: the outgoing sound goes on past its end", () => {
		const { tracks, one, two } = scene({ alignment: "start" });
		const crossfades = getAudioCrossfades({ tracks });
		const outgoing = buildSeparatedAudioElement({
			sourceElement: one,
			crossfade: crossfades.get(one.id),
		});
		const incoming = buildSeparatedAudioElement({
			sourceElement: two,
			crossfade: crossfades.get(two.id),
		});
		expect(outgoing).toMatchObject({
			startTime: s(0),
			duration: s(6),
			trimEnd: s(9),
		});
		expect(outgoing.params).toMatchObject({ fadeOut: 1, fadeOutLevel: -60 });
		expect(incoming).toMatchObject({ startTime: s(5), duration: s(5) });
		expect(incoming.params).toMatchObject({ fadeIn: 1, fadeInLevel: -60 });
	});
});
