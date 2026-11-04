import type { ElementParamDefinition } from "@/params/registry";
import type { AudioCrossfade } from "@/transitions";
import { TICKS_PER_SECOND } from "@/wasm";
import { VOLUME_DB_MIN } from "./audio-constants";
import type { AudioCapableElement } from "./audio-state";

/*
 * A clip's own fades: its sound rising from a level (silence unless said)
 * over its first seconds, and falling to one over its last. The fades'
 * points on the clip, or the Audio tab's bars, set them; the preview and the
 * export apply them alike, with the clip's volume (docs/FADES.md). At an end
 * where a transition crossfades the sound, the crossfade does the job.
 */

/** The level a fade starts from or ends at that means silence. */
export const FADE_SILENCE_DB = VOLUME_DB_MIN;
export const FADE_MAX_SECONDS = 60;

function length({
	key,
	label,
}: {
	key: string;
	label: string;
}): ElementParamDefinition {
	return {
		key,
		label,
		type: "number",
		default: 0,
		min: 0,
		max: FADE_MAX_SECONDS,
		step: 0.01,
		keyframable: false,
	};
}

function level({
	key,
	label,
}: {
	key: string;
	label: string;
}): ElementParamDefinition {
	return {
		key,
		label,
		type: "number",
		default: FADE_SILENCE_DB,
		min: FADE_SILENCE_DB,
		max: 0,
		step: 0.5,
		keyframable: false,
	};
}

export const FADE_PARAMS: ElementParamDefinition[] = [
	length({ key: "fadeIn", label: "Fade in" }),
	level({ key: "fadeInLevel", label: "From" }),
	length({ key: "fadeOut", label: "Fade out" }),
	level({ key: "fadeOutLevel", label: "To" }),
];

/** A clip's fades, in seconds of the clip. */
export interface ClipFades {
	in: number;
	out: number;
	/** The gain, as a factor, the fade in starts from and the fade out ends at: 0 is silence. */
	inFloor: number;
	outFloor: number;
	/** The clip's length. */
	duration: number;
}

function readNumber({
	element,
	key,
	fallback,
}: {
	element: AudioCapableElement;
	key: string;
	fallback: number;
}): number {
	const value = element.params[key];
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** The gain a fade's level in dB stands for, as a factor. */
export function getFadeFloor({ db }: { db: number }): number {
	return db <= FADE_SILENCE_DB ? 0 : 10 ** (Math.min(0, db) / 20);
}

/**
 * A clip's fades, null if it has none: none at an end its crossfade covers.
 * Two that would overlap on a clip trimmed short are shortened alike, to meet.
 */
export function readClipFades({
	element,
	crossfade,
}: {
	element: AudioCapableElement;
	crossfade?: AudioCrossfade;
}): ClipFades | null {
	const duration = element.duration / TICKS_PER_SECOND;
	let fadeIn = crossfade?.fadeIn
		? 0
		: Math.max(0, readNumber({ element, key: "fadeIn", fallback: 0 }));
	let fadeOut = crossfade?.fadeOut
		? 0
		: Math.max(0, readNumber({ element, key: "fadeOut", fallback: 0 }));
	if (fadeIn <= 0 && fadeOut <= 0) return null;
	if (fadeIn + fadeOut > duration) {
		const scale = duration / (fadeIn + fadeOut);
		fadeIn *= scale;
		fadeOut *= scale;
	}
	return {
		in: fadeIn,
		out: fadeOut,
		inFloor: getFadeFloor({
			db: readNumber({
				element,
				key: "fadeInLevel",
				fallback: FADE_SILENCE_DB,
			}),
		}),
		outFloor: getFadeFloor({
			db: readNumber({
				element,
				key: "fadeOutLevel",
				fallback: FADE_SILENCE_DB,
			}),
		}),
		duration,
	};
}

/**
 * How far through its rise a fade is, 0 to 1, at a point 0 to 1 through it:
 * equal power, as the crossfades (transitions/audio.ts).
 */
export function getFadeShape({ progress }: { progress: number }): number {
	return Math.sin((Math.min(1, Math.max(0, progress)) * Math.PI) / 2);
}

/** A clip's fades' gain, as a factor, at a time in seconds from its start. */
export function getFadeGain({
	fades,
	clipTime,
}: {
	fades: ClipFades | null;
	clipTime: number;
}): number {
	if (!fades) return 1;
	let gain = 1;
	if (fades.in > 0 && clipTime < fades.in) {
		const rise = getFadeShape({ progress: clipTime / fades.in });
		gain *= fades.inFloor + (1 - fades.inFloor) * rise;
	}
	if (fades.out > 0 && clipTime > fades.duration - fades.out) {
		const rise = getFadeShape({
			progress: (fades.duration - clipTime) / fades.out,
		});
		gain *= fades.outFloor + (1 - fades.outFloor) * rise;
	}
	return gain;
}

/** The times within a clip's fades, from `from` to `to`, to set its gain at, a step apart. */
export function getFadeTimes({
	fades,
	from,
	to,
	step,
}: {
	fades: ClipFades;
	from: number;
	to: number;
	step: number;
}): number[] {
	const times: number[] = [];
	const windows = [
		{ start: 0, end: fades.in },
		{ start: fades.duration - fades.out, end: fades.duration },
	].filter(({ start, end }) => end > start);
	for (const window of windows) {
		const start = Math.max(from, window.start);
		const end = Math.min(to, window.end);
		if (end < start) continue;
		for (let time = start; time < end; time += step) times.push(time);
		times.push(end);
	}
	return times;
}
