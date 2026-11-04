import { splitAnimationsAtTime } from "@/animation";
import { readAudioEffects } from "@/media/audio-effects";
import type { MediaAsset } from "@/media/types";
import type {
	AudioElement,
	AudioTrack,
	SceneTracks,
	VideoElement,
	VideoTrack,
} from "@/timeline";
import {
	buildTransformFromParams,
	readBlendModeFromParams,
	readOpacityFromParams,
} from "@/rendering";
import { getSourceSpanAtClipTime, getSourceTimeAtClipTime } from "@/retime";
import {
	getElementVolume,
	hasAnimatedVolume,
	isElementMuted,
} from "@/timeline/audio-state";
import { mediaTime, roundMediaTime, TICKS_PER_SECOND } from "@/wasm";

// Fast mode (docs/FAST.md): Export copies the main track's video clips out of
// their files, one after another, instead of drawing and encoding each frame.
// No re-encoding starts each clip at the key frame before its cut; Smart Cut
// re-encodes the few frames from the cut to the next key frame, so it starts
// where it's cut. What the editor adds on top isn't in the copy.

export const FAST_MODES = ["off", "copy", "smart"] as const;
export type FastMode = (typeof FAST_MODES)[number];

export const FAST_MODE_NAMES: Record<FastMode, string> = {
	off: "Off",
	copy: "No re-encoding",
	smart: "Smart Cut",
};

export const FAST_MODE_HINTS: Record<FastMode, string> = {
	off: "Every frame is drawn and encoded again, with everything the timeline has: the slowest, and the most work for the computer.",
	copy: "The clips are copied out of their files as they are: fast, light on the computer, and no quality lost. A clip can only start on a key frame, so each one starts at the key frame before its cut, up to a few seconds early.",
	smart:
		"Like No re-encoding, but the few frames from each cut to the next key frame are re-encoded, so every clip starts exactly where it's cut. Still fast and light; only those frames lose a little quality.",
};

/** A clip Fast mode copies: where it starts and ends in its file. */
export interface FastClip {
	element: VideoElement;
	asset: MediaAsset;
	/** In seconds of the file. */
	from: number;
	to: number;
}

const toSeconds = (ticks: number) => ticks / TICKS_PER_SECOND;

/** The main track's video clips, in order, as they're seen. */
export function collectFastClips({
	tracks,
	mediaAssets,
}: {
	tracks: SceneTracks;
	mediaAssets: MediaAsset[];
}): FastClip[] {
	if (tracks.main.hidden) return [];
	const assets = new Map(mediaAssets.map((asset) => [asset.id, asset]));
	const clips: FastClip[] = [];
	const elements = [...tracks.main.elements].sort(
		(a, b) => a.startTime - b.startTime,
	);
	for (const element of elements) {
		if (element.type !== "video" || element.hidden) continue;
		if (element.duration <= 0) continue;
		const asset = assets.get(element.mediaId);
		if (!asset || asset.type !== "video") continue;
		const from = toSeconds(element.trimStart);
		const span = getSourceTimeAtClipTime({
			clipTime: toSeconds(element.duration),
			retime: element.retime,
		});
		clips.push({ element, asset, from, to: from + span });
	}
	return clips;
}

// Closer than this counts as touching, in seconds.
const GAP_TOLERANCE = 1e-3;

function hasChangedPicture({ element }: { element: VideoElement }): boolean {
	const transform = buildTransformFromParams({ params: element.params });
	const pictureKeys = Object.keys(element.animations ?? {}).filter(
		(path) => path !== "volume",
	);
	return (
		transform.scaleX !== 1 ||
		transform.scaleY !== 1 ||
		transform.position.x !== 0 ||
		transform.position.y !== 0 ||
		transform.rotate !== 0 ||
		readOpacityFromParams({ params: element.params }) !== 1 ||
		readBlendModeFromParams({ params: element.params }) !== "normal" ||
		pictureKeys.length > 0
	);
}

/**
 * What the timeline has that Fast mode leaves out, in a few words each, for
 * the export panel to say before it starts.
 */
export function listFastLosses({ tracks }: { tracks: SceneTracks }): string[] {
	const losses = new Set<string>();
	const main = tracks.main;
	if (main.transitions && main.transitions.length > 0)
		losses.add("transitions");
	let end = 0;
	const elements = [...main.elements].sort((a, b) => a.startTime - b.startTime);
	for (const element of elements) {
		if (element.type === "image") {
			losses.add("pictures");
			continue;
		}
		if (element.hidden) continue;
		if (toSeconds(element.startTime - end) > GAP_TOLERANCE) {
			losses.add("gaps between clips (closed up)");
		}
		end = element.startTime + element.duration;
		if (
			(element.effects?.length ?? 0) > 0 ||
			(element.masks?.length ?? 0) > 0
		) {
			losses.add("effects and masks");
		}
		if (element.retime && element.retime.rate !== 1) {
			losses.add("speed changes");
		}
		if (hasChangedPicture({ element })) {
			losses.add("position, size and opacity changes");
		}
	}
	for (const track of tracks.overlay) {
		if (track.elements.length === 0) continue;
		if (track.type === "text") {
			losses.add(track.subtitles ? "subtitles" : "text");
		} else if (track.type === "graphic") {
			losses.add("stickers and graphics");
		} else if (track.type === "effect") {
			losses.add("effect layers");
		} else {
			losses.add("clips on other video tracks");
		}
	}
	return [...losses];
}

