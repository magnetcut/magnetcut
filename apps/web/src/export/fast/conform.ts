import {
	ALL_FORMATS,
	Input,
	type AudioCodec,
	type VideoCodec,
} from "mediabunny";
import { createMediaSource } from "@/media/disk-file";
import type { MediaAsset } from "@/media/types";
import type { SceneTracks } from "@/timeline";
import { TICKS_PER_SECOND } from "@/wasm";
import { collectFastClips } from "./clips";

/*
 * Making the main track's clips match (docs/CONFORM.md): which files keep
 * Fast mode from joining them, and what they'd be converted into. The rules
 * are Fast mode's own (`findJoinProblem`, exporter.ts): one codec, one coded
 * size, the same way up, and outside H.264 the same decoder configuration.
 */

/** What joining looks at in a file's sound. */
export interface ConformSound {
	codec: AudioCodec;
	sampleRate: number;
	channels: number;
}

/** A file's video and sound, as joining sees them. */
export interface FileTraits {
	codec: VideoCodec | null;
	/** As shown, turned the way its rotation says. */
	width: number;
	height: number;
	codedWidth: number;
	codedHeight: number;
	rotation: number;
	/** The decoder configuration, which outside H.264 must be the same to join. */
	configKey: string;
	sound: ConformSound | null;
	/** Seconds. */
	duration: number;
}

/** A file on the main track: its traits, and how its clips use it. */
export interface ConformFile extends FileTraits {
	asset: MediaAsset;
	/** Seconds of the track its clips are seen for. */
	seconds: number;
	clipCount: number;
	/** The part of the file its clips use, in its seconds. */
	usedFrom: number;
	usedTo: number;
}

/** What the files are converted into: upright, as converting bakes the rotation in. */
export interface ConformTarget {
	codec: VideoCodec;
	width: number;
	height: number;
}

/** The codecs files can be converted into and still join: H.264's parameter sets are merged, VP9 has none. */
export const CONFORM_CODECS: readonly VideoCodec[] = ["avc", "vp9"];

export const CONFORM_CODEC_NAMES: Partial<Record<VideoCodec, string>> = {
	avc: "H.264",
	vp9: "VP9",
	hevc: "HEVC",
	av1: "AV1",
	vp8: "VP8",
};

const nameOf = (codec: VideoCodec | null) =>
	(codec && CONFORM_CODEC_NAMES[codec]) ?? codec ?? "an unknown codec";

const toHex = (bytes: Uint8Array) =>
	Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

function describeBytes({
	description,
}: {
	description: AllowSharedBufferSource | undefined;
}): string {
	if (!description) return "";
	const bytes = ArrayBuffer.isView(description)
		? new Uint8Array(
				description.buffer,
				description.byteOffset,
				description.byteLength,
			)
		: new Uint8Array(description);
	return toHex(bytes);
}

const traitsCache = new Map<string, Promise<FileTraits | null>>();

/** A file's traits, read once; null if it has no video. */
export function readFileTraits({
	asset,
}: {
	asset: MediaAsset;
}): Promise<FileTraits | null> {
	const cached = traitsCache.get(asset.id);
	if (cached) return cached;
	const read = (async () => {
		const input = new Input({
			source: createMediaSource({ file: asset.file }),
			formats: ALL_FORMATS,
		});
		try {
			const video = await input.getPrimaryVideoTrack();
			if (!video) return null;
			const config = await video.getDecoderConfig();
			const audio = await input.getPrimaryAudioTrack();
			return {
				codec: video.codec,
				width: video.displayWidth,
				height: video.displayHeight,
				codedWidth: video.codedWidth,
				codedHeight: video.codedHeight,
				rotation: video.rotation,
				configKey: describeBytes({ description: config?.description }),
				sound: audio?.codec
					? {
							codec: audio.codec,
							sampleRate: audio.sampleRate,
							channels: audio.numberOfChannels,
						}
					: null,
				duration: await input.computeDuration(),
			};
		} finally {
			input.dispose();
		}
	})().catch((error: unknown) => {
		traitsCache.delete(asset.id);
		throw error;
	});
	traitsCache.set(asset.id, read);
	return read;
}

/** The main track's files, each with how its clips use it, in the order first seen. */
export async function collectConformFiles({
	tracks,
	mediaAssets,
}: {
	tracks: SceneTracks;
	mediaAssets: MediaAsset[];
}): Promise<ConformFile[]> {
	const files = new Map<string, ConformFile>();
	for (const clip of collectFastClips({ tracks, mediaAssets })) {
		const seconds = clip.element.duration / TICKS_PER_SECOND;
		const existing = files.get(clip.asset.id);
		if (existing) {
			existing.seconds += seconds;
			existing.clipCount += 1;
			existing.usedFrom = Math.min(existing.usedFrom, clip.from);
			existing.usedTo = Math.max(existing.usedTo, clip.to);
			continue;
		}
		const traits = await readFileTraits({ asset: clip.asset });
		if (!traits) continue;
		files.set(clip.asset.id, {
			...traits,
			asset: clip.asset,
			seconds,
			clipCount: 1,
			usedFrom: clip.from,
			usedTo: clip.to,
		});
	}
	return [...files.values()];
}

