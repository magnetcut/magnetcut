import { AudioEffectsChain, type AudioEffectSettings } from "magnetcut-wasm";
import type { ParamValues } from "@/params";
import type { ElementParamDefinition } from "@/params/registry";

/*
 * A clip's sound cleaned up and shaped (docs/AUDIO-EFFECTS.md): the settings
 * are clip parameters, and the chain is the Rust crate's, run on the clip's
 * whole sound in the preview and in the export alike, so the two sound the
 * same.
 */

const HUM_OPTIONS = [
	{ value: "0", label: "Off" },
	{ value: "50", label: "50 Hz (Europe, most of Asia)" },
	{ value: "60", label: "60 Hz (the Americas)" },
];

function number({
	key,
	label,
	default: value,
	min,
	max,
	step,
	dependsOn,
	unit,
}: {
	key: string;
	label: string;
	default: number;
	min: number;
	max: number;
	step: number;
	dependsOn?: string;
	unit?: "percent";
}): ElementParamDefinition {
	return {
		key,
		label,
		type: "number",
		default: value,
		min,
		max,
		step,
		unit,
		keyframable: false,
		dependencies: dependsOn ? [{ param: dependsOn, equals: true }] : undefined,
	};
}

function toggle({
	key,
	label,
}: {
	key: string;
	label: string;
}): ElementParamDefinition {
	return { key, label, type: "boolean", default: false, keyframable: false };
}

/** The settings as clip parameters, by section, in the chain's order. */
export const AUDIO_EFFECT_SECTIONS: {
	key: string;
	title: string;
	hint?: string;
	params: ElementParamDefinition[];
}[] = [
	{
		key: "cleanup",
		title: "Clean up",
		hint: "Reduce noise is made for voices: on music it does harm.",
		params: [
			number({
				key: "noiseReduction",
				label: "Reduce noise",
				default: 0,
				min: 0,
				max: 1,
				step: 0.01,
				unit: "percent",
			}),
			{
				key: "humFrequency",
				label: "Remove hum",
				type: "select",
				default: "0",
				options: HUM_OPTIONS,
				keyframable: false,
			},
			number({
				key: "lowCut",
				label: "Low cut (Hz, 0 is off)",
				default: 0,
				min: 0,
				max: 400,
				step: 1,
			}),
		],
	},
	{
		key: "eq",
		title: "Equaliser",
		params: [
			toggle({ key: "eqEnabled", label: "Equaliser" }),
			...(
				[
					["eqLow", "Low shelf", 100],
					["eqMid1", "Low mids", 400],
					["eqMid2", "Mids", 1500],
					["eqMid3", "High mids", 4000],
					["eqHigh", "High shelf", 10000],
				] as const
			).flatMap(([prefix, name, frequency]) => [
				number({
					key: `${prefix}Gain`,
					label: `${name} (dB)`,
					default: 0,
					min: -24,
					max: 24,
					step: 0.5,
					dependsOn: "eqEnabled",
				}),
				number({
					key: `${prefix}Frequency`,
					label: `${name} (Hz)`,
					default: frequency,
					min: 20,
					max: 20000,
					step: 1,
					dependsOn: "eqEnabled",
				}),
				...(prefix.startsWith("eqMid")
					? [
							number({
								key: `${prefix}Q`,
								label: `${name} width (Q)`,
								default: 1,
								min: 0.1,
								max: 10,
								step: 0.1,
								dependsOn: "eqEnabled",
							}),
						]
					: []),
			]),
		],
	},
	{
		key: "compressor",
		title: "Compressor",
		params: [
			toggle({ key: "compressorEnabled", label: "Compressor" }),
			number({
				key: "compressorThreshold",
				label: "Threshold (dB)",
				default: -20,
				min: -80,
				max: 0,
				step: 0.5,
				dependsOn: "compressorEnabled",
			}),
			number({
				key: "compressorRatio",
				label: "Ratio",
				default: 4,
				min: 1,
				max: 20,
				step: 0.1,
				dependsOn: "compressorEnabled",
			}),
			number({
				key: "compressorAttack",
				label: "Attack (ms)",
				default: 10,
				min: 0.1,
				max: 500,
				step: 0.1,
				dependsOn: "compressorEnabled",
			}),
			number({
				key: "compressorRelease",
				label: "Release (ms)",
				default: 150,
				min: 1,
				max: 3000,
				step: 1,
				dependsOn: "compressorEnabled",
			}),
			number({
				key: "compressorMakeup",
				label: "Makeup (dB)",
				default: 0,
				min: -30,
				max: 30,
				step: 0.5,
				dependsOn: "compressorEnabled",
			}),
		],
	},
	{
		key: "echo",
		title: "Echo",
		params: [
			toggle({ key: "echoEnabled", label: "Echo" }),
			number({
				key: "echoDelay",
				label: "Delay (ms)",
				default: 300,
				min: 1,
				max: 2000,
				step: 1,
				dependsOn: "echoEnabled",
			}),
			number({
				key: "echoFeedback",
				label: "Feedback",
				default: 0.35,
				min: 0,
				max: 0.95,
				step: 0.01,
				unit: "percent",
				dependsOn: "echoEnabled",
			}),
			number({
				key: "echoMix",
				label: "Mix",
				default: 0.3,
				min: 0,
				max: 1,
				step: 0.01,
				unit: "percent",
				dependsOn: "echoEnabled",
			}),
		],
	},
	{
		key: "reverb",
		title: "Reverb",
		params: [
			toggle({ key: "reverbEnabled", label: "Reverb" }),
			...(
				[
					["reverbRoomSize", "Room size", 0.5],
					["reverbDamping", "Damping", 0.5],
					["reverbWidth", "Width", 1],
					["reverbMix", "Mix", 0.25],
				] as const
			).map(([key, label, value]) =>
				number({
					key,
					label,
					default: value,
					min: 0,
					max: 1,
					step: 0.01,
					unit: "percent",
					dependsOn: "reverbEnabled",
				}),
			),
		],
	},
];

