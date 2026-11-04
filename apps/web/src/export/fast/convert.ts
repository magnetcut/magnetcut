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
	VideoSample,
	type ConversionAudioOptions,
	type ConversionVideoOptions,
	type Quality,
} from "mediabunny";
import type { ExportFormat } from "@/export";
import { adoptSavedFile, openFolderFile } from "@/export/disk-target";
import { createOutputFormat } from "@/export/output-format";
import { createMediaSource, type MediaFile } from "@/media/disk-file";
import { checkEncoderColour, readWrittenColour } from "@/media/encoder-colour";
import { canWriteColour, resolveVideoColour, rgbaToI420 } from "@/media/yuv";
import { FILE_CHUNK_SIZE } from "@/services/renderer/scene-exporter";
import type { ConformFile, ConformSound, ConformTarget } from "./conform";

/*
 * A file converted into the track's target (docs/CONFORM.md), by mediabunny:
 * decoded, scaled into the target's size, turned upright, encoded again, in
 * the colour space of the files it's joined to.
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

/** How pictures are given to the encoder: as I420 in the colour wanted, or as RGB. */
export type ColourInput = "yuv" | "rgb";

export interface ColourChoice {
	input: ColourInput;
	/**
	 * The colour space the I420 pictures are written in: what the frames are
	 * tagged with, and where they leave it unsaid, what the file will say of
	 * them (its SPS, else its colour box: WebKitGTK's says BT.601), else
	 * BT.709 (WebKit's and Chromium's say nothing), as both draw a film that
	 * says nothing.
	 */
	samples: VideoColorSpaceInit;
}

// Tried in turn: WebKit's encoder puts out nothing in Main and High (Smart
// Cut's `getEncoderCodecs`); level 5.1 holds up to 4096×2304.
const CHECK_CODECS = ["avc1.420033", "avc1.4d0033", "avc1.640033"];
const CHECK_SECONDS = 10;

/**
 * What a file of one frame encoded here would say of its colour, its SPS and
 * then its colour box (`readWrittenColour`); null if none came out.
 */
async function encodeOneFrame({
	frame,
	width,
	height,
}: {
	frame: VideoFrame;
	width: number;
	height: number;
}): Promise<VideoColorSpaceInit | null> {
	try {
		for (const codec of CHECK_CODECS) {
			const config: VideoEncoderConfig = {
				codec,
				width,
				height,
				bitrate: 1_000_000,
				avc: { format: "avc" },
			};
			const support = await VideoEncoder.isConfigSupported(config).catch(
				() => null,
			);
			if (!support?.supported) continue;
			const said: { config?: VideoDecoderConfig } = {};
			const encoder = new VideoEncoder({
				output: (_, metadata) => {
					said.config ??= metadata?.decoderConfig;
				},
				error: () => {},
			});
			try {
				encoder.configure(config);
				encoder.encode(frame, { keyFrame: true });
				await Promise.race([
					encoder.flush(),
					new Promise((resolve) => setTimeout(resolve, CHECK_SECONDS * 1000)),
				]);
			} catch {
				// This one didn't take it: the next.
			} finally {
				if (encoder.state !== "closed") encoder.close();
			}
			if (said.config) return readWrittenColour({ config: said.config });
		}
		return null;
	} finally {
		frame.close();
	}
}

const colourChoices = new Map<string, Promise<ColourChoice>>();

/**
 * How this web view's H.264 encoder writes pictures in `colour`, found by
 * encoding a grey frame, with the conversion's check of what it says
 * (`checkEncoderColour`), and reading what the file would say. I420 if it
 * keeps the range the frame is tagged with, else RGB if that comes out in it:
 * Chromium's writes RGB in full range and keeps I420's; WebKit's on macOS 27
 * keeps I420's, but on macOS 26 it marks limited I420 full range and writes
 * RGB in limited. And the matrix the file says the frames are in where they
 * don't say. I420 for VP9, whose stream isn't read here, in BT.709 where
 * `colour` says nothing.
 */
