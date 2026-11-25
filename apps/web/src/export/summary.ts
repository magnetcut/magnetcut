import {
	getChosenAudio,
	getChosenQuality,
	type ExportChoices,
} from "./choices";
import type { ExportFilters } from "./filters";
import type { ExportFormat } from "./index";
import type { PassthroughSound } from "./passthrough";
import { formatDuration } from "./progress";
import {
	AUDIO_CODEC_NAMES,
	FORMAT_NAMES,
	estimateExportBytes,
	getSizeLimitFit,
	getVideoBitrate,
	isNativeOnlyCodec,
	type ExportAudioCodec,
	type ExportVideoCodec,
} from "./settings";
import { getAskedShortSide } from "./wizard";
import {
	FILE_TAG_KEYS,
	PLACE_WARNING,
	type FileTags,
} from "@/project/file-tags";
import { listNames } from "@/utils/string";

// What the export panel says of an export before it starts: what the file
// holds, about how big it'll be, what's wrong with its size limit, and the
// project's details it's given.

const CODEC_NAMES: Record<string, string> = {
	avc: "H.264",
	hevc: "HEVC",
	vp8: "VP8",
	vp9: "VP9",
	av1: "AV1",
	aac: "AAC",
	opus: "Opus",
	mp3: "MP3",
	ac3: "AC-3",
	eac3: "E-AC-3",
	flac: "FLAC",
	vorbis: "Vorbis",
};

/** A codec of a source's, as it's named: "H.264", "E-AC-3"; one that isn't
 * known, in capitals. */
export function getCodecName({ codec }: { codec: string }): string {
	return CODEC_NAMES[codec] ?? codec.toUpperCase();
}

/** Channels as they're said: "mono", "stereo", "5.1", or how many. */
export function getChannelsName({ count }: { count: number }): string {
	switch (count) {
		case 1:
			return "mono";
		case 2:
			return "stereo";
		case 6:
			return "5.1";
		default:
			return `${count} channels`;
	}
}

/** The sound, as an export's summary says it. */
export type SoundSummary =
	| { kind: "copied"; codec: string; channels?: number }
	| {
			kind: "encoded";
			codec: ExportAudioCodec;
			kbps: number;
			channels: number;
	  }
	| { kind: "none" };

/** "AAC 5.1 copied", "Opus 128 kbit/s stereo", "no sound". */
export function describeSound({ sound }: { sound: SoundSummary }): string {
	switch (sound.kind) {
		case "copied": {
			const channels = sound.channels
				? getChannelsName({ count: sound.channels })
				: "sound";
			return `${getCodecName({ codec: sound.codec })} ${channels} copied`;
		}
		case "encoded":
			return `${AUDIO_CODEC_NAMES[sound.codec]} ${sound.kbps} kbit/s ${getChannelsName({ count: sound.channels })}`;
		case "none":
			return "no sound";
	}
}

/** The filters, as the summary lists them: none where there are none. */
function describeFilters({
	filters,
}: {
	filters: ExportFilters;
}): string | null {
	const applied = [
		filters.deinterlace && "deinterlaced",
		filters.denoise !== "off" && `denoised (${filters.denoise})`,
		filters.sharpen !== "off" && `sharpened (${filters.sharpen})`,
	].filter((name): name is string => !!name);
	return applied.length > 0 ? applied.join(", ") : null;
}

/** In decimal megabytes, as Finder and Explorer count them. */
export function formatMegabytes({ bytes }: { bytes: number }): string {
	const megabytes = bytes / 1_000_000;
	if (megabytes >= 1000) return `${(megabytes / 1000).toFixed(1)} GB`;
	return `${megabytes < 10 ? megabytes.toFixed(1) : Math.round(megabytes)} MB`;
}

/** The source's sound, where the export copies it: it's chosen, it can be,
 * and the loudness is left as it is. */
export function getCopiedSound({
	choices,
	passthrough,
}: {
	choices: ExportChoices;
	passthrough: PassthroughSound | null;
}): PassthroughSound | null {
	return getChosenAudio({ choices })?.passthrough ? passthrough : null;
}

/** The size limit the Simple mode made the picture smaller than asked to
 * fit in: none where it didn't. */
export function getFitMegabytes({
	choices,
	pictureShortSide,
}: {
	choices: ExportChoices;
	pictureShortSide: number;
}): number | null {
	const { wizard } = choices;
	if (choices.panelMode !== "simple" || wizard.maxMegabytes === null) {
		return null;
	}
	const asked = getAskedShortSide({ answers: wizard, pictureShortSide });
	return (choices.shortSide ?? pictureShortSide) < asked
		? wizard.maxMegabytes
		: null;
}

/** What's wrong with a size limit (`getSizeLimitFit`): none where the film
 * fits in it, or isn't a length to fit. */
