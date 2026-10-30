import type { ParamValues } from "@/params";
import type { EffectDefinition } from "@/effects/types";

// The Adjustment tab's (rust/crates/effects/src/shaders): colour, a vignette
// and sharpening, on a clip or, on an effect track, on all beneath it.

/** A slider from -100 to 100, at 0 until moved. */
function signed({ key, label }: { key: string; label: string }) {
	return {
		key,
		label,
		type: "number" as const,
		default: 0,
		min: -100,
		max: 100,
		step: 1,
	};
}

function read({ params, key }: { params: ParamValues; key: string }): number {
	const value = params[key];
	return typeof value === "number"
		? value
		: Number.parseFloat(String(value)) || 0;
}

export const colorAdjustmentDefinition: EffectDefinition = {
	type: "color-adjust",
	name: "Color",
	category: "adjustment",
	keywords: [
		"color",
		"colour",
		"exposure",
		"contrast",
		"saturation",
		"temperature",
		"hue",
		"grade",
	],
	previewParams: { saturation: 60, contrast: 25 },
	params: [
		signed({ key: "exposure", label: "Exposure" }),
		signed({ key: "contrast", label: "Contrast" }),
		signed({ key: "highlights", label: "Highlights" }),
		signed({ key: "shadows", label: "Shadows" }),
		signed({ key: "saturation", label: "Saturation" }),
		signed({ key: "vibrance", label: "Vibrance" }),
		signed({ key: "temperature", label: "Temperature" }),
		signed({ key: "tint", label: "Tint" }),
		{
			key: "hue",
			label: "Hue",
			type: "number",
			default: 0,
			min: -180,
			max: 180,
			step: 1,
		},
	],
	renderer: {
		passes: [
			{
				shader: "color-adjust",
				uniforms: ({ effectParams: params }) => ({
					u_exposure: read({ params, key: "exposure" }) / 100,
					u_contrast: read({ params, key: "contrast" }) / 100,
					u_highlights: read({ params, key: "highlights" }) / 100,
					u_shadows: read({ params, key: "shadows" }) / 100,
					u_saturation: read({ params, key: "saturation" }) / 100,
					u_vibrance: read({ params, key: "vibrance" }) / 100,
					u_temperature: read({ params, key: "temperature" }) / 100,
					u_tint: read({ params, key: "tint" }) / 100,
					u_hue: read({ params, key: "hue" }),
				}),
			},
		],
	},
};

export const vignetteDefinition: EffectDefinition = {
	type: "vignette",
	name: "Vignette",
	category: "adjustment",
	keywords: ["vignette", "corners", "dark edges"],
	params: [
		{
			key: "amount",
			label: "Amount",
			type: "number",
			default: 50,
			min: 0,
			max: 100,
			step: 1,
		},
		{
			key: "size",
			label: "Size",
			type: "number",
			default: 50,
			min: 0,
			max: 100,
			step: 1,
		},
		{
			key: "softness",
			label: "Softness",
			type: "number",
			default: 50,
			min: 0,
			max: 100,
			step: 1,
		},
	],
	renderer: {
		passes: [
			{
				shader: "vignette",
				uniforms: ({ effectParams: params }) => ({
					u_amount: read({ params, key: "amount" }) / 100,
					u_size: read({ params, key: "size" }) / 100,
					u_softness: read({ params, key: "softness" }) / 100,
				}),
			},
		],
	},
};

export const sharpenDefinition: EffectDefinition = {
	type: "sharpen",
	name: "Sharpen",
	category: "adjustment",
	keywords: ["sharpen", "sharp", "detail", "crisp"],
	params: [
		{
			key: "amount",
			label: "Amount",
			type: "number",
			default: 50,
			min: 0,
			max: 100,
			step: 1,
		},
	],
	renderer: {
		passes: [
			{
				shader: "sharpen",
				// As Export's filter: up to twice the difference from the blur.
				uniforms: ({ effectParams: params }) => ({
					u_amount: (read({ params, key: "amount" }) / 100) * 2,
				}),
			},
		],
	},
};
