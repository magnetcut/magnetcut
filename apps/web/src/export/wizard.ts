import type { ExportChoices } from "./choices";
import { FRAME_RATE_PRESETS, type ExportVideoCodec } from "./settings";
import { frameRateToFloat } from "@/fps/utils";

// The export panel's Simple mode: a few questions in everyday words, the
// answers made the Advanced mode's choices, for those who'd rather not know
// what a codec is.

export const DESTINATIONS = ["anything", "upload", "small", "master"] as const;
export type Destination = (typeof DESTINATIONS)[number];

export const DESTINATION_NAMES: Record<Destination, string> = {
	anything: "Any TV, computer or phone, old ones too",
	upload: "YouTube, TikTok, Instagram",
	small: "The smallest file, for the newest devices",
	master: "Master file, to keep or edit",
};

export const DESTINATION_HINTS: Record<Destination, string> = {
	anything:
		"Up to 1080p at 30 frames a second, in the format every player has taken for years.",
	upload:
		"At the quality those sites ask for, in about half the space where this computer can.",
	small:
		"Smaller still, for phones, TVs and computers of the last couple of years.",
	master:
		"As little lost as can be: a big file, to keep or for another editor.",
};

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

/** The export's choices for the answers: the rest of `choices` (filters,
 * subtitles) as they were. */
export function applyWizardAnswers({
	answers,
	choices,
	encodable,
	projectShortSide,
	projectFps,
}: {
	answers: WizardAnswers;
	choices: ExportChoices;
	/** What this computer encodes: none while it's not known yet. */
	encodable: Set<ExportVideoCodec> | null;
	projectShortSide: number;
	projectFps: number;
}): ExportChoices {
	const { destination } = answers;
	const limits = getDestinationLimits({ destination });
	const wantedShortSide = Math.min(
		answers.shortSide ?? projectShortSide,
		projectShortSide,
	);
	const shortSide =
		limits.shortSide && wantedShortSide > limits.shortSide
			? limits.shortSide
			: answers.shortSide;
	const wantedFps = answers.fpsLabel
		? frameRateToFloat(
				FRAME_RATE_PRESETS.find(({ label }) => label === answers.fpsLabel)
					?.rate ?? {
					numerator: 30,
					denominator: 1,
				},
			)
		: projectFps;
	const fpsLabel =
		limits.fps && wantedFps > limits.fps + 0.01
			? fpsWithin({ fps: wantedFps, limit: limits.fps })
			: answers.fpsLabel;
	const fps = fpsLabel
		? frameRateToFloat(
				FRAME_RATE_PRESETS.find(({ label }) => label === fpsLabel)?.rate ?? {
					numerator: 30,
					denominator: 1,
				},
			)
		: projectFps;

	// Old players have only H.264; the sites take HEVC, in about half the
	// space; the newest devices AV1, smaller still.
	const videoCodec: ExportVideoCodec =
		destination === "upload"
			? firstEncodable({ codecs: ["hevc", "avc"], encodable })
			: destination === "small"
				? firstEncodable({ codecs: ["av1", "hevc", "avc"], encodable })
				: destination === "master"
					? firstEncodable({ codecs: ["prores-hq", "hevc", "avc"], encodable })
					: "avc";
	const format = destination === "master" ? "mov" : "mp4";

	const quality: Pick<
		ExportChoices,
		"qualityMode" | "level" | "videoKbps" | "megabytes"
	> = answers.maxMegabytes
		? { ...choices, qualityMode: "size", megabytes: answers.maxMegabytes }
		: destination === "upload"
			? {
					...choices,
					qualityMode: "bitrate",
					videoKbps: getUploadKbps({
						shortSide: Math.min(
							shortSide ?? projectShortSide,
							projectShortSide,
						),
						fps,
						codec: videoCodec === "hevc" ? "hevc" : "avc",
					}),
				}
			: {
					...choices,
					qualityMode: "level",
					level: destination === "master" ? "very_high" : "high",
				};

	const sound: Pick<
		ExportChoices,
		"hasAudio" | "audioPassthrough" | "audioCodec" | "audioKbps" | "channels"
	> =
		answers.sound === "none"
			? { ...choices, hasAudio: false }
			: {
					hasAudio: true,
					// Copied as it is, 5.1 too, where it can be; else the stereo mix.
					audioPassthrough: answers.sound === "original",
					audioCodec: "aac",
					audioKbps: answers.sound === "mono" ? 128 : 192,
					channels: answers.sound === "mono" ? 1 : 2,
				};

	return {
		...choices,
		format,
		videoCodec,
		qualityMode: quality.qualityMode,
		level: quality.level,
		videoKbps: quality.videoKbps,
		megabytes: quality.megabytes,
		shortSide,
		fpsLabel,
		hasAudio: sound.hasAudio,
		audioPassthrough: sound.audioPassthrough,
		audioCodec: sound.audioCodec,
		audioKbps: sound.audioKbps,
		channels: sound.channels,
	};
}
