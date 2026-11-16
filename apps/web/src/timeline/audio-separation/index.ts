import { cloneAnimations } from "@/animation";
import { isLeafChannelData } from "@/animation/channel-data";
import { isScalarChannel } from "@/animation/interpolation";
import type { ElementAnimations } from "@/animation/types";
import { AUDIO_EFFECT_PARAMS } from "@/media/audio-effects";
import type { MediaAsset } from "@/media/types";
import type { ParamValues } from "@/params";
import { clampRetimeRate } from "@/retime/rate";
import { DEFAULTS } from "@/timeline/defaults";
import { FADE_PARAMS, FADE_SILENCE_DB } from "@/timeline/audio-fades";
import type { AudioCrossfade } from "@/transitions";
import { mediaTime, roundMediaTime, TICKS_PER_SECOND } from "@/wasm";
import type {
	CreateUploadAudioElement,
	TimelineElement,
	AudioElement,
	VideoElement,
} from "../types";

type MediaAudioState = Pick<MediaAsset, "hasAudio">;

export function isSourceAudioEnabled({
	element,
}: {
	element: VideoElement;
}): boolean {
	return element.isSourceAudioEnabled !== false;
}

export function isSourceAudioSeparated({
	element,
}: {
	element: VideoElement;
}): boolean {
	return !isSourceAudioEnabled({ element });
}

export function canExtractSourceAudio(
	element: TimelineElement,
	mediaAsset: MediaAudioState | null | undefined,
): element is VideoElement {
	return (
		element.type === "video" &&
		isSourceAudioEnabled({ element }) &&
		!!mediaAsset &&
		mediaAsset.hasAudio !== false
	);
}

export function canRecoverSourceAudio(
	element: TimelineElement,
): element is VideoElement {
	return element.type === "video" && isSourceAudioSeparated({ element });
}

export function canToggleSourceAudio(
	element: TimelineElement,
	mediaAsset: MediaAudioState | null | undefined,
): element is VideoElement {
	return (
		canRecoverSourceAudio(element) || canExtractSourceAudio(element, mediaAsset)
	);
}

export function doesElementHaveEnabledAudio({
	element,
	mediaAsset,
}: {
	element: AudioElement | VideoElement;
	mediaAsset?: MediaAudioState | null;
}): boolean {
	if (element.type === "audio") {
		return true;
	}

	return (
		!!mediaAsset &&
		mediaAsset.hasAudio !== false &&
		isSourceAudioEnabled({ element })
	);
}

/**
 * A video clip's sound as an audio clip: its volume, fades and effects with
 * it. Where a transition crossfades it (`crossfade`), it reaches into the
 * clip's handle and fades across the window, so it sounds as it did.
 */
export function buildSeparatedAudioElement({
	sourceElement,
	crossfade,
}: {
	sourceElement: VideoElement;
	crossfade?: AudioCrossfade;
}): CreateUploadAudioElement {
	const params: ParamValues = {
		volume:
			typeof sourceElement.params.volume === "number"
				? sourceElement.params.volume
				: DEFAULTS.element.volume,
		muted: sourceElement.params.muted === true,
	};
	for (const { key } of [...FADE_PARAMS, ...AUDIO_EFFECT_PARAMS]) {
		const value = sourceElement.params[key];
		if (value !== undefined) params[key] = value;
	}
	const ticks = (seconds: number) =>
		roundMediaTime({ time: seconds * TICKS_PER_SECOND });
	const head = ticks(crossfade?.head ?? 0);
	const tail = ticks(crossfade?.tail ?? 0);
	if (crossfade?.fadeIn) {
		params.fadeIn = crossfade.fadeIn.end - crossfade.fadeIn.start;
		params.fadeInLevel = FADE_SILENCE_DB;
	}
	if (crossfade?.fadeOut) {
		params.fadeOut = crossfade.fadeOut.end - crossfade.fadeOut.start;
		params.fadeOutLevel = FADE_SILENCE_DB;
	}
	// The media under a stretch of the timeline.
	const rate = clampRetimeRate({ rate: sourceElement.retime?.rate ?? 1 });
	const media = (time: number) => roundMediaTime({ time: time * rate });

	return {
		type: "audio",
		sourceType: "upload",
		mediaId: sourceElement.mediaId,
		name: sourceElement.name,
		duration: mediaTime({ ticks: sourceElement.duration + head + tail }),
		startTime: mediaTime({ ticks: sourceElement.startTime - head }),
		trimStart: mediaTime({
			ticks: Math.max(0, sourceElement.trimStart - media(head)),
		}),
		trimEnd: mediaTime({
			ticks: Math.max(0, sourceElement.trimEnd - media(tail)),
		}),
		sourceDuration: sourceElement.sourceDuration,
		params,
		retime: sourceElement.retime
			? {
					rate: sourceElement.retime.rate,
					maintainPitch: sourceElement.retime.maintainPitch,
				}
			: undefined,
		animations: delayVolumeKeyframes({
			animations: cloneVolumeAnimations({
				animations: sourceElement.animations,
			}),
			by: head,
		}),
	};
}

export function getSourceAudioActionLabel({
	element,
}: {
	element: VideoElement;
}): "Extract audio" | "Recover audio" {
	return isSourceAudioSeparated({ element })
		? "Recover audio"
		: "Extract audio";
}

/** Keyframes for a clip that starts `by` earlier: as much later in it. */
function delayVolumeKeyframes({
	animations,
	by,
}: {
	animations: ElementAnimations | undefined;
	by: number;
}): ElementAnimations | undefined {
	const volume = animations?.volume;
	if (
		!animations ||
		by <= 0 ||
		!isLeafChannelData(volume) ||
		!isScalarChannel(volume)
	) {
		return animations;
	}
	return {
		...animations,
		volume: {
			...volume,
			keys: volume.keys.map((key) => ({
				...key,
				time: mediaTime({ ticks: key.time + by }),
			})),
		},
	};
}

function cloneVolumeAnimations({
	animations,
}: {
	animations: ElementAnimations | undefined;
}): ElementAnimations | undefined {
	const volumeData = animations?.volume;
	if (!volumeData) {
		return undefined;
	}

	return cloneAnimations({
		animations: { volume: volumeData },
		shouldRegenerateKeyframeIds: true,
	});
}
