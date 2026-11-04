import {
	ALL_FORMATS,
	BufferTarget,
	canEncodeAudio,
	canEncodeVideo,
	Conversion,
	Input,
	Output,
	QUALITY_HIGH,
	StreamTarget,
	type ConversionAudioOptions,
	type Quality,
} from "mediabunny";
import type { ExportFormat } from "@/export";
import { adoptSavedFile, openFolderFile } from "@/export/disk-target";
import { createOutputFormat } from "@/export/output-format";
import { createMediaSource, type MediaFile } from "@/media/disk-file";
import { checkEncoderColour } from "@/media/encoder-colour";
import { FILE_CHUNK_SIZE } from "@/services/renderer/scene-exporter";
import type { ConformFile, ConformSound, ConformTarget } from "./conform";

/*
 * A file converted into the track's target (docs/CONFORM.md), by mediabunny:
 * decoded, scaled into the target's size, turned upright, encoded again.
 */

export const CONFORM_FITS = ["contain", "cover", "fill"] as const;
export type ConformFit = (typeof CONFORM_FITS)[number];

export const CONFORM_FIT_NAMES: Record<ConformFit, string> = {
	contain: "Black bars",
	cover: "Fill, cropped",
	fill: "Stretched",
};

const MIME_TYPES: Record<ExportFormat, string> = {
	mp4: "video/mp4",
	mov: "video/quicktime",
	mkv: "video/x-matroska",
	webm: "video/webm",
};

/** Seconds kept on each side of the part used, so a clip can still be trimmed out a little. */
export const PART_MARGIN = 5;

export interface ConvertedPart {
	/** In the file's seconds. */
	start: number;
	end: number;
}

/** The part of a file converted when only the parts used are: null for the whole file. */
export function getConvertedPart({
	file,
}: {
	file: Pick<ConformFile, "usedFrom" | "usedTo" | "duration">;
}): ConvertedPart | null {
	const start = Math.max(0, file.usedFrom - PART_MARGIN);
	const end = Math.min(file.duration, file.usedTo + PART_MARGIN);
	// Nearly all of it: the whole file, which can be trimmed out freely.
	if (start <= 1 && end >= file.duration - 1) return null;
	return { start, end };
}

/** The container a converted file is written in: its codecs' usual one, or Matroska, which holds both. */
export function chooseConvertedFormat({
	target,
	sound,
}: {
	target: Pick<ConformTarget, "codec">;
	sound: Pick<ConformSound, "codec"> | null;
}): ExportFormat {
	const usual: ExportFormat = target.codec === "vp9" ? "webm" : "mp4";
	if (!sound) return usual;
	const audio = createOutputFormat({
		format: usual,
		isStreamed: true,
	}).getSupportedAudioCodecs();
	return audio.includes(sound.codec) ? usual : "mkv";
}

/** "talk.mov" as "talk (1920×1080).mp4", with the part's seconds if it's a part. */
export function nameConvertedFile({
	name,
	target,
	part,
	format,
}: {
	name: string;
	target: Pick<ConformTarget, "width" | "height">;
	part: ConvertedPart | null;
	format: ExportFormat;
}): string {
	const stem = name.replace(/\.[^.]*$/, "") || name;
	const seconds = part
		? `, ${Math.floor(part.start)}-${Math.ceil(part.end)} s`
		: "";
	return `${stem} (${target.width}×${target.height}${seconds}).${format}`;
}

/** The source's bitrate, scaled by the pixels: about the quality it had. */
async function chooseBitrate({
	input,
	target,
}: {
	input: Input;
	target: ConformTarget;
}): Promise<number | Quality> {
	const video = await input.getPrimaryVideoTrack();
	if (!video) return QUALITY_HIGH;
	const stats = await video.computePacketStats(300).catch(() => null);
	if (!stats || !(stats.averageBitrate > 0)) return QUALITY_HIGH;
	const scale =
		(target.width * target.height) /
		Math.max(1, video.displayWidth * video.displayHeight);
	return Math.round(
		Math.min(80e6, Math.max(1e6, stats.averageBitrate * scale)),
	);
}

