import type { FrameRate } from "magnetcut-wasm";
import type { ExportFormat, ExportQuality } from "./index";

// Export's settings, as HandBrake has them (docs/NATIVE.md, phase 3): what
// they mean in bitrates and sizes, worked out before anything is encoded.

export const EXPORT_VIDEO_CODECS = ["avc", "hevc", "vp9", "av1"] as const;
export type ExportVideoCodec = (typeof EXPORT_VIDEO_CODECS)[number];

export const EXPORT_AUDIO_CODECS = ["aac", "opus"] as const;
export type ExportAudioCodec = (typeof EXPORT_AUDIO_CODECS)[number];

/** The codecs each container takes, as players expect them, the usual first. */
export const FORMAT_CODECS: Record<
	ExportFormat,
	{ video: ExportVideoCodec[]; audio: ExportAudioCodec[] }
> = {
	mp4: { video: ["avc", "hevc", "av1"], audio: ["aac", "opus"] },
	mov: { video: ["avc", "hevc"], audio: ["aac"] },
	mkv: { video: ["avc", "hevc", "vp9", "av1"], audio: ["aac", "opus"] },
	webm: { video: ["vp9", "av1"], audio: ["opus"] },
};

export const FORMAT_NAMES: Record<ExportFormat, string> = {
	mp4: "MP4",
	mov: "QuickTime (MOV)",
	mkv: "Matroska (MKV)",
	webm: "WebM",
};

export const VIDEO_CODEC_NAMES: Record<ExportVideoCodec, string> = {
	avc: "H.264",
	hevc: "HEVC (H.265)",
	vp9: "VP9",
	av1: "AV1",
};

export const AUDIO_CODEC_NAMES: Record<ExportAudioCodec, string> = {
	aac: "AAC",
	opus: "Opus",
};

/** How the video's bitrate is chosen. */
export type ExportVideoQuality =
	| { mode: "level"; level: ExportQuality }
	| { mode: "bitrate"; kbps: number }
	| { mode: "size"; megabytes: number };

// mediabunny's quality factors (QUALITY_LOW and the rest) and how much less
// each codec needs than H.264, applied here so the bitrate is known before
// encoding.
const LEVEL_FACTORS: Record<ExportQuality, number> = {
	low: 0.6,
	medium: 1,
	high: 2,
	very_high: 4,
};
const CODEC_EFFICIENCY: Record<ExportVideoCodec, number> = {
	avc: 1,
	hevc: 0.6,
	vp9: 0.6,
	av1: 0.4,
};

// What a file takes besides its video and audio, about.
const CONTAINER_OVERHEAD = 0.01;
const MIN_VIDEO_BITRATE = 100_000;

/**
 * A quality level's video bitrate, as mediabunny reckons it: 3 Mbit/s for
 * medium H.264 at 1080p, scaled by the picture's size and the codec.
 */
export function getLevelBitrate({
	level,
	codec,
	width,
	height,
}: {
	level: ExportQuality;
	codec: ExportVideoCodec;
	width: number;
	height: number;
}): number {
	const scale = ((width * height) / (1920 * 1080)) ** 0.95;
	const bitrate =
		3_000_000 * scale * CODEC_EFFICIENCY[codec] * LEVEL_FACTORS[level];
	return Math.ceil(bitrate / 1000) * 1000;
}

/** The video bitrate for the quality chosen, in bits a second. */
export function getVideoBitrate({
	quality,
	codec,
	width,
	height,
	duration,
	audioBitrate,
}: {
	quality: ExportVideoQuality;
	codec: ExportVideoCodec;
	width: number;
	height: number;
	/** In seconds. */
	duration: number;
	audioBitrate: number;
}): number {
	switch (quality.mode) {
		case "level":
			return getLevelBitrate({ level: quality.level, codec, width, height });
		case "bitrate":
			return Math.round(quality.kbps * 1000);
		case "size": {
			// What's left for the video once the audio and the container have theirs.
			const bits = quality.megabytes * 8_000_000 * (1 - CONTAINER_OVERHEAD);
			const bitrate = bits / Math.max(duration, 1) - audioBitrate;
			return Math.max(MIN_VIDEO_BITRATE, Math.floor(bitrate));
		}
	}
}

/** About how big the file will be, in bytes. */
export function estimateExportBytes({
	videoBitrate,
	audioBitrate,
	duration,
}: {
	videoBitrate: number;
	audioBitrate: number;
	duration: number;
}): number {
	return (
		(((videoBitrate + audioBitrate) * duration) / 8) * (1 + CONTAINER_OVERHEAD)
	);
}

