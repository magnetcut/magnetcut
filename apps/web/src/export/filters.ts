import type { EffectPass } from "@/effects/types";

// Export's filters, as HandBrake has them (docs/NATIVE.md, phase 6): passes
// of the compositor's (rust/crates/effects), on each video as it is before
// it's placed (deinterlace, denoise) and on the frame (sharpen).

export const FILTER_STRENGTHS = ["off", "light", "medium", "strong"] as const;
export type FilterStrength = (typeof FILTER_STRENGTHS)[number];

export interface ExportFilters {
	/** The top field kept, the bottom one made from it. */
	deinterlace: boolean;
	denoise: FilterStrength;
	sharpen: FilterStrength;
}

export const NO_FILTERS: ExportFilters = {
	deinterlace: false,
	denoise: "off",
	sharpen: "off",
};

/** The passes for the filters chosen: none for those off. */
export interface FilterPasses {
	/** On each video's own picture, before it's placed. */
	source: EffectPass[][];
	/** On the whole frame. */
	frame: EffectPass[][];
}

// A bilateral filter's reach, in pixels, and how different a colour may be
// and still count as the same: wider than the grain, narrower than an edge.
const DENOISE: Record<Exclude<FilterStrength, "off">, [number, number]> = {
	light: [1, 0.06],
	medium: [1.5, 0.1],
	strong: [2.5, 0.16],
};

// How far unsharp masking pushes each pixel from its neighbours' blur.
const SHARPEN: Record<Exclude<FilterStrength, "off">, number> = {
	light: 0.5,
	medium: 1,
	strong: 1.8,
};

export function buildFilterPasses({
	filters,
}: {
	filters: ExportFilters;
}): FilterPasses {
	const source: EffectPass[] = [];
	if (filters.deinterlace) {
		source.push({ shader: "deinterlace", uniforms: { u_field: 0 } });
	}
	if (filters.denoise !== "off") {
		const [spatial, range] = DENOISE[filters.denoise];
		source.push({
			shader: "denoise",
			uniforms: { u_spatial: spatial, u_range: range },
		});
	}
	const frame: EffectPass[] =
		filters.sharpen === "off"
			? []
			: [
					{
						shader: "sharpen",
						uniforms: { u_amount: SHARPEN[filters.sharpen] },
					},
				];
	return {
		source: source.length > 0 ? [source] : [],
		frame: frame.length > 0 ? [frame] : [],
	};
}

export function hasFilters({ filters }: { filters: ExportFilters }): boolean {
	return (
		filters.deinterlace ||
		filters.denoise !== "off" ||
		filters.sharpen !== "off"
	);
}