/** Whether a clip's sound plays as it is in its file: copied, it's the same. */
export function isSoundUnchanged({
	element,
	track,
}: {
	element: VideoElement;
	track: VideoTrack;
}): boolean {
	return (
		!track.muted &&
		!isElementMuted({ element }) &&
		getElementVolume({ element }) === 0 &&
		!hasAnimatedVolume({ element }) &&
		readAudioEffects({ params: element.params }) === null
	);
}

/** A clip as the export lays it out: from `start` to `end` of its file, at `outStart`. */
export interface PlacedClip {
	clip: FastClip;
	/** In seconds. */
	start: number;
	end: number;
	outStart: number;
}

/** Whether the audio tracks have anything to hear: then the sound is mixed, not copied. */
export function hasAudibleAudioTracks({
	tracks,
}: {
	tracks: SceneTracks;
}): boolean {
	return tracks.audio.some(
		(track) =>
			!track.muted &&
			track.elements.some(
				(element) => element.duration > 0 && !isElementMuted({ element }),
			),
	);
}

/**
 * The part of an audio clip heard between `from` and `to` of the timeline,
 * in ticks, as a clip of its own: its cuts and keyframes moved as a split
 * moves them. Null if none of it is.
 */
export function cutAudioElement({
	element,
	from,
	to,
}: {
	element: AudioElement;
	from: number;
	to: number;
}): AudioElement | null {
	const elementEnd = element.startTime + element.duration;
	const start = Math.max(from, element.startTime);
	const end = Math.min(to, elementEnd);
	if (end <= start) return null;
	const head = start - element.startTime;
	const kept = end - start;
	const sourceAt = (clipTime: number) =>
		roundMediaTime({
			time: getSourceSpanAtClipTime({ clipTime, retime: element.retime }),
		});
	const sourceHead = sourceAt(head);
	const sourceEnd = sourceAt(head + kept);
	const sourceTotal = sourceAt(element.duration);
	let animations = element.animations;
	if (head > 0) {
		animations = splitAnimationsAtTime({
			animations,
			splitTime: roundMediaTime({ time: head }),
		}).rightAnimations;
	}
	if (end < elementEnd) {
		animations = splitAnimationsAtTime({
			animations,
			splitTime: roundMediaTime({ time: kept }),
		}).leftAnimations;
	}
	return {
		...element,
		startTime: roundMediaTime({ time: start }),
		duration: roundMediaTime({ time: kept }),
		trimStart: roundMediaTime({ time: element.trimStart + sourceHead }),
		trimEnd: roundMediaTime({
			time: element.trimEnd + (sourceTotal - sourceEnd),
		}),
		animations,
	};
}

/**
 * The audio tracks as Fast mode's output hears them: under each clip, the
 * part of the timeline its frames come from, moved to where the clip is in
 * the output. Gaps closed up drop what was heard in them; a clip started at
 * the key frame before its cut hears the timeline from as far before it.
 */
export function placeAudioTracks({
	tracks,
	placed,
}: {
	tracks: SceneTracks;
	placed: PlacedClip[];
}): AudioTrack[] {
	const ticks = (seconds: number) => seconds * TICKS_PER_SECOND;
	return tracks.audio
		.filter((track) => !track.muted)
		.map((track) => ({
			...track,
			elements: placed.flatMap(({ clip, start, end, outStart }, index) => {
				const rate = clip.element.retime?.rate ?? 1;
				// Where the piece's first frame is on the timeline.
				const timelineStart =
					clip.element.startTime + ticks((start - clip.from) / rate);
				const length = ticks(end - start);
				const shift = ticks(outStart) - timelineStart;
				return track.elements.flatMap((element) => {
					const part = cutAudioElement({
						element,
						from: timelineStart,
						to: timelineStart + length,
					});
					if (!part) return [];
					return [
						{
							...part,
							id: `${element.id}:${index}`,
							startTime: roundMediaTime({ time: part.startTime + shift }),
						},
					];
				});
			}),
		}))
		.filter((track) => track.elements.length > 0);
}

/**
 * A timeline of the clips as Fast mode lays them out, for the mix when the
 * sound isn't copied: their own sound with their volumes, and the audio
 * tracks under them (placeAudioTracks).
 */
export function buildFastSoundTracks({
	tracks,
	placed,
}: {
	tracks: SceneTracks;
	placed: PlacedClip[];
}): SceneTracks {
	const ticks = (seconds: number) =>
		mediaTime({ ticks: Math.round(seconds * TICKS_PER_SECOND) });
	return {
		overlay: [],
		audio: placeAudioTracks({ tracks, placed }),
		main: {
			...tracks.main,
			transitions: [],
			elements: placed.map(({ clip, start, end, outStart }) => ({
				...clip.element,
				startTime: ticks(outStart),
				trimStart: ticks(start),
				duration: ticks(end - start),
				// Its own sound only if it's still the clip's: one moved to an
				// audio track is heard there (placeAudioTracks).
				retime: undefined,
			})),
		},
	};
}