/** Whether this computer can encode the target here. */
export function canConvertInto({
	target,
}: {
	target: ConformTarget;
}): Promise<boolean> {
	return canEncodeVideo(target.codec, {
		width: target.width,
		height: target.height,
	}).catch(() => false);
}

/**
 * The file's sound in the track's codec, rate and channels, so it can be
 * copied with the others'; as mediabunny chooses if this computer can't
 * encode that codec.
 */
async function chooseAudio({
	sound,
}: {
	sound: ConformSound | null;
}): Promise<ConversionAudioOptions | undefined> {
	if (!sound) return undefined;
	const canEncode = await canEncodeAudio(sound.codec, {
		sampleRate: sound.sampleRate,
		numberOfChannels: sound.channels,
	}).catch(() => false);
	if (!canEncode) return undefined;
	return {
		codec: sound.codec,
		sampleRate: sound.sampleRate,
		numberOfChannels: sound.channels,
	};
}

/**
 * Converts a file into the target: written to `folder` in the desktop app
 * and given to the editor, or kept in memory in a browser. Cancelled with
 * `signal`, leaving nothing behind.
 */
export async function convertFile({
	file,
	target,
	sound,
	fit,
	part,
	folder,
	signal,
	onProgress,
}: {
	file: ConformFile;
	target: ConformTarget;
	sound: ConformSound | null;
	fit: ConformFit;
	part: ConvertedPart | null;
	/** The desktop app's folder to write in; none in a browser. */
	folder: string | null;
	signal?: AbortSignal;
	onProgress?: (progress: number) => void;
}): Promise<MediaFile> {
	const format = chooseConvertedFormat({ target, sound });
	const name = nameConvertedFile({
		name: file.asset.name,
		target,
		part,
		format,
	});
	const input = new Input({
		source: createMediaSource({ file: file.asset.file }),
		formats: ALL_FORMATS,
	});
	const opened = folder ? await openFolderFile({ folder, name }) : null;
	// mediabunny closes its stream when it's done and when it's cancelled: the
	// file is kept only once the conversion has finished.
	const writer = opened?.file.writable.getWriter();
	const destination = writer
		? new StreamTarget(
				new WritableStream({
					write: (chunk) => writer.write(chunk),
				}),
				{ chunked: true, chunkSize: FILE_CHUNK_SIZE },
			)
		: new BufferTarget();
	try {
		// WebKit's H.264 says it's full range when it isn't (media/encoder-colour.ts).
		checkEncoderColour();
		const output = new Output({
			format: createOutputFormat({ format, isStreamed: !!writer }),
			target: destination,
		});
		const conversion = await Conversion.init({
			input,
			output,
			video: {
				codec: target.codec,
				width: target.width,
				height: target.height,
				fit,
				bitrate: await chooseBitrate({ input, target }),
				forceTranscode: true,
				allowRotationMetadata: false,
			},
			audio: await chooseAudio({ sound }),
			trim: part ? { start: part.start, end: part.end } : undefined,
			showWarnings: false,
		});
		if (!conversion.isValid) {
			const reasons = conversion.discardedTracks.map(({ reason }) => reason);
			throw new Error(
				`"${file.asset.name}" can't be converted here (${reasons.join(", ") || "no track to convert"}).`,
			);
		}
		const cancel = () => void conversion.cancel();
		signal?.addEventListener("abort", cancel, { once: true });
		conversion.onProgress = (progress) => onProgress?.(progress);
		try {
			await conversion.execute();
		} finally {
			signal?.removeEventListener("abort", cancel);
		}
		if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");

		if (writer && opened) {
			await writer.close();
			return await adoptSavedFile({ path: opened.path });
		}
		const buffer =
			destination instanceof BufferTarget ? destination.buffer : null;
		if (!buffer) throw new Error(`"${file.asset.name}" came out empty.`);
		return new File([buffer], name, {
			type: MIME_TYPES[format],
		});
	} catch (error) {
		writer?.releaseLock();
		await opened?.file.discard();
		throw error;
	} finally {
		input.dispose();
	}
}
