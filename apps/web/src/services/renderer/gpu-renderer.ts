import {
	applyEffectPasses,
	applyMaskFeather as applyMaskFeatherWasm,
	applyTransition as applyTransitionWasm,
	initializeGpu,
} from "magnetcut-wasm";
import type { EffectPass, EffectUniformValue } from "@/effects/types";
import type { TransitionParamValue } from "@/timeline";

let gpuAvailable = false;
let initPromise: Promise<void> | null = null;

export function initializeGpuRenderer(): Promise<void> {
	if (!initPromise) {
		initPromise = initializeGpu()
			.then(() => {
				gpuAvailable = true;
			})
			.catch((error: unknown) => {
				gpuAvailable = false;
				const message = error instanceof Error ? error.message : String(error);
				console.warn(`GPU renderer unavailable: ${message}`);
			});
	}
	return initPromise;
}

export function isGpuAvailable(): boolean {
	return gpuAvailable;
}

export const gpuRenderer = {
	applyEffect({
		source,
		width,
		height,
		passes,
	}: {
		source: OffscreenCanvas;
		width: number;
		height: number;
		passes: EffectPass[];
	}): OffscreenCanvas {
		if (passes.length === 0 || !gpuAvailable) {
			return source;
		}

		return applyEffectPasses({
			source,
			width,
			height,
			passes: serializeEffectPasses(passes),
		});
	},

	applyMaskFeather({
		maskCanvas,
		width,
		height,
		feather,
	}: {
		maskCanvas: OffscreenCanvas;
		width: number;
		height: number;
		feather: number;
	}): OffscreenCanvas {
		if (!gpuAvailable) {
			return maskCanvas;
		}

		return applyMaskFeatherWasm({
			mask: maskCanvas,
			width,
			height,
			feather,
		});
	},

	/** A gl-transitions shader between two images; null without a GPU. */
	applyTransition({
		from,
		to,
		width,
		height,
		transition,
		params,
		progress,
	}: {
		from: OffscreenCanvas;
		to: OffscreenCanvas;
		width: number;
		height: number;
		transition: string;
		params: Record<string, TransitionParamValue>;
		progress: number;
	}): OffscreenCanvas | null {
		if (!gpuAvailable) {
			return null;
		}

		return applyTransitionWasm({
			from,
			to,
			width,
			height,
			transition,
			params,
			progress,
		});
	},
};

function serializeEffectPasses(passes: EffectPass[]) {
	return passes.map((pass) => ({
		shader: pass.shader,
		uniforms: Object.entries(pass.uniforms).map(([name, value]) => ({
			name,
			value: normalizeUniformValue(value),
		})),
	}));
}

function normalizeUniformValue(value: EffectUniformValue): number[] {
	return typeof value === "number" ? [value] : value;
}
