import type { ExportChoices } from "./choices";
import type { ExportFormat, ExportQuality } from "./index";
import {
	AUDIO_BITRATES,
	FORMAT_CODECS,
	FRAME_RATE_PRESETS,
	SIZE_PRESETS,
	estimateExportBytes,
	fitAudioChoice,
	fitAudioCodec,
	fitExportSize,
	getSizeLimitBitrate,
	getSizeLimitFit,
	getVideoBitrate,
	isNativeOnlyCodec,
	type ExportAudioCodec,
	type ExportVideoCodec,
	type WebVideoCodec,
} from "./settings";
import { frameRateToFloat } from "@/fps/utils";

// The export panel's Simple mode: a few questions in everyday words, the
// answers made the Advanced mode's choices, for those who'd rather not know
// what a codec is.

export const DESTINATIONS = ["anything", "upload", "small", "master"] as const;
export type Destination = (typeof DESTINATIONS)[number];

export const SOUND_CHOICES = ["stereo", "mono", "original", "none"] as const;
export type SoundChoice = (typeof SOUND_CHOICES)[number];

export const SOUND_NAMES: Record<SoundChoice, string> = {
	stereo: "Stereo",
	mono: "Mono",
	original: "As the original (5.1 if it is)",
	none: "No sound",
};

export interface WizardAnswers {
	destination: Destination;
	/** None for no limit. */
	maxMegabytes: number | null;
	/** The shorter side; none for the project's. */
	shortSide: number | null;
	/** A `FRAME_RATE_PRESETS` label; none for the project's. */
	fpsLabel: string | null;
	sound: SoundChoice;
}

export const DEFAULT_WIZARD_ANSWERS: WizardAnswers = {
	destination: "upload",
	maxMegabytes: null,
	shortSide: null,
	fpsLabel: null,
	sound: "stereo",
};

/** What a destination's players take at most: the shorter side and frames a
 * second, none for no limit. */
export function getDestinationLimits({
	destination,
}: {
	destination: Destination;
}): { shortSide: number | null; fps: number | null } {
	switch (destination) {
		// H.264 at level 4.1, as old TVs and players decode it.
		case "anything":
			return { shortSide: 1080, fps: 30 };
		case "upload":
			return { shortSide: null, fps: 60 };
		default:
			return { shortSide: null, fps: null };
	}
}

/** The container for a destination: QuickTime for a master file, which may
 * be ProRes; MP4 for the rest. */
export function getWizardFormat({
	destination,
}: {
	destination: Destination;
}): ExportFormat {
	return destination === "master" ? "mov" : "mp4";
}

/** The shorter side asked for: the answer's, else the picture's, within the
 * destination's limit, and never more than the picture's. */
export function getAskedShortSide({
	answers,
	pictureShortSide,
}: {
	answers: WizardAnswers;
	pictureShortSide: number;
}): number {
	const limit = getDestinationLimits({
		destination: answers.destination,
	}).shortSide;
	return Math.min(
		answers.shortSide ?? pictureShortSide,
		limit ?? pictureShortSide,
		pictureShortSide,
	);
}

// YouTube's recommended upload bitrates for SDR, in kbit/s, by the shorter
// side: at 24 to 30 frames a second, and at 48 to 60. They're H.264's; HEVC
// gets the same picture from less of them.
const UPLOAD_KBPS: Array<{
	shortSide: number;
	standard: number;
	high: number;
}> = [
	{ shortSide: 2160, standard: 40_000, high: 60_000 },
	{ shortSide: 1440, standard: 16_000, high: 24_000 },
	{ shortSide: 1080, standard: 8_000, high: 12_000 },
	{ shortSide: 720, standard: 5_000, high: 7_500 },
	{ shortSide: 480, standard: 2_500, high: 4_000 },
	{ shortSide: 0, standard: 1_000, high: 1_500 },
];

// HEVC's bitrate for H.264's picture, as the size estimates reckon it.
const HEVC_SHARE = 0.6;

/** What YouTube asks an upload this size be encoded at, in kbit/s, as
 * H.264; as HEVC, in proportion. */