export const AUDIO_EFFECT_PARAMS: ElementParamDefinition[] =
	AUDIO_EFFECT_SECTIONS.flatMap(({ params }) => params);

/** The presets above the sections: each sets every setting, Off back to none. */
export const AUDIO_EFFECT_PRESETS: {
	key: string;
	name: string;
	values: ParamValues;
}[] = [
	{ key: "off", name: "Off", values: {} },
	{
		key: "voice",
		name: "Voice",
		values: {
			noiseReduction: 0.8,
			lowCut: 80,
			eqEnabled: true,
			eqMid1Gain: -1.5,
			eqMid3Gain: 3,
			compressorEnabled: true,
			compressorThreshold: -24,
			compressorRatio: 3,
			compressorMakeup: 3,
		},
	},
	{
		key: "podcast",
		name: "Podcast",
		values: {
			noiseReduction: 0.6,
			lowCut: 90,
			eqEnabled: true,
			eqLowGain: 2,
			eqLowFrequency: 120,
			eqMid1Gain: -2.5,
			eqMid3Gain: 3,
			eqMid3Frequency: 5000,
			compressorEnabled: true,
			compressorThreshold: -20,
			compressorRatio: 4,
			compressorMakeup: 4,
		},
	},
	{
		key: "phone",
		name: "Phone call",
		values: {
			lowCut: 300,
			eqEnabled: true,
			eqMid2Gain: 6,
			eqHighGain: -24,
			eqHighFrequency: 3400,
			compressorEnabled: true,
			compressorThreshold: -30,
			compressorRatio: 6,
			compressorMakeup: 6,
		},
	},
	{
		key: "hall",
		name: "Hall",
		values: {
			reverbEnabled: true,
			reverbRoomSize: 0.85,
			reverbDamping: 0.3,
			reverbMix: 0.3,
		},
	},
];

