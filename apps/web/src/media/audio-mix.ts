import {
	ALL_FORMATS,
	AudioBufferSink,
	Input,
	type WrappedAudioBuffer,
} from "mediabunny";
import type { RetimeConfig, SceneTracks } from "@/timeline";
import type { MediaAsset } from "@/media/types";
import { createMediaSource, type MediaFile } from "@/media/disk-file";
import { mediaSupportsAudio } from "@/media/media-utils";
import { masterAudioStretch } from "@/media/audio-mastering";
import {
	collectAudibleCandidates,
	getAudioTiming,
	mixAudioChannels,
	type MixedAudioClip,
} from "@/media/audio";
import {
	getElementVolume,
	hasAnimatedVolume,
	isElementMuted,
	resolveEffectiveAudioGain,
} from "@/timeline/audio-state";
import { shouldMaintainPitch } from "@/retime/rate";
import { getSourceTimeAtClipTime, renderRetimedBuffer } from "@/retime";
import { getAudioCrossfades } from "@/transitions";
import { TICKS_PER_SECOND } from "@/wasm";

export const EXPORT_SAMPLE_RATE = 44100;
/** The mix is stereo. */
export const MIX_CHANNELS = 2;

// How much of the timeline is mixed at a time.
const WINDOW_SECONDS = 10;
// The mix before each window, which the limiter hears first: windows join up
// as if mastered whole, well past its release.
const LIMITER_PREROLL_SECONDS = 1;
// Decoded either side of what a window needs, for the resampler.
const SOURCE_MARGIN_SECONDS = 0.05;
// Decoding starts this far before a clip's first sample: a codec's first frame
// comes out incomplete.
const DECODER_WARMUP_SECONDS = 0.1;

/** A clip whose sound is in the mix, and where it falls in samples. */
interface MixClip extends MixedAudioClip {
	asset: MediaAsset | null;
	firstSample: number;
	endSample: number;
}

/** Part of a clip's source, at the mix's rate, and where in the source it starts. */
interface SoundPiece {
	buffer: AudioBuffer;
	start: number;
}

/** A clip's source sound, read as the windows reach it. */
interface ClipSound {
	/** From `start` to `end` seconds of the source, and a little either side. */
	read({
		start,
		end,
	}: {
		start: number;
		end: number;
	}): Promise<SoundPiece | null>;
	dispose(): void;
}

/** A clip's sound once opened, and how the mix reads it. */
interface OpenClip {
	sound: ClipSound;
	trimStart: number;
	retime?: RetimeConfig;
}

/**
 * A sound in memory whole: library audio, a file only the web view decodes,
 * a stretched clip.
 */
class WholeSound implements ClipSound {
	private readonly buffer: AudioBuffer;

	constructor({ buffer }: { buffer: AudioBuffer }) {
		this.buffer = buffer;
	}

	async read(): Promise<SoundPiece> {
		return { buffer: this.buffer, start: 0 };
	}

	dispose() {}
}

/** A file's sound, decoded as the windows reach it and forgotten behind them. */
class StreamedSound implements ClipSound {
	private readonly input: Input;
	private readonly iterator: AsyncGenerator<WrappedAudioBuffer, void, unknown>;
	private readonly sampleRate: number;
	private decoded: WrappedAudioBuffer[] = [];
	private isAtEnd = false;

	constructor({
		input,
		sink,
		from,
		sampleRate,
	}: {
		input: Input;
		sink: AudioBufferSink;
		from: number;
		sampleRate: number;
	}) {
		this.input = input;
		this.iterator = sink.buffers(from);
		this.sampleRate = sampleRate;
	}

	async read({
		start,
		end,
	}: {
		start: number;
		end: number;
	}): Promise<SoundPiece | null> {
		const from = start - SOURCE_MARGIN_SECONDS;
		const to = end + SOURCE_MARGIN_SECONDS;
		while (!this.isAtEnd && this.getDecodedEnd() < to) {
			const next = await this.iterator.next();
			if (next.done) this.isAtEnd = true;
			else this.decoded.push(next.value);
		}
		this.decoded = this.decoded.filter(
			({ timestamp, duration }) => timestamp + duration > from,
		);
		return joinBuffers({
			buffers: this.decoded.filter(({ timestamp }) => timestamp < to),
			sampleRate: this.sampleRate,
		});
	}

	private getDecodedEnd() {
		const last = this.decoded.at(-1);
		return last ? last.timestamp + last.duration : -Infinity;
	}

	dispose() {
		void this.iterator.return(undefined);
		this.input.dispose();
	}
}