export function getUploadKbps({
	shortSide,
	fps,
	codec = "avc",
}: {
	shortSide: number;
	fps: number;
	codec?: "avc" | "hevc";
}): number {
	const row =
		UPLOAD_KBPS.find((candidate) => shortSide >= candidate.shortSide) ??
		UPLOAD_KBPS[UPLOAD_KBPS.length - 1];
	const kbps = fps > 40 ? row.high : row.standard;
	return codec === "hevc" ? Math.round((kbps * HEVC_SHARE) / 100) * 100 : kbps;
}

/** A preset's frame rate, by its label: none for a label that isn't one. */
function getPresetFps({ label }: { label: string }): number | null {
	const preset = FRAME_RATE_PRESETS.find(
		(candidate) => candidate.label === label,
	);
	return preset ? frameRateToFloat(preset.rate) : null;
}

/** A frame rate within `limit`: halved until it is, as 59.94 becomes 29.97. */
function fpsWithin({
	fps,
	limit,
}: {
	fps: number;
	limit: number;
}): string | null {
	let target = fps;
	while (target > limit + 0.01) target /= 2;
	const preset = FRAME_RATE_PRESETS.reduce((best, candidate) =>
		Math.abs(frameRateToFloat(candidate.rate) - target) <
		Math.abs(frameRateToFloat(best.rate) - target)
			? candidate
			: best,
	);
	return preset.label;
}

/**
 * The codecs for a destination, the best for it first, of those `format`
 * takes (else the format's own): old players have only H.264; the sites take
 * HEVC, in about half the space; the newest devices AV1, smaller still. While
 * exports keep to hardware (export/hardware.ts), AV1 isn't offered on a Mac,
 * and the smallest file is HEVC. ProRes has its own rate, whatever the size
 * asked.
 */
function getDestinationCodecs({
	destination,
	format,
	hasSizeLimit,
}: {
	destination: Destination;
	format: ExportFormat;
	hasSizeLimit: boolean;
}): ExportVideoCodec[] {
	const best = ((): ExportVideoCodec[] => {
		switch (destination) {
			case "anything":
				return ["avc"];
			case "upload":
				return ["hevc", "avc"];
			case "small":
				return ["av1", "hevc", "avc"];
			case "master":
				return hasSizeLimit ? ["hevc", "avc"] : ["prores-hq", "hevc", "avc"];
		}
	})();
	const taken = FORMAT_CODECS[format].video;
	const offered = best.filter((codec) => taken.includes(codec));
	return offered.length > 0 ? offered : taken;
}

/** The first of `codecs` this computer encodes, else the last. */
function firstEncodable({
	codecs,
	encodable,
}: {
	codecs: ExportVideoCodec[];
	encodable: Set<ExportVideoCodec> | null;
}): ExportVideoCodec {
	return (
		codecs.find((codec) => encodable?.has(codec)) ?? codecs[codecs.length - 1]
	);
}

/** The quality a destination asks at a size: YouTube's bitrate for an
 * upload, a level for the others. */
function getDestinationQuality({
	destination,
	codec,
	shortSide,
	fps,
}: {
	destination: Destination;
	codec: ExportVideoCodec;
	shortSide: number;
	fps: number;
}):
	| { mode: "level"; level: ExportQuality }
	| { mode: "bitrate"; kbps: number } {
	switch (destination) {
		case "upload":
			return {
				mode: "bitrate",
				// VP9 and AV1, in an agent's WebM, as HEVC: no worse.
				kbps: getUploadKbps({
					shortSide,
					fps,
					codec: codec === "avc" ? "avc" : "hevc",
				}),
			};
		case "master":
			return { mode: "level", level: "very_high" };
		default:
			return { mode: "level", level: "high" };
	}
}

// The sound's bitrates, in kbit/s, where it's encoded.
const SOUND_KBPS = { stereo: 192, mono: 128 };
// The most of a size-limited file the sound is given: a quarter.
const SOUND_SHARE = 0.25;
// The smallest a size limit makes the picture: smaller, a film is no use.
const SMALLEST_FIT = 240;

