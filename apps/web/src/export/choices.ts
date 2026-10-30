import {
	EXPORT_FORMAT_VALUES,
	EXPORT_QUALITY_VALUES,
	type ExportFormat,
	type ExportOptions,
	type ExportQuality,
} from "./index";
import {
	AUDIO_BITRATES,
	DEFAULT_AUDIO_KBPS,
	FORMAT_CODECS,
	FRAME_RATE_PRESETS,
	type ExportAudioCodec,
	type ExportAudioSettings,
	type ExportVideoCodec,
	type ExportVideoQuality,
} from "./settings";
import { FILTER_STRENGTHS, type FilterStrength } from "./filters";

// What the export panel has chosen, kept between exports and in presets. The
// values for the quality modes and the sound not in use are kept too, so
// going back to one finds it as it was.

export const QUALITY_MODES = ["level", "bitrate", "size", "constant"] as const;
export type QualityMode = (typeof QUALITY_MODES)[number];

export interface ExportChoices {
	format: ExportFormat;
	videoCodec: ExportVideoCodec;
	qualityMode: QualityMode;
	level: ExportQuality;
	videoKbps: number;
	megabytes: number;
	/** From 1 to 100: kept by the Mac's own encoder (`export/native.ts`). */
	constantQuality: number;
	/** The shorter side, a preset's or your own; none for the full size. */
	shortSide: number | null;
	/** A `FRAME_RATE_PRESETS` label; none for the project's rate. */
	fpsLabel: string | null;
	hasAudio: boolean;
	/** Copy the source's sound when it's the whole soundtrack, uncut. */
	audioPassthrough: boolean;
	audioCodec: ExportAudioCodec;
	audioKbps: number;
	channels: 1 | 2;
	deinterlace: boolean;
	denoise: FilterStrength;
	sharpen: FilterStrength;
}

export interface ExportPreset {
	id: string;
	name: string;
	choices: ExportChoices;
}

export const DEFAULT_EXPORT_CHOICES: ExportChoices = {
	format: "mp4",
	videoCodec: "avc",
	qualityMode: "level",
	level: "high",
	videoKbps: 8000,
	megabytes: 25,
	constantQuality: 65,
	shortSide: null,
	fpsLabel: null,
	hasAudio: true,
	audioPassthrough: true,
	audioCodec: "aac",
	audioKbps: 192,
	channels: 2,
	deinterlace: false,
	denoise: "off",
	sharpen: "off",
};

/**
 * HandBrake's kind of starting points. All but the last are in codecs every
 * web view encodes (on Linux, with the GStreamer packages the deb and rpm
 * recommend); WebView2 has no HEVC.
 */
export const BUILT_IN_PRESETS: ExportPreset[] = [
	{ id: "default", name: "Default", choices: DEFAULT_EXPORT_CHOICES },
	{
		id: "fast-1080p",
		name: "Fast 1080p",
		choices: { ...DEFAULT_EXPORT_CHOICES, shortSide: 1080, audioKbps: 160 },
	},
	{
		id: "small-720p",
		name: "Small 720p",
		choices: {
			...DEFAULT_EXPORT_CHOICES,
			level: "medium",
			shortSide: 720,
			audioKbps: 128,
		},
	},
	{
		id: "fits-25mb",
		name: "Fits in 25 MB",
		choices: {
			...DEFAULT_EXPORT_CHOICES,
			qualityMode: "size",
			megabytes: 25,
			shortSide: 720,
			audioKbps: 128,
		},
	},
	{
		id: "fits-10mb",
		name: "Fits in 10 MB",
		choices: {
			...DEFAULT_EXPORT_CHOICES,
			qualityMode: "size",
			megabytes: 10,
			shortSide: 480,
			audioKbps: 96,
		},
	},
	{
		id: "web-1080p",
		name: "Web 1080p (WebM)",
		choices: {
			...DEFAULT_EXPORT_CHOICES,
			format: "webm",
			videoCodec: "vp9",
			shortSide: 1080,
			audioCodec: "opus",
			audioKbps: 128,
		},
	},
	{
		id: "archive-hevc",
		name: "Archive (HEVC)",
		choices: {
			...DEFAULT_EXPORT_CHOICES,
			format: "mkv",
			videoCodec: "hevc",
			level: "very_high",
		},
	},
];

/** The video quality chosen, in the export's terms. */
export function getChosenQuality({
	choices,
}: {
	choices: ExportChoices;
}): ExportVideoQuality {
	switch (choices.qualityMode) {
		case "level":
			return { mode: "level", level: choices.level };
		case "bitrate":
			return { mode: "bitrate", kbps: choices.videoKbps };
		case "size":
			return { mode: "size", megabytes: choices.megabytes };
		case "constant":
			return { mode: "constant", quality: choices.constantQuality };
	}
}

/** The sound chosen, or none. */
export function getChosenAudio({
	choices,
}: {
	choices: ExportChoices;
}): ExportAudioSettings | null {
	if (!choices.hasAudio) return null;
	return {
		codec: choices.audioCodec,
		kbps: choices.audioKbps,
		channels: choices.channels,
		passthrough: choices.audioPassthrough,
	};
}

