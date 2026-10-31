// The timeline's sound, measured for an agent (docs/AUTOMATION.md): where
// it's silent, and how loud it is as ITU-R BS.1770 measures it (integrated
// loudness, in LUFS, the measure streaming sites even sound out to), and its
// peak.

/** A stretch of the sound, in seconds. */
export interface Stretch {
	from: number;
	to: number;
}

// The window silences are found in.
const WINDOW_SECONDS = 0.05;

/** Where the sound stays under `thresholdDb` (dBFS, of each window's RMS,
 * channels mixed) for `minSeconds` or longer. */
export function findSilences({
	channels,
	sampleRate,
	thresholdDb,
	minSeconds,
}: {
	channels: Float32Array[];
	sampleRate: number;
	thresholdDb: number;
	minSeconds: number;
}): Stretch[] {
	const length = channels[0]?.length ?? 0;
	const window = Math.max(1, Math.round(WINDOW_SECONDS * sampleRate));
	const threshold = 10 ** (thresholdDb / 20);
	const silences: Stretch[] = [];
	let start: number | null = null;
	for (let at = 0; at < length; at += window) {
		const end = Math.min(length, at + window);
		let sum = 0;
		for (const channel of channels) {
			for (let i = at; i < end; i++) sum += channel[i] * channel[i];
		}
		const rms = Math.sqrt(sum / ((end - at) * channels.length));
		if (rms < threshold) {
			start ??= at;
		} else if (start !== null) {
			silences.push({ from: start / sampleRate, to: at / sampleRate });
			start = null;
		}
	}
	if (start !== null)
		silences.push({ from: start / sampleRate, to: length / sampleRate });
	return silences.filter((stretch) => stretch.to - stretch.from >= minSeconds);
}

interface Biquad {
	b: [number, number, number];
	a: [number, number];
}

/** BS.1770's K-weighting at `sampleRate`: a high shelf (the head's effect),
 * then a high-pass. Brecht De Man's design, which gives the spec's own
 * coefficients at 48 kHz and the same curve at any other rate. */
function kWeighting({ sampleRate }: { sampleRate: number }): Biquad[] {
	const shelf = (() => {
		const gain = 3.999843853973347;
		const q = 0.7071752369554196;
		const fc = 1681.974450955533;
		const K = Math.tan((Math.PI * fc) / sampleRate);
		const Vh = 10 ** (gain / 20);
		const Vb = Vh ** 0.4996667741545416;
		const a0 = 1 + K / q + K * K;
		return {
			b: [
				(Vh + (Vb * K) / q + K * K) / a0,
				(2 * (K * K - Vh)) / a0,
				(Vh - (Vb * K) / q + K * K) / a0,
			],
			a: [(2 * (K * K - 1)) / a0, (1 - K / q + K * K) / a0],
		} satisfies Biquad;
	})();
	const highPass = (() => {
		const q = 0.5003270373238773;
		const fc = 38.13547087602444;
		const K = Math.tan((Math.PI * fc) / sampleRate);
		const a0 = 1 + K / q + K * K;
		return {
			b: [1, -2, 1],
			a: [(2 * (K * K - 1)) / a0, (1 - K / q + K * K) / a0],
		} satisfies Biquad;
	})();
	return [shelf, highPass];
}

function filter({
	samples,
	stages,
}: {
	samples: Float32Array;
	stages: Biquad[];
}): Float64Array {
	let input = Float64Array.from(samples);
	for (const { b, a } of stages) {
		const output = new Float64Array(input.length);
		let [x1, x2, y1, y2] = [0, 0, 0, 0];
		for (let i = 0; i < input.length; i++) {
			const x = input[i];
			const y = b[0] * x + b[1] * x1 + b[2] * x2 - a[0] * y1 - a[1] * y2;
			output[i] = y;
			[x2, x1, y2, y1] = [x1, x, y1, y];
		}
		input = output;
	}
	return input;
}

/** Integrated loudness (LUFS) of left and right (or one) channels: 400 ms
 * blocks every 100 ms, gated at -70 LUFS, then 10 LU under their mean. Null
 * for silence. */
export function integratedLoudness({
	channels,
	sampleRate,
}: {
	channels: Float32Array[];
	sampleRate: number;
}): number | null {
	const weighted = channels.map((samples) =>
		filter({ samples, stages: kWeighting({ sampleRate }) }),
	);
	const block = Math.round(0.4 * sampleRate);
	const step = Math.round(0.1 * sampleRate);
	const length = weighted[0]?.length ?? 0;
	const powers: number[] = [];
	for (let at = 0; at + block <= length; at += step) {
		let power = 0;
		for (const samples of weighted) {
			let sum = 0;
			for (let i = at; i < at + block; i++) sum += samples[i] * samples[i];
			power += sum / block;
		}
		powers.push(power);
	}
	const loudness = (power: number) => -0.691 + 10 * Math.log10(power);
	const mean = (values: number[]) =>
		values.reduce((sum, value) => sum + value, 0) / values.length;
	const absolute = powers.filter((power) => loudness(power) > -70);
	if (absolute.length === 0) return null;
	const relative = loudness(mean(absolute)) - 10;
	const gated = absolute.filter((power) => loudness(power) > relative);
	return gated.length === 0 ? null : loudness(mean(gated));
}

/** The highest sample, in dBFS; null for silence. */
export function samplePeak({
	channels,
}: {
	channels: Float32Array[];
}): number | null {
	let peak = 0;
	for (const samples of channels) {
		for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
	}
	return peak > 0 ? 20 * Math.log10(peak) : null;
}
