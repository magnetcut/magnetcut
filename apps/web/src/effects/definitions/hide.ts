import type { ParamValues } from "@/params";
import type { EffectDefinition } from "@/effects/types";

// The Hide looks (docs/HIDE.md): on an adjustment layer with a mask, a face or
// a plate pixelated or covered. Blur is the Blur effect, as it is elsewhere.

function read({ params, key }: { params: ParamValues; key: string }): number {
	const value = params[key];
	return typeof value === "number"
		? value
		: Number.parseFloat(String(value)) || 0;
}

/** A hex colour as straight RGBA from 0 to 1; black for what isn't one. */
function rgba({ color }: { color: string }): number[] {
	const match = /^#?([0-9a-f]{6})$/i.exec(color.trim());
	if (!match) return [0, 0, 0, 1];
	const value = Number.parseInt(match[1], 16);
	return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
		.map((channel) => channel / 255)
		.concat(1);
}

export const pixelateDefinition: EffectDefinition = {
	type: "pixelate",
	name: "Pixelate",
	category: "hide",
	keywords: ["pixelate", "mosaic", "censor", "hide", "face", "plate"],
	params: [
		{
			key: "size",
			label: "Block size",
			type: "number",
			default: 24,
			min: 4,
			max: 120,
			step: 1,
		},
	],
	renderer: {
		passes: [
			{
				shader: "pixelate",
				uniforms: ({ effectParams: params }) => ({
					u_size: read({ params, key: "size" }),
				}),
			},
		],
	},
};

export const coverDefinition: EffectDefinition = {
	type: "cover",
	name: "Cover",
	category: "hide",
	keywords: ["cover", "black out", "censor", "hide", "redact", "plate"],
	params: [
		{
			key: "color",
			label: "Colour",
			type: "color",
			default: "#000000",
		},
	],
	renderer: {
		passes: [
			{
				shader: "fill",
				uniforms: ({ effectParams: params }) => ({
					u_color: rgba({ color: String(params.color ?? "#000000") }),
				}),
			},
		],
	},
};