/** The export's options for these choices, but where it goes. */
export function getChosenOptions({
	choices,
}: {
	choices: ExportChoices;
}): Omit<ExportOptions, "path"> {
	return {
		format: choices.format,
		videoCodec: choices.videoCodec,
		quality: getChosenQuality({ choices }),
		shortSide: choices.shortSide ?? undefined,
		fps: FRAME_RATE_PRESETS.find((preset) => preset.label === choices.fpsLabel)
			?.rate,
		audio: getChosenAudio({ choices }),
		filters: {
			deinterlace: choices.deinterlace,
			denoise: choices.denoise,
			sharpen: choices.sharpen,
		},
	};
}

/** Whether two sets of choices make the same export, whatever's kept for later. */
export function isSameExport({
	a,
	b,
}: {
	a: ExportChoices;
	b: ExportChoices;
}): boolean {
	const effective = (choices: ExportChoices) =>
		JSON.stringify({
			...getChosenOptions({ choices }),
			fps: choices.fpsLabel,
		});
	return effective(a) === effective(b);
}

// The smallest picture offered: below it, encoders refuse or it's no use.
export const MIN_SHORT_SIDE = 16;

function readField({ value, key }: { value: unknown; key: string }): unknown {
	if (typeof value !== "object" || value === null) return undefined;
	const field: unknown = Reflect.get(value, key);
	return field;
}

function isPositiveNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function oneOf<T extends string | number>({
	value,
	values,
}: {
	value: unknown;
	values: readonly T[];
}): T | undefined {
	return values.find((candidate) => candidate === value);
}

/**
 * Choices read back from storage, each field kept if it's still valid and
 * the default otherwise, and the codecs fitted to the container.
 */
export function sanitizeChoices({ value }: { value: unknown }): ExportChoices {
	const defaults = DEFAULT_EXPORT_CHOICES;
	const read = (key: keyof ExportChoices) => readField({ value, key });
	const format =
		oneOf({ value: read("format"), values: EXPORT_FORMAT_VALUES }) ??
		defaults.format;
	const videoCodec =
		oneOf({ value: read("videoCodec"), values: FORMAT_CODECS[format].video }) ??
		FORMAT_CODECS[format].video[0];
	const audioCodec =
		oneOf({ value: read("audioCodec"), values: FORMAT_CODECS[format].audio }) ??
		FORMAT_CODECS[format].audio[0];
	const shortSide = read("shortSide");
	const fpsLabel = read("fpsLabel");
	const videoKbps = read("videoKbps");
	const megabytes = read("megabytes");
	const constantQuality = read("constantQuality");
	const audioKbps = read("audioKbps");
	const hasAudio = read("hasAudio");
	const audioPassthrough = read("audioPassthrough");
	const deinterlace = read("deinterlace");
	return {
		format,
		videoCodec,
		qualityMode:
			oneOf({ value: read("qualityMode"), values: QUALITY_MODES }) ??
			defaults.qualityMode,
		level:
			oneOf({ value: read("level"), values: EXPORT_QUALITY_VALUES }) ??
			defaults.level,
		videoKbps: isPositiveNumber(videoKbps) ? videoKbps : defaults.videoKbps,
		megabytes: isPositiveNumber(megabytes) ? megabytes : defaults.megabytes,
		constantQuality:
			isPositiveNumber(constantQuality) && constantQuality <= 100
				? Math.round(constantQuality)
				: defaults.constantQuality,
		shortSide:
			isPositiveNumber(shortSide) && shortSide >= MIN_SHORT_SIDE
				? shortSide
				: null,
		fpsLabel:
			FRAME_RATE_PRESETS.find((preset) => preset.label === fpsLabel)?.label ??
			null,
		hasAudio: typeof hasAudio === "boolean" ? hasAudio : defaults.hasAudio,
		audioPassthrough:
			typeof audioPassthrough === "boolean"
				? audioPassthrough
				: defaults.audioPassthrough,
		audioCodec,
		audioKbps:
			oneOf({ value: audioKbps, values: AUDIO_BITRATES[audioCodec] }) ??
			DEFAULT_AUDIO_KBPS[audioCodec],
		channels: read("channels") === 1 ? 1 : 2,
		deinterlace:
			typeof deinterlace === "boolean" ? deinterlace : defaults.deinterlace,
		denoise:
			oneOf({ value: read("denoise"), values: FILTER_STRENGTHS }) ??
			defaults.denoise,
		sharpen:
			oneOf({ value: read("sharpen"), values: FILTER_STRENGTHS }) ??
			defaults.sharpen,
	};
}

/** Presets read back from storage: those with a name and an id, their choices sanitized. */
export function sanitizePresets({ value }: { value: unknown }): ExportPreset[] {
	if (!Array.isArray(value)) return [];
	const presets: ExportPreset[] = [];
	for (const item of value) {
		const id: unknown = readField({ value: item, key: "id" });
		const name: unknown = readField({ value: item, key: "name" });
		if (typeof id !== "string" || typeof name !== "string" || !name) continue;
		presets.push({
			id,
			name,
			choices: sanitizeChoices({
				value: readField({ value: item, key: "choices" }),
			}),
		});
	}
	return presets;
}