/** Decoded buffers as one, placed by their timestamps, at the mix's rate. */
async function joinBuffers({
	buffers,
	sampleRate,
}: {
	buffers: WrappedAudioBuffer[];
	sampleRate: number;
}): Promise<SoundPiece | null> {
	const first = buffers[0];
	const last = buffers.at(-1);
	if (!first || !last) return null;

	const nativeRate = first.buffer.sampleRate;
	const numberOfChannels = Math.min(
		MIX_CHANNELS,
		first.buffer.numberOfChannels,
	);
	const start = first.timestamp;
	const joined = new AudioBuffer({
		numberOfChannels,
		length:
			Math.round((last.timestamp - start) * nativeRate) + last.buffer.length,
		sampleRate: nativeRate,
	});
	for (const { buffer, timestamp } of buffers) {
		const offset = Math.round((timestamp - start) * nativeRate);
		for (let channel = 0; channel < numberOfChannels; channel++) {
			const data = buffer.getChannelData(
				Math.min(channel, buffer.numberOfChannels - 1),
			);
			joined.copyToChannel(data, channel, offset);
		}
	}
	if (nativeRate === sampleRate) return { buffer: joined, start };
	return { buffer: await resample({ buffer: joined, sampleRate }), start };
}

/** Through the web view's resampler, as the whole-file mix was. */
function resample({
	buffer,
	sampleRate,
}: {
	buffer: AudioBuffer;
	sampleRate: number;
}): Promise<AudioBuffer> {
	const context = new OfflineAudioContext({
		numberOfChannels: buffer.numberOfChannels,
		length: Math.max(1, Math.ceil(buffer.duration * sampleRate)),
		sampleRate,
	});
	const source = context.createBufferSource();
	source.buffer = buffer;
	source.connect(context.destination);
	source.start(0);
	return context.startRendering();
}

async function openStreamedSound({
	file,
	from,
	sampleRate,
}: {
	file: MediaFile;
	from: number;
	sampleRate: number;
}): Promise<ClipSound | null> {
	const input = new Input({
		source: createMediaSource({ file }),
		formats: ALL_FORMATS,
	});
	let sound: ClipSound | null = null;
	try {
		const track = await input.getPrimaryAudioTrack();
		if (track && (await track.canDecode())) {
			sound = new StreamedSound({
				input,
				sink: new AudioBufferSink(track),
				from,
				sampleRate,
			});
		}
		return sound;
	} finally {
		if (!sound) input.dispose();
	}
}

async function openAssetSound({
	asset,
	from,
	sampleRate,
	context,
}: {
	asset: MediaAsset;
	from: number;
	sampleRate: number;
	context: BaseAudioContext;
}): Promise<ClipSound | null> {
	const isAudioFile = asset.type === "audio";
	const streamed = await openStreamedSound({
		file: asset.file,
		from,
		sampleRate,
	}).catch((error: unknown) => {
		if (!isAudioFile) throw error;
		return null;
	});
	if (streamed || !isAudioFile) return streamed;
	// Not a codec WebCodecs decodes here: the web view's own decoder, which
	// takes the file whole, as audio files are small.
	const buffer = await context.decodeAudioData(await asset.file.arrayBuffer());
	return new WholeSound({ buffer });
}

async function openClipSound({
	clip,
	sampleRate,
	context,
}: {
	clip: MixClip;
	sampleRate: number;
	context: BaseAudioContext;
}): Promise<ClipSound | null> {
	const element = clip.timelineElement;
	if (element.type === "audio" && element.sourceType === "library") {
		if (element.buffer) return new WholeSound({ buffer: element.buffer });
		const response = await fetch(element.sourceUrl);
		if (!response.ok) {
			throw new Error(`Library audio fetch failed: ${response.status}`);
		}
		const buffer = await context.decodeAudioData(await response.arrayBuffer());
		return new WholeSound({ buffer });
	}
	if (!clip.asset) return null;
	return openAssetSound({
		asset: clip.asset,
		from: Math.max(0, clip.trimStart - DECODER_WARMUP_SECONDS),
		sampleRate,
		context,
	});
}