/** Sizes by the shorter side, so a portrait project's 1080p is 1080 wide. */
export const SIZE_PRESETS = [
	{ shortSide: 2160, label: "4K (2160p)" },
	{ shortSide: 1440, label: "1440p" },
	{ shortSide: 1080, label: "1080p" },
	{ shortSide: 720, label: "720p" },
	{ shortSide: 480, label: "480p" },
] as const;

/** What's cut from each side of the picture, in the project's pixels. */
export interface ExportCrop {
	top: number;
	bottom: number;
	left: number;
	right: number;
}

export const NO_CROP: ExportCrop = { top: 0, bottom: 0, left: 0, right: 0 };

export function isCropped({ crop }: { crop?: ExportCrop }): boolean {
	return (
		!!crop &&
		[crop.top, crop.bottom, crop.left, crop.right].some((side) => side > 0)
	);
}

/** The picture left once cropped, at least 16 pixels each way. */
export function getCroppedSize({
	canvas,
	crop,
}: {
	canvas: { width: number; height: number };
	crop?: ExportCrop;
}): { width: number; height: number } {
	if (!crop) return { width: canvas.width, height: canvas.height };
	return {
		width: Math.max(16, canvas.width - crop.left - crop.right),
		height: Math.max(16, canvas.height - crop.top - crop.bottom),
	};
}

/**
 * The export's size for a shorter side: the (cropped) picture's shape, in
 * even numbers (H.264 and HEVC need them), never larger than the picture.
 */
export function fitExportSize({
	canvas,
	shortSide,
	crop,
}: {
	canvas: { width: number; height: number };
	shortSide?: number;
	crop?: ExportCrop;
}): { width: number; height: number } {
	const picture = getCroppedSize({ canvas, crop });
	const pictureShortSide = Math.min(picture.width, picture.height);
	const scale = shortSide ? Math.min(1, shortSide / pictureShortSide) : 1;
	// The nearest even number, though an odd-sized picture loses a pixel
	// rather than gains one.
	const even = ({ value, limit }: { value: number; limit: number }) =>
		Math.max(2, Math.min(2 * Math.round(value / 2), 2 * Math.floor(limit / 2)));
	return {
		width: even({ value: picture.width * scale, limit: picture.width }),
		height: even({ value: picture.height * scale, limit: picture.height }),
	};
}

export const FRAME_RATE_PRESETS: { label: string; rate: FrameRate }[] = [
	{ label: "23.976", rate: { numerator: 24000, denominator: 1001 } },
	{ label: "24", rate: { numerator: 24, denominator: 1 } },
	{ label: "25", rate: { numerator: 25, denominator: 1 } },
	{ label: "29.97", rate: { numerator: 30000, denominator: 1001 } },
	{ label: "30", rate: { numerator: 30, denominator: 1 } },
	{ label: "50", rate: { numerator: 50, denominator: 1 } },
	{ label: "59.94", rate: { numerator: 60000, denominator: 1001 } },
	{ label: "60", rate: { numerator: 60, denominator: 1 } },
];

export interface ExportAudioSettings {
	codec: ExportAudioCodec;
	kbps: number;
	channels: 1 | 2;
}

/** The bitrates offered, in kbit/s: AAC's are those encoders take everywhere. */
export const AUDIO_BITRATES: Record<ExportAudioCodec, number[]> = {
	aac: [96, 128, 160, 192],
	opus: [64, 96, 128, 160, 192, 256],
};

/** What the export's audio was before it had settings: "high" for each codec. */
export const DEFAULT_AUDIO_KBPS: Record<ExportAudioCodec, number> = {
	aac: 192,
	opus: 128,
};

/** A container's audio codec for the one chosen: the same if it takes it. */
export function fitAudioCodec({
	format,
	codec,
}: {
	format: ExportFormat;
	codec: ExportAudioCodec;
}): ExportAudioCodec {
	const codecs = FORMAT_CODECS[format].audio;
	return codecs.includes(codec) ? codec : codecs[0];
}

/** A container's video codec for the one chosen: the same if it takes it. */
export function fitVideoCodec({
	format,
	codec,
}: {
	format: ExportFormat;
	codec: ExportVideoCodec;
}): ExportVideoCodec {
	const codecs = FORMAT_CODECS[format].video;
	return codecs.includes(codec) ? codec : codecs[0];
}
