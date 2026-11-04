import { describe, expect, test } from "bun:test";
import {
	AUDIO_EFFECT_PARAMS,
	AUDIO_EFFECT_PRESETS,
	applyAudioEffectPreset,
	applyAudioEffectsToBuffer,
	readAudioEffects,
} from "../audio-effects";
import { getEqResponse } from "../eq-curve";

/** Just enough of an AudioBuffer and its context for the chain. */
class FakeBuffer {
	readonly length: number;
	readonly numberOfChannels: number;
	readonly sampleRate: number;
	private readonly data: Float32Array[];

	constructor({
		channels,
		length,
		sampleRate,
	}: {
		channels: number;
		length: number;
		sampleRate: number;
	}) {
		this.length = length;
		this.numberOfChannels = channels;
		this.sampleRate = sampleRate;
		this.data = Array.from(
			{ length: channels },
			() => new Float32Array(length),
		);
	}

	getChannelData(channel: number): Float32Array {
		return this.data[channel];
	}
}

/** A stand-in with only what the chain reads: bun has no Web Audio. */
function toAudioBuffer(buffer: FakeBuffer): AudioBuffer {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- as above.
	return buffer as unknown as AudioBuffer;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- as above.
const context = {
	// eslint-disable-next-line magnetcut/prefer-object-params -- Web Audio's own signature.
	createBuffer: (channels: number, length: number, sampleRate: number) =>
		toAudioBuffer(new FakeBuffer({ channels, length, sampleRate })),
} as unknown as BaseAudioContext;

function makeSine({
	frequency,
	seconds,
	sampleRate = 48000,
}: {
	frequency: number;
	seconds: number;
	sampleRate?: number;
}): AudioBuffer {
	const buffer = new FakeBuffer({
		channels: 2,
		length: Math.round(seconds * sampleRate),
		sampleRate,
	});
	for (let channel = 0; channel < 2; channel++) {
		const data = buffer.getChannelData(channel);
		for (let index = 0; index < data.length; index++) {
			data[index] =
				0.5 * Math.sin((2 * Math.PI * frequency * index) / sampleRate);
		}
	}
	return toAudioBuffer(buffer);
}

function rms({
	data,
	from = 0,
}: {
	data: Float32Array;
	from?: number;
}): number {
	let sum = 0;
	for (let index = from; index < data.length; index++) sum += data[index] ** 2;
	return Math.sqrt(sum / (data.length - from));
}

describe("a clip's effect settings", () => {
	test("are none until one is on", () => {
		expect(readAudioEffects({ params: { volume: -3 } })).toBeNull();
		expect(
			readAudioEffects({ params: { eqEnabled: false, eqLowGain: 6 } }),
		).toBeNull();
		expect(readAudioEffects({ params: { humFrequency: "50" } })).toEqual({
			humFrequency: 50,
		});
		expect(readAudioEffects({ params: { lowCut: 80, muted: false } })).toEqual({
			lowCut: 80,
		});
	});

	test("are each a parameter the chain knows, once", () => {
		const keys = AUDIO_EFFECT_PARAMS.map(({ key }) => key);
		expect(new Set(keys).size).toBe(keys.length);
		for (const preset of AUDIO_EFFECT_PRESETS) {
			for (const key of Object.keys(preset.values)) expect(keys).toContain(key);
		}
	});

	test("a preset replaces the effects, and keeps the rest", () => {
		const [off, voice] = AUDIO_EFFECT_PRESETS;
		const params = { volume: -6, reverbEnabled: true, reverbMix: 0.8 };
		const voiced = applyAudioEffectPreset({ params, preset: voice });
		expect(voiced.volume).toBe(-6);
		expect(voiced.reverbEnabled).toBeUndefined();
		expect(voiced.noiseReduction).toBe(0.8);
		expect(applyAudioEffectPreset({ params: voiced, preset: off })).toEqual({
			volume: -6,
		});
	});
});

describe("the chain on a clip's sound", () => {
	test("a low cut takes out a low hum and keeps a voice's frequencies", async () => {
		const low = makeSine({ frequency: 40, seconds: 2 });
		const high = makeSine({ frequency: 1000, seconds: 2 });
		const settings = { lowCut: 200 };
		const [cutLow, cutHigh] = await Promise.all([
			applyAudioEffectsToBuffer({ context, buffer: low, settings }),
			applyAudioEffectsToBuffer({ context, buffer: high, settings }),
		]);
		expect(cutLow.length).toBe(low.length);
		const from = 4800;
		expect(rms({ data: cutLow.getChannelData(0), from })).toBeLessThan(
			rms({ data: low.getChannelData(0), from }) / 30,
		);
		expect(rms({ data: cutHigh.getChannelData(1), from })).toBeCloseTo(
			rms({ data: high.getChannelData(1), from }),
			2,
		);
	});

	test("noise reduction's delay is taken out: the sound stays where it was", async () => {
		const sampleRate = 48000;
		const buffer = new FakeBuffer({
			channels: 1,
			length: sampleRate,
			sampleRate,
		});
		// A click at half a second, through the chain at half strength.
		buffer.getChannelData(0)[sampleRate / 2] = 1;
		const output = await applyAudioEffectsToBuffer({
			context,
			buffer: toAudioBuffer(buffer),
			settings: { noiseReduction: 0.5 },
		});
		const data = output.getChannelData(0);
		let peak = 0;
		for (let index = 1; index < data.length; index++) {
			if (Math.abs(data[index]) > Math.abs(data[peak])) peak = index;
		}
		expect(Math.abs(peak - sampleRate / 2)).toBeLessThan(48);
	});
});

describe("the equaliser's curve", () => {
	test("shows each band where it is", () => {
		const [low, mid, high] = getEqResponse({
			params: { eqMid2Gain: 6, eqMid2Frequency: 1000 },
			frequencies: [20, 1000, 18000],
		});
		expect(mid).toBeCloseTo(6, 1);
		expect(Math.abs(low)).toBeLessThan(0.1);
		expect(Math.abs(high)).toBeLessThan(0.1);
		const [shelfLow, , shelfHigh] = getEqResponse({
			params: { eqLowGain: -9 },
			frequencies: [20, 1000, 18000],
		});
		expect(shelfLow).toBeCloseTo(-9, 0);
		expect(Math.abs(shelfHigh)).toBeLessThan(0.1);
	});
});