/** The sound, as a size limit is worked back from it: encoded, at `kbps` at
 * most; copied as it is, at its own `bitrate`, in bits a second; or none. */
export type FitSound =
	| { isCopied: false; kbps: number }
	| { isCopied: true; bitrate: number }
	| null;

/**
 * A file that must fit in `megabytes`, worked back from: the sound's bitrate,
 * a copy's own, else `sound.kbps` at most and a quarter of the whole at most
 * (the codec's least at worst); and the picture's shorter side, the largest
 * of `largest` and the smaller sizes offered (`SIZE_PRESETS`) at which the
 * film fits (`getSizeLimitFit`), else the smallest, 240p. A limit too small
 * even so is the panel's to say.
 */
export function fitToSize({
	megabytes,
	duration,
	fps,
	picture,
	largest,
	codec,
	audioCodec,
	sound,
}: {
	megabytes: number;
	/** In seconds. */
	duration: number;
	/** Frames a second. */
	fps: number;
	/** The picture's size, after any crop. */
	picture: { width: number; height: number };
	/** The shorter side asked for: the most the picture may have. */
	largest: number;
	codec: WebVideoCodec;
	audioCodec: ExportAudioCodec;
	sound: FitSound;
}): { shortSide: number; audioKbps: number | null } {
	// In bits a second, the whole file's.
	const total = getSizeLimitBitrate({
		megabytes,
		duration,
		fps,
		hasSound: sound !== null,
	});
	const rates = AUDIO_BITRATES[audioCodec];
	const audioKbps =
		sound && !sound.isCopied
			? (rates
					.filter(
						(kbps) => kbps <= sound.kbps && kbps * 1000 <= total * SOUND_SHARE,
					)
					.pop() ?? rates[0])
			: null;
	const audioBitrate = sound?.isCopied
		? sound.bitrate
		: (audioKbps ?? 0) * 1000;
	const sizes = [
		largest,
		...SIZE_PRESETS.map((preset) => preset.shortSide).filter(
			(side) => side < largest && side >= SMALLEST_FIT,
		),
	];
	const fitting = sizes.find(
		(shortSide) =>
			getSizeLimitFit({
				megabytes,
				duration,
				fps,
				codec,
				...fitExportSize({ canvas: picture, shortSide }),
				audioBitrate,
			}) === "fits",
	);
	return { shortSide: fitting ?? sizes[sizes.length - 1], audioKbps };
}

/**
 * The export's choices for the answers: the rest of `choices` (filters,
 * subtitles) as they were. A size limit is kept to with the destination's
 * own quality where the film comes out under it at that; else the file is
 * made the limit's size, the sound given its share and the picture as large
 * as what's left carries (`fitToSize`).
 */