export function chooseColourInput({
	target,
	colour,
}: {
	target: ConformTarget;
	colour: VideoColorSpaceInit;
}): Promise<ColourChoice> {
	const { width, height } = target;
	const wanted = colour.fullRange ?? false;
	const key = [
		target.codec,
		width,
		height,
		colour.primaries,
		colour.transfer,
		colour.matrix,
		wanted,
	].join(" ");
	const known = colourChoices.get(key);
	if (known) return known;
	const usual = resolveVideoColour({ colour });
	const chosen = (async (): Promise<ColourChoice> => {
		if (target.codec !== "avc" || typeof VideoEncoder === "undefined") {
			return { input: "yuv", samples: usual };
		}
		checkEncoderColour();
		const rgba = new Uint8ClampedArray(width * height * 4).fill(128);
		const stream = await encodeOneFrame({
			frame: new VideoFrame(
				rgbaToI420({ rgba, width, height, colour: usual }),
				{
					format: "I420",
					codedWidth: width,
					codedHeight: height,
					timestamp: 0,
					colorSpace: colour,
				},
			),
			width,
			height,
		});
		const samples = {
			primaries: colour.primaries ?? stream?.primaries ?? usual.primaries,
			transfer: colour.transfer ?? stream?.transfer ?? usual.transfer,
			matrix: colour.matrix ?? stream?.matrix ?? usual.matrix,
			fullRange: wanted,
		};
		if (!stream || stream.fullRange === wanted) {
			return { input: "yuv", samples };
		}
		const canvas = new OffscreenCanvas(width, height);
		const context = canvas.getContext("2d");
		if (!context) return { input: "yuv", samples };
		context.fillStyle = "#808080";
		context.fillRect(0, 0, width, height);
		const rgb = await encodeOneFrame({
			frame: new VideoFrame(canvas, { timestamp: 0 }),
			width,
			height,
		});
		return { input: rgb?.fullRange === wanted ? "rgb" : "yuv", samples };
	})().catch((): ColourChoice => ({ input: "yuv", samples: usual }));
	colourChoices.set(key, chosen);
	return chosen;
}

/**
 * Each picture, already the target's size, given to the encoder as I420
 * rather than as RGB, which each web view's encoder turns into YUV its own
 * way (chooseColourInput). Joined to a file in the other range, the
 * converted clips would look washed out or too dark. The frames are tagged
 * with `colour` as it is, what it leaves unsaid unsaid, and written in
 * `samples` (media/yuv.ts). Undefined, to leave it to the encoder, where
 * that can't be written (HDR, an unknown matrix).
 */
function makeColourProcess({
	colour,
	samples,
	width,
	height,
}: {
	colour: VideoColorSpaceInit;
	samples: VideoColorSpaceInit;
	width: number;
	height: number;
}): ConversionVideoOptions["process"] {
	if (!canWriteColour({ colour: samples })) return undefined;
	const canvas = new OffscreenCanvas(width, height);
	const context = canvas.getContext("2d", {
		alpha: false,
		willReadFrequently: true,
	});
	if (!context) return undefined;
	return (sample) => {
		// Black where a picture that's fitted in leaves bars.
		context.fillStyle = "#000";
		context.fillRect(0, 0, width, height);
		sample.draw(context, 0, 0, width, height);
		const { data } = context.getImageData(0, 0, width, height);
		const yuv = rgbaToI420({ rgba: data, width, height, colour: samples });
		return new VideoSample(yuv, {
			format: "I420",
			codedWidth: width,
			codedHeight: height,
			timestamp: sample.timestamp,
			duration: sample.duration,
			colorSpace: colour,
		});
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
	colour,
	fit,
	part,
	folder,
	signal,
	onProgress,
}: {
	file: ConformFile;
	target: ConformTarget;
	sound: ConformSound | null;
	/** The colour space to write it in: the plan's. */
	colour: VideoColorSpaceInit;
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
		const choice = await chooseColourInput({ target, colour });
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
				process:
					choice.input === "yuv"
						? makeColourProcess({
								colour,
								samples: choice.samples,
								width: target.width,
								height: target.height,
							})
						: undefined,
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