export function getLimitWarning({
	megabytes,
	duration,
	fps,
	codec,
	width,
	height,
	audioBitrate,
	estimatedBytes,
	isSimple,
}: {
	megabytes: number;
	duration: number;
	fps: number;
	codec: ExportVideoCodec;
	width: number;
	height: number;
	audioBitrate: number;
	/** About how big the file will be at the bitrates given. */
	estimatedBytes: number;
	/** In the Simple mode, the picture's already as small as it goes. */
	isSimple: boolean;
}): string | null {
	if (isNativeOnlyCodec(codec) || duration <= 0) return null;
	const fit = getSizeLimitFit({
		megabytes,
		duration,
		fps,
		codec,
		width,
		height,
		audioBitrate,
	});
	switch (fit) {
		case "fits":
			return null;
		case "over":
			return `${formatDuration({ seconds: duration })} can't fit in ${megabytes} MB: about ${formatMegabytes({ bytes: estimatedBytes })} at the least.`;
		case "starved":
			return isSimple
				? `${megabytes} MB leaves even ${width}×${height} too little: the file may come out bigger.`
				: `${megabytes} MB leaves ${width}×${height} too little: the file may come out bigger. A smaller size keeps to it.`;
	}
}

const TAG_NAMES: Record<keyof FileTags, string> = {
	title: "title",
	artist: "artist",
	date: "date",
	genre: "genre",
	description: "description",
	comment: "comment",
	location: "place",
	make: "camera",
	model: "camera",
};

// What a Matroska file has no tags for (`getOutputTags`).
const NOT_IN_MATROSKA: ReadonlyArray<keyof FileTags> = [
	"location",
	"make",
	"model",
];

/** The project's details a file of `format` is given, as the summary says
 * them, and that the place is, which anyone with the file can see: none
 * where none is. */
export function describeFileTags({
	tags,
	format,
}: {
	tags: FileTags;
	format: ExportFormat;
}): { text: string; warning: string | null } | null {
	const hasPlaceAndCamera = format === "mp4" || format === "mov";
	const written = FILE_TAG_KEYS.filter(
		(key) =>
			!!tags[key] && (hasPlaceAndCamera || !NOT_IN_MATROSKA.includes(key)),
	);
	if (written.length === 0) return null;
	const names = [...new Set(written.map((key) => TAG_NAMES[key]))];
	return {
		text: `With its ${listNames({ names })}`,
		warning: written.includes("location") ? PLACE_WARNING : null,
	};
}

/** What the panel says of an export, but a Fast mode one's. */
export interface ExportSummaryText {
	/** What the file holds: its size, frame rate, sound, filters and
	 * container. */
	details: string;
	/** About how big, as it's written ("2.3 GB"): none where it varies. */
	size: string | null;
	/** What's wrong with the size limit. */
	limitWarning: string | null;
	/** The project's details written into it (`describeFileTags`). */
	tags: { text: string; warning: string | null } | null;
	/** The video's, in bits a second. */
	videoBitrate: number;
}

export function summarizeExport({
	choices,
	picture,
	output,
	fps,
	duration,
	passthrough,
	keepsQuality,
	tags,
}: {
	choices: ExportChoices;
	/** The picture's size, after any crop. */
	picture: { width: number; height: number };
	/** The size it's encoded at. */
	output: { width: number; height: number };
	/** Frames a second. */
	fps: number;
	/** In seconds. */
	duration: number;
	/** The source's sound, where it can be copied. */
	passthrough: PassthroughSound | null;
	/** Kept at a constant quality by the Mac's encoder: of no known size. */
	keepsQuality: boolean;
	tags: FileTags;
}): ExportSummaryText {
	const audio = getChosenAudio({ choices });
	const copied = getCopiedSound({ choices, passthrough });
	const sound: SoundSummary = copied
		? { kind: "copied", codec: copied.codec, channels: copied.numberOfChannels }
		: audio
			? {
					kind: "encoded",
					codec: audio.codec,
					kbps: audio.kbps,
					channels: audio.channels,
				}
			: { kind: "none" };
	const audioBitrate = copied ? copied.bitrate : audio ? audio.kbps * 1000 : 0;
	const videoBitrate = getVideoBitrate({
		quality: getChosenQuality({ choices }),
		codec: choices.videoCodec,
		...output,
		fps,
		duration,
		audioBitrate,
	});
	const estimatedBytes = estimateExportBytes({
		videoBitrate,
		audioBitrate,
		duration,
		fps,
	});
	const fitMegabytes = getFitMegabytes({
		choices,
		pictureShortSide: Math.min(picture.width, picture.height),
	});
	const details = [
		`${output.width}×${output.height}${fitMegabytes === null ? "" : ` to fit ${fitMegabytes} MB`}`,
		`${+fps.toFixed(3)} fps`,
		describeSound({ sound }),
		describeFilters({ filters: choices }),
		FORMAT_NAMES[choices.format],
		keepsQuality ? "size varies with the picture" : null,
	]
		.filter((part): part is string => !!part)
		.join(", ");
	return {
		details,
		size: keepsQuality ? null : formatMegabytes({ bytes: estimatedBytes }),
		limitWarning:
			choices.qualityMode === "size"
				? getLimitWarning({
						megabytes: choices.megabytes,
						duration,
						fps,
						codec: choices.videoCodec,
						...output,
						audioBitrate,
						estimatedBytes,
						isSimple: choices.panelMode === "simple",
					})
				: null,
		tags: describeFileTags({ tags, format: choices.format }),
		videoBitrate,
	};
}