export function applyWizardAnswers({
	answers,
	choices,
	encodable,
	projectFps,
	picture,
	duration,
	copiedBitrate,
	format: chosenFormat,
}: {
	answers: WizardAnswers;
	choices: ExportChoices;
	/** What this computer encodes: none while it's not known yet. */
	encodable: Set<ExportVideoCodec> | null;
	projectFps: number;
	/** The picture's size, after any crop. */
	picture: { width: number; height: number };
	/** The film's length, in seconds. */
	duration: number;
	/** The source's sound's bitrate, in bits a second, where it can be copied
	 * into the file; none where it can't, and the mix is encoded instead. */
	copiedBitrate: number | null;
	/** The container where it's chosen already, as an agent's file's
	 * extension says it; else the destination's (`getWizardFormat`). */
	format?: ExportFormat;
}): ExportChoices {
	const { destination, maxMegabytes } = answers;
	const limits = getDestinationLimits({ destination });
	const pictureShortSide = Math.min(picture.width, picture.height);
	const largest = getAskedShortSide({ answers, pictureShortSide });

	const wantedFps = answers.fpsLabel
		? (getPresetFps({ label: answers.fpsLabel }) ?? projectFps)
		: projectFps;
	const fpsLabel =
		limits.fps && wantedFps > limits.fps + 0.01
			? fpsWithin({ fps: wantedFps, limit: limits.fps })
			: answers.fpsLabel;
	const fps = fpsLabel
		? (getPresetFps({ label: fpsLabel }) ?? projectFps)
		: projectFps;

	const format = chosenFormat ?? getWizardFormat({ destination });
	const videoCodec = firstEncodable({
		codecs: getDestinationCodecs({
			destination,
			format,
			hasSizeLimit: !!maxMegabytes,
		}),
		encodable,
	});

	// Copied as it is, 5.1 too, where it can be; else the stereo mix.
	const hasAudio = answers.sound !== "none";
	const audioPassthrough = answers.sound === "original";
	const channels = answers.sound === "mono" ? 1 : 2;
	const audioCodec = fitAudioCodec({ format, codec: "aac" });
	const askedKbps =
		answers.sound === "mono" ? SOUND_KBPS.mono : SOUND_KBPS.stereo;
	const sound: FitSound = !hasAudio
		? null
		: audioPassthrough && copiedBitrate !== null
			? { isCopied: true, bitrate: copiedBitrate }
			: { isCopied: false, kbps: askedKbps };
	const soundBitrate = !sound
		? 0
		: sound.isCopied
			? sound.bitrate
			: sound.kbps * 1000;

	// A size limit is kept to with the destination's own quality, unless the
	// film comes out over it at that: a short film isn't made bigger to fill it.
	const own = getDestinationQuality({
		destination,
		codec: videoCodec,
		shortSide: largest,
		fps,
	});
	const limit =
		maxMegabytes && duration > 0 && !isNativeOnlyCodec(videoCodec)
			? { megabytes: maxMegabytes, codec: videoCodec }
			: null;
	const ownBytes = estimateExportBytes({
		videoBitrate: getVideoBitrate({
			quality: own,
			codec: videoCodec,
			...fitExportSize({ canvas: picture, shortSide: largest }),
			fps,
			duration,
			audioBitrate: soundBitrate,
		}),
		audioBitrate: soundBitrate,
		duration,
		fps,
	});
	const fitted =
		limit && ownBytes > limit.megabytes * 1_000_000
			? {
					megabytes: limit.megabytes,
					...fitToSize({
						...limit,
						duration,
						fps,
						picture,
						largest,
						audioCodec,
						sound,
					}),
				}
			: null;

	const quality: Pick<
		ExportChoices,
		"qualityMode" | "level" | "videoKbps" | "megabytes"
	> = fitted
		? { ...choices, qualityMode: "size", megabytes: fitted.megabytes }
		: own.mode === "bitrate"
			? { ...choices, qualityMode: "bitrate", videoKbps: own.kbps }
			: { ...choices, qualityMode: "level", level: own.level };
	// Without sound, what's chosen for it is kept, in what the container takes.
	const kept = fitAudioChoice({
		format,
		codec: choices.audioCodec,
		kbps: choices.audioKbps,
	});
	const soundChoices: Pick<
		ExportChoices,
		"hasAudio" | "audioPassthrough" | "audioCodec" | "audioKbps" | "channels"
	> = hasAudio
		? {
				hasAudio,
				audioPassthrough,
				audioCodec,
				audioKbps: fitted?.audioKbps ?? askedKbps,
				channels,
			}
		: {
				hasAudio,
				audioPassthrough: choices.audioPassthrough,
				audioCodec: kept.codec,
				audioKbps: kept.kbps,
				channels: choices.channels,
			};
	const shortSide = fitted?.shortSide ?? largest;

	return {
		...choices,
		format,
		videoCodec,
		qualityMode: quality.qualityMode,
		level: quality.level,
		videoKbps: quality.videoKbps,
		megabytes: quality.megabytes,
		shortSide: shortSide >= pictureShortSide ? null : shortSide,
		fpsLabel,
		...soundChoices,
		// Those sites play everything at about -14 LUFS: a mix made to it plays
		// as it was heard here. Copied sound can't be measured.
		loudness:
			destination === "upload" && hasAudio && !audioPassthrough ? -14 : null,
	};
}