async function openClip({
	clip,
	sampleRate,
	context,
}: {
	clip: MixClip;
	sampleRate: number;
	context: BaseAudioContext;
}): Promise<OpenClip | null> {
	try {
		const sound = await openClipSound({ clip, sampleRate, context });
		if (!sound) return null;
		const { retime, trimStart, duration } = clip;
		if (
			!shouldMaintainPitch({
				rate: retime?.rate ?? 1,
				maintainPitch: retime?.maintainPitch,
			})
		) {
			return { sound, trimStart, retime };
		}

		// Its pitch kept: the stretcher takes the clip whole, at its first window.
		let piece: SoundPiece | null;
		try {
			piece = await sound.read({
				start: trimStart,
				end:
					trimStart + getSourceTimeAtClipTime({ clipTime: duration, retime }),
			});
		} finally {
			sound.dispose();
		}
		if (!piece) return null;
		const buffer = await renderRetimedBuffer({
			audioContext: context,
			sourceBuffer: piece.buffer,
			trimStart: Math.max(0, trimStart - piece.start),
			clipDuration: duration,
			retime,
			maintainPitch: true,
		});
		return { sound: new WholeSound({ buffer }), trimStart: 0 };
	} catch (error) {
		console.warn("Failed to decode clip audio:", error);
		return null;
	}
}

/** The clips heard in the mix, in the order they start. */
function collectMixClips({
	tracks,
	mediaAssets,
	sampleRate,
}: {
	tracks: SceneTracks;
	mediaAssets: MediaAsset[];
	sampleRate: number;
}): MixClip[] {
	const crossfades = getAudioCrossfades({ tracks });
	const clips: MixClip[] = [];
	for (const { element, mediaAsset } of collectAudibleCandidates({
		tracks,
		mediaAssets,
	})) {
		if (isElementMuted({ element })) continue;
		const isLibrary =
			element.type === "audio" && element.sourceType === "library";
		if (!isLibrary && !mediaAsset) continue;
		if (
			element.type === "video" &&
			!(mediaAsset && mediaSupportsAudio({ media: mediaAsset }))
		) {
			continue;
		}

		const crossfade =
			element.type === "video" ? crossfades.get(element.id) : undefined;
		const timing = getAudioTiming({ element, crossfade });
		const firstSample = Math.floor(timing.startTime * sampleRate);
		clips.push({
			timelineElement: element,
			asset: isLibrary ? null : mediaAsset,
			...timing,
			volume: resolveEffectiveAudioGain({
				element,
				trackMuted: false,
				localTime: 0,
			}),
			retime: element.retime,
			crossfade,
			firstSample,
			endSample: firstSample + Math.ceil(timing.duration * sampleRate),
		});
	}
	return clips.sort((a, b) => a.firstSample - b.firstSample);
}

/** The clip whose sound is the whole soundtrack, as it is in its file. */
export interface PassthroughClip {
	asset: MediaAsset;
	/** Where the timeline stops hearing it, in seconds. */
	end: number;
}

// How far from the start, in seconds, still counts as at the start.
const START_TOLERANCE = 1e-6;

/**
 * The one clip heard on the timeline, if it plays its file's sound unchanged
 * from the start (it may stop early): no other sound, no speed change, no
 * crossfade, its volume at 0 dB and not keyframed. Export copies its sound.
 */
export function findPassthroughClip({
	tracks,
	mediaAssets,
	duration,
}: {
	tracks: SceneTracks;
	mediaAssets: MediaAsset[];
	/** The timeline's, in ticks. */
	duration: number;
}): PassthroughClip | null {
	const clips = collectMixClips({
		tracks,
		mediaAssets,
		sampleRate: EXPORT_SAMPLE_RATE,
	});
	if (clips.length !== 1) return null;
	const [clip] = clips;
	const element = clip.timelineElement;
	const isUnchanged =
		clip.startTime < START_TOLERANCE &&
		clip.trimStart < START_TOLERANCE &&
		(!clip.retime || clip.retime.rate === 1) &&
		!clip.crossfade &&
		getElementVolume({ element }) === 0 &&
		!hasAnimatedVolume({ element });
	if (!clip.asset || !isUnchanged) return null;
	return {
		asset: clip.asset,
		end: Math.min(clip.startTime + clip.duration, duration / TICKS_PER_SECOND),
	};
}

/**
 * The timeline's sound, mixed and mastered a window at a time: each source is
 * decoded only as far as the mix has got, so a film's soundtrack is never in
 * memory whole (docs/NATIVE.md, phase 2). Null if nothing on it is heard.
 */
export function mixTimelineAudio({
	tracks,
	mediaAssets,
	duration,
	sampleRate = EXPORT_SAMPLE_RATE,
}: {
	tracks: SceneTracks;
	mediaAssets: MediaAsset[];
	duration: number;
	sampleRate?: number;
}): AsyncGenerator<AudioBuffer, void, undefined> | null {
	const clips = collectMixClips({ tracks, mediaAssets, sampleRate });
	if (clips.length === 0) return null;
	return mixWindows({
		clips,
		length: Math.ceil((duration / TICKS_PER_SECOND) * sampleRate),
		sampleRate,
	});
}