/** A clip's parameters with a preset's settings: every effect setting reset first. */
export function applyAudioEffectPreset({
	params,
	preset,
}: {
	params: ParamValues;
	preset: (typeof AUDIO_EFFECT_PRESETS)[number];
}): ParamValues {
	const next: ParamValues = { ...params };
	for (const param of AUDIO_EFFECT_PARAMS) delete next[param.key];
	return { ...next, ...preset.values };
}

/**
 * The chain's settings from a clip's parameters: null when every effect is
 * off, and the clip's sound is played as it is.
 */
export function readAudioEffects({
	params,
}: {
	params: ParamValues | undefined;
}): AudioEffectSettings | null {
	if (!params) return null;
	const settings: Record<string, number | boolean> = {};
	for (const param of AUDIO_EFFECT_PARAMS) {
		const value = params[param.key];
		if (param.type === "select") {
			const parsed = Number(value);
			if (Number.isFinite(parsed)) settings[param.key] = parsed;
		} else if (typeof value === "number" || typeof value === "boolean") {
			settings[param.key] = value;
		}
	}
	const isOn = (key: string) => settings[key] === true;
	const isAbove = (key: string) => {
		const value = settings[key];
		return typeof value === "number" && value > 0;
	};
	const isActive =
		isAbove("noiseReduction") ||
		isAbove("humFrequency") ||
		isAbove("lowCut") ||
		isOn("eqEnabled") ||
		isOn("compressorEnabled") ||
		isOn("echoEnabled") ||
		isOn("reverbEnabled");
	return isActive ? settings : null;
}

// Processed a second at a time, the page given a turn between.
const BLOCK_SECONDS = 1;
// Echo and reverb are cut at the clip's end: faded out over this, not clicked off.
const TAIL_FADE_SECONDS = 0.02;

const yieldToPage = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A clip's sound through the chain: as long as it was, lined up with it (the
 * chain's latency taken out), a block at a time.
 */
export async function applyAudioEffectsToBuffer({
	context,
	buffer,
	settings,
}: {
	context: BaseAudioContext;
	buffer: AudioBuffer;
	settings: AudioEffectSettings;
}): Promise<AudioBuffer> {
	const { length, numberOfChannels, sampleRate } = buffer;
	const chain = new AudioEffectsChain(settings, sampleRate, numberOfChannels);
	try {
		if (chain.isIdentity) return buffer;
		const latency = chain.latency;
		const output = context.createBuffer(numberOfChannels, length, sampleRate);
		const inputs = Array.from({ length: numberOfChannels }, (_, channel) =>
			buffer.getChannelData(channel),
		);
		const outputs = Array.from({ length: numberOfChannels }, (_, channel) =>
			output.getChannelData(channel),
		);
		const block = Math.max(1, Math.round(sampleRate * BLOCK_SECONDS));
		// Silence after the sound, as long as the latency, so its end comes out.
		const total = length + latency;
		let written = -latency;
		for (let start = 0; start < total; start += block) {
			const end = Math.min(total, start + block);
			const pieces = inputs.map((data) => {
				if (end <= length) return data.slice(start, end);
				const piece = new Float32Array(end - start);
				if (start < length) piece.set(data.subarray(start, length));
				return piece;
			});
			const processed = chain.process(pieces);
			const count = end - start;
			for (let channel = 0; channel < numberOfChannels; channel++) {
				const data = processed[channel];
				const from = Math.max(0, -written);
				const to = Math.min(count, length - written);
				if (to > from) {
					outputs[channel].set(data.subarray(from, to), written + from);
				}
			}
			written += count;
			await yieldToPage();
		}
		if (settings.echoEnabled === true || settings.reverbEnabled === true) {
			const fade = Math.min(length, Math.round(sampleRate * TAIL_FADE_SECONDS));
			for (const data of outputs) {
				for (let index = 0; index < fade; index++) {
					data[length - fade + index] *= 1 - (index + 1) / fade;
				}
			}
		}
		return output;
	} finally {
		chain.free();
	}
}