export interface ConformSize {
	width: number;
	height: number;
	/** Seconds of the track in files of this size. */
	seconds: number;
}

/** The sizes on the track, as shown, the one most of it is in first. */
export function listConformSizes({
	files,
}: {
	files: ConformFile[];
}): ConformSize[] {
	const sizes = new Map<string, ConformSize>();
	for (const file of files) {
		const key = `${file.width}x${file.height}`;
		const size = sizes.get(key) ?? {
			width: file.width,
			height: file.height,
			seconds: 0,
		};
		size.seconds += file.seconds;
		sizes.set(key, size);
	}
	return [...sizes.values()].sort((a, b) => b.seconds - a.seconds);
}

/** The codecs to convert into, the one most of the track is in first: H.264 always among them. */
export function listConformCodecs({
	files,
}: {
	files: ConformFile[];
}): VideoCodec[] {
	const seconds = new Map<VideoCodec, number>(
		CONFORM_CODECS.map((codec) => [codec, 0]),
	);
	for (const file of files) {
		if (file.codec && seconds.has(file.codec)) {
			seconds.set(file.codec, (seconds.get(file.codec) ?? 0) + file.seconds);
		}
	}
	return [...seconds.entries()]
		.filter(([codec, time]) => codec === "avc" || time > 0)
		.sort((a, b) => b[1] - a[1] || (a[0] === "avc" ? -1 : 1))
		.map(([codec]) => codec);
}

/** The target the fewest frames are converted for: the size and the codec most of the track is in. */
export function chooseConformTarget({
	files,
}: {
	files: ConformFile[];
}): ConformTarget | null {
	const [size] = listConformSizes({ files });
	const [codec] = listConformCodecs({ files });
	if (!size || !codec) return null;
	return { codec, width: size.width, height: size.height };
}

/** The sound most of the track has, which converted files are given. */
export function chooseConformSound({
	files,
}: {
	files: ConformFile[];
}): ConformSound | null {
	const sounds = new Map<string, { sound: ConformSound; seconds: number }>();
	for (const { sound, seconds } of files) {
		if (!sound) continue;
		const key = `${sound.codec} ${sound.sampleRate} ${sound.channels}`;
		const entry = sounds.get(key) ?? { sound, seconds: 0 };
		entry.seconds += seconds;
		sounds.set(key, entry);
	}
	return (
		[...sounds.values()].sort((a, b) => b.seconds - a.seconds)[0]?.sound ?? null
	);
}

/** Whether a file joins the target as it is. */
function joinsTarget({
	file,
	target,
	reference,
}: {
	file: ConformFile;
	target: ConformTarget;
	reference: ConformFile | null;
}): boolean {
	return (
		file.codec === target.codec &&
		file.rotation === 0 &&
		file.codedWidth === target.width &&
		file.codedHeight === target.height &&
		(target.codec === "avc" ||
			!reference ||
			file.configKey === reference.configKey)
	);
}

/** How a file differs from the target, as the "!" and the dialog say. */
export function describeConformDifference({
	file,
	target,
}: {
	file: ConformFile;
	target: ConformTarget;
}): string {
	const own = `${file.width}×${file.height} ${nameOf(file.codec)}`;
	const wanted = `${target.width}×${target.height} ${nameOf(target.codec)}`;
	if (own !== wanted) return `${own}; the track is to be ${wanted}`;
	if (file.rotation !== 0)
		return `${own}, but turned by its rotation; converted files are upright`;
	return `${own}, but encoded differently from the others`;
}

export interface ConformPlan {
	target: ConformTarget;
	sound: ConformSound | null;
	/** The files to convert, each with how it differs. */
	files: { file: ConformFile; difference: string }[];
	/** Seconds of the track in them. */
	seconds: number;
}

/** The files that don't join the target, to be converted into it. */
export function planConform({
	files,
	target,
}: {
	files: ConformFile[];
	target: ConformTarget;
}): ConformPlan {
	const reference =
		files.find(
			(file) =>
				file.codec === target.codec &&
				file.rotation === 0 &&
				file.codedWidth === target.width &&
				file.codedHeight === target.height,
		) ?? null;
	const converted = files
		.filter((file) => !joinsTarget({ file, target, reference }))
		.map((file) => ({
			file,
			difference: describeConformDifference({ file, target }),
		}));
	return {
		target,
		sound: chooseConformSound({ files }),
		files: converted,
		seconds: converted.reduce((sum, { file }) => sum + file.seconds, 0),
	};
}