async function* mixWindows({
	clips,
	length,
	sampleRate,
}: {
	clips: MixClip[];
	length: number;
	sampleRate: number;
}): AsyncGenerator<AudioBuffer, void, undefined> {
	// For decoding and stretching: it needs no audio device.
	const context = new OfflineAudioContext({
		numberOfChannels: MIX_CHANNELS,
		length: 1,
		sampleRate,
	});
	const windowLength = WINDOW_SECONDS * sampleRate;
	const prerollLength = Math.round(LIMITER_PREROLL_SECONDS * sampleRate);
	// Each clip's sound from its first window; null once it's done with.
	const opened = new Map<MixClip, Promise<OpenClip | null> | null>();
	const close = async ({ clip }: { clip: MixClip }) => {
		const opening = opened.get(clip);
		opened.set(clip, null);
		(await opening)?.sound.dispose();
	};
	let preroll = Array.from(
		{ length: MIX_CHANNELS },
		() => new Float32Array(prerollLength),
	);

	try {
		for (let first = 0; first < length; first += windowLength) {
			const end = Math.min(length, first + windowLength);
			const mix = new AudioBuffer({
				numberOfChannels: MIX_CHANNELS,
				length: end - first,
				sampleRate,
			});

			const heard: MixClip[] = [];
			for (const clip of clips) {
				if (clip.firstSample >= end) break;
				if (clip.endSample <= first) {
					if (opened.get(clip)) await close({ clip });
					continue;
				}
				if (!opened.has(clip)) {
					opened.set(clip, openClip({ clip, sampleRate, context }));
				}
				heard.push(clip);
			}

			const pieces = await Promise.all(
				heard.map(async (clip) => {
					const open = await opened.get(clip);
					if (!open) return null;
					const { sound, trimStart, retime } = open;
					const sourceTime = ({ sample }: { sample: number }) =>
						trimStart +
						getSourceTimeAtClipTime({
							clipTime: (sample - clip.firstSample) / sampleRate,
							retime,
						});
					try {
						const piece = await sound.read({
							start: sourceTime({ sample: Math.max(first, clip.firstSample) }),
							end: sourceTime({ sample: Math.min(end, clip.endSample) }),
						});
						return piece && { clip, open, piece };
					} catch (error) {
						console.warn("Failed to decode clip audio:", error);
						await close({ clip });
						return null;
					}
				}),
			);
			for (const heardPiece of pieces) {
				if (!heardPiece) continue;
				const { clip, open, piece } = heardPiece;
				mixAudioChannels({
					element: clip,
					buffer: piece.buffer,
					trimStart: open.trimStart,
					retime: open.retime,
					sourceStart: piece.start,
					outputBuffer: mix,
					outputStart: first,
					outputLength: mix.length,
					sampleRate,
				});
			}

			const heardByLimiter = new AudioBuffer({
				numberOfChannels: MIX_CHANNELS,
				length: prerollLength + mix.length,
				sampleRate,
			});
			for (let channel = 0; channel < MIX_CHANNELS; channel++) {
				const data = mix.getChannelData(channel);
				heardByLimiter.copyToChannel(preroll[channel], channel);
				heardByLimiter.copyToChannel(data, channel, prerollLength);
			}
			preroll = preroll.map((_, channel) =>
				heardByLimiter
					.getChannelData(channel)
					.slice(heardByLimiter.length - prerollLength),
			);
			yield await masterAudioStretch({
				audioBuffer: heardByLimiter,
				prerollLength,
			});
		}
	} finally {
		await Promise.all([...opened.keys()].map((clip) => close({ clip })));
	}
}

/**
 * The whole mix in one buffer, for what needs it at once (transcription, at a
 * low rate); null if nothing on the timeline is heard.
 */
export async function createTimelineAudioBuffer({
	tracks,
	mediaAssets,
	duration,
	sampleRate = EXPORT_SAMPLE_RATE,
}: {
	tracks: SceneTracks;
	mediaAssets: MediaAsset[];
	duration: number;
	sampleRate?: number;
}): Promise<AudioBuffer | null> {
	const windows = mixTimelineAudio({
		tracks,
		mediaAssets,
		duration,
		sampleRate,
	});
	if (!windows) return null;

	const output = new AudioBuffer({
		numberOfChannels: MIX_CHANNELS,
		length: Math.max(1, Math.ceil((duration / TICKS_PER_SECOND) * sampleRate)),
		sampleRate,
	});
	let offset = 0;
	for await (const window of windows) {
		for (let channel = 0; channel < MIX_CHANNELS; channel++) {
			output.copyToChannel(window.getChannelData(channel), channel, offset);
		}
		offset += window.length;
	}
	return output;
}
