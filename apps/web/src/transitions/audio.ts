import type { SceneTracks, VideoTrack } from "@/timeline";
import { TICKS_PER_SECOND } from "@/wasm";
import { resolveTrackTransitions } from "./timing";

interface FadeWindow {
	start: number;
	end: number;
}

/**
 * A clip's audio around its transitions, in seconds on the timeline: it plays
 * into its handles for each window, fading in or out across it.
 */
export interface AudioCrossfade {
	/** How long it plays before it starts, from its head handle. */
	head: number;
	/** How long it plays after it ends, from its tail handle. */
	tail: number;
	fadeIn?: FadeWindow;
	fadeOut?: FadeWindow;
}

/** The crossfades of the clips that transitions with audio crossfade, by id. */
export function getAudioCrossfades({
	tracks,
}: {
	tracks: SceneTracks;
}): Map<string, AudioCrossfade> {
	const crossfades = new Map<string, AudioCrossfade>();
	const crossfadeOf = ({ id }: { id: string }): AudioCrossfade => {
		const existing = crossfades.get(id);
		if (existing) return existing;
		const crossfade: AudioCrossfade = { head: 0, tail: 0 };
		crossfades.set(id, crossfade);
		return crossfade;
	};

	const videoTracks = [tracks.main, ...tracks.overlay].filter(
		(track): track is VideoTrack => track.type === "video",
	);
	for (const track of videoTracks) {
		for (const resolved of resolveTrackTransitions({ track })) {
			const { transition, from, to } = resolved;
			if (!transition.crossfadeAudio) continue;
			const window = {
				start: resolved.window.start / TICKS_PER_SECOND,
				end: resolved.window.end / TICKS_PER_SECOND,
			};
			const cut = to.startTime / TICKS_PER_SECOND;
			if (from.type === "video") {
				const outgoing = crossfadeOf({ id: from.id });
				outgoing.tail = Math.max(0, window.end - cut);
				outgoing.fadeOut = window;
			}
			if (to.type === "video") {
				const incoming = crossfadeOf({ id: to.id });
				incoming.head = Math.max(0, cut - window.start);
				incoming.fadeIn = window;
			}
		}
	}
	return crossfades;
}

function progress({ window, time }: { window: FadeWindow; time: number }) {
	const length = window.end - window.start;
	if (length <= 0) return 1;
	return Math.min(1, Math.max(0, (time - window.start) / length));
}

/**
 * A clip's crossfade gain at a time on the timeline. Equal power: the two
 * clips' gains squared add up to one, so the loudness holds across the cut.
 */
export function getCrossfadeGain({
	crossfade,
	time,
}: {
	crossfade: AudioCrossfade | undefined;
	time: number;
}): number {
	if (!crossfade) return 1;
	let gain = 1;
	const { fadeIn, fadeOut } = crossfade;
	if (fadeIn && time < fadeIn.end) {
		gain *= Math.sin((progress({ window: fadeIn, time }) * Math.PI) / 2);
	}
	if (fadeOut && time > fadeOut.start) {
		gain *= Math.cos((progress({ window: fadeOut, time }) * Math.PI) / 2);
	}
	return gain;
}

/** The times within a clip's fades to set its gain at, a step apart. */
export function getCrossfadeTimes({
	crossfade,
	from,
	to,
	step,
}: {
	crossfade: AudioCrossfade;
	from: number;
	to: number;
	step: number;
}): number[] {
	const times: number[] = [];
	for (const window of [crossfade.fadeIn, crossfade.fadeOut]) {
		if (!window) continue;
		const start = Math.max(from, window.start);
		const end = Math.min(to, window.end);
		for (let time = start; time < end; time += step) times.push(time);
		if (end >= start) times.push(end);
	}
	return times;
}
