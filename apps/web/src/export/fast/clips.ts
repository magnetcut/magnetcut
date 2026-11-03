import type { MediaAsset } from "@/media/types";
import type { SceneTracks, VideoElement, VideoTrack } from "@/timeline";
import {
	buildTransformFromParams,
	readBlendModeFromParams,
	readOpacityFromParams,
} from "@/rendering";
import { getSourceTimeAtClipTime } from "@/retime";
import {
	getElementVolume,
	hasAnimatedVolume,
	isElementMuted,
} from "@/timeline/audio-state";
import { mediaTime, TICKS_PER_SECOND } from "@/wasm";

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
	if (tracks.audio.some((track) => track.elements.length > 0)) {
		losses.add("the audio tracks");
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
		!hasAnimatedVolume({ element })
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

/**
 * A timeline of the clips as Fast mode lays them out, its own sound only, for
 * the mix when the sound isn't copied: their volumes kept, nothing else.
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
		audio: [],
		main: {
			...tracks.main,
			transitions: [],
			elements: placed.map(({ clip, start, end, outStart }) => ({
				...clip.element,
				startTime: ticks(outStart),
				trimStart: ticks(start),
				duration: ticks(end - start),
				retime: undefined,
				// Its own sound, even where it was moved to an audio track.
				isSourceAudioEnabled: true,
			})),
		},
	};
}
