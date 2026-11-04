import type { ParamValues } from "@/params";

/*
 * The equaliser's response, for the curve drawn over the frequencies: the
 * same bands as the Rust chain (rust/crates/audio, biquad.rs), from the Audio
 * EQ Cookbook, a low shelf, three peaks and a high shelf.
 */

export const EQ_BANDS = [
	{ prefix: "eqLow", kind: "lowShelf", frequency: 100, name: "Low shelf" },
	{ prefix: "eqMid1", kind: "peak", frequency: 400, name: "Low mids" },
	{ prefix: "eqMid2", kind: "peak", frequency: 1500, name: "Mids" },
	{ prefix: "eqMid3", kind: "peak", frequency: 4000, name: "High mids" },
	{ prefix: "eqHigh", kind: "highShelf", frequency: 10000, name: "High shelf" },
] as const;

export type EqBand = (typeof EQ_BANDS)[number];

const SAMPLE_RATE = 48000;

interface Biquad {
	b0: number;
	b1: number;
	b2: number;
	a0: number;
	a1: number;
	a2: number;
}

function read({
	params,
	key,
	fallback,
}: {
	params: ParamValues;
	key: string;
	fallback: number;
}): number {
	const value = params[key];
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function design({
	kind,
	gain,
	frequency,
	q,
}: {
	kind: EqBand["kind"];
	gain: number;
	frequency: number;
	q: number;
}): Biquad {
	const a = 10 ** (gain / 40);
	const w0 =
		(2 * Math.PI * Math.min(frequency, SAMPLE_RATE * 0.45)) / SAMPLE_RATE;
	const cos = Math.cos(w0);
	const sin = Math.sin(w0);
	if (kind === "peak") {
		const alpha = sin / (2 * q);
		return {
			b0: 1 + alpha * a,
			b1: -2 * cos,
			b2: 1 - alpha * a,
			a0: 1 + alpha / a,
			a1: -2 * cos,
			a2: 1 - alpha / a,
		};
	}
	// Shelves with a slope of 1.
	const alpha = (sin / 2) * Math.SQRT2;
	const root = 2 * Math.sqrt(a) * alpha;
	const sign = kind === "lowShelf" ? 1 : -1;
	return {
		b0: a * (a + 1 - sign * (a - 1) * cos + root),
		b1: sign * 2 * a * (a - 1 - sign * (a + 1) * cos),
		b2: a * (a + 1 - sign * (a - 1) * cos - root),
		a0: a + 1 + sign * (a - 1) * cos + root,
		a1: -sign * 2 * (a - 1 + sign * (a + 1) * cos),
		a2: a + 1 + sign * (a - 1) * cos - root,
	};
}

/** A biquad's gain at a frequency, in dB. */
function gainAt({
	filter,
	frequency,
}: {
	filter: Biquad;
	frequency: number;
}): number {
	const w = (2 * Math.PI * frequency) / SAMPLE_RATE;
	const [c1, s1, c2, s2] = [
		Math.cos(w),
		Math.sin(w),
		Math.cos(2 * w),
		Math.sin(2 * w),
	];
	const numeratorRe = filter.b0 + filter.b1 * c1 + filter.b2 * c2;
	const numeratorIm = -(filter.b1 * s1 + filter.b2 * s2);
	const denominatorRe = filter.a0 + filter.a1 * c1 + filter.a2 * c2;
	const denominatorIm = -(filter.a1 * s1 + filter.a2 * s2);
	const magnitude = Math.sqrt(
		(numeratorRe ** 2 + numeratorIm ** 2) /
			(denominatorRe ** 2 + denominatorIm ** 2),
	);
	return 20 * Math.log10(magnitude);
}

/**
 * The equaliser's gain in dB at each frequency, from a clip's parameters: of
 * every band, or of the one with this prefix.
 */
export function getEqResponse({
	params,
	frequencies,
	only,
}: {
	params: ParamValues;
	frequencies: readonly number[];
	only?: EqBand["prefix"];
}): number[] {
	const bands = only
		? EQ_BANDS.filter(({ prefix }) => prefix === only)
		: EQ_BANDS;
	const filters = bands
		.map(({ prefix, kind, frequency }) => ({
			gain: read({ params, key: `${prefix}Gain`, fallback: 0 }),
			filter: design({
				kind,
				gain: read({ params, key: `${prefix}Gain`, fallback: 0 }),
				frequency: read({
					params,
					key: `${prefix}Frequency`,
					fallback: frequency,
				}),
				q: Math.max(0.05, read({ params, key: `${prefix}Q`, fallback: 1 })),
			}),
		}))
		.filter(({ gain }) => Math.abs(gain) >= 0.01);
	return frequencies.map((frequency) =>
		filters.reduce((sum, { filter }) => sum + gainAt({ filter, frequency }), 0),
	);
}

/** Frequencies spaced evenly on a log scale, from 20 Hz to 20 kHz. */
export function listCurveFrequencies({ count }: { count: number }): number[] {
	return Array.from(
		{ length: count },
		(_, index) => 20 * 1000 ** (index / Math.max(1, count - 1)),
	);
}
