import type { FrameRate } from "magnetcut-wasm";
import type { AnyBaseNode } from "./nodes/base-node";
import { createCanvasSurface } from "./canvas-utils";
import type { FilterPasses } from "@/export/filters";
import { buildFrameDescriptor } from "./compositor/frame-descriptor";
import { wasmCompositor } from "./compositor/wasm-compositor";
import { resolveRenderTree } from "./resolve";
import {
	measureSpanAsync,
	measureSpanSync,
	onRenderPerfFrameComplete,
} from "@/diagnostics/render-perf";

export type CanvasRendererParams = {
	width: number;
	height: number;
	fps: FrameRate;
	/** The preview's: what it draws is shown, also after frames drawn for others. */
	isPreview?: boolean;
};

export class CanvasRenderer {
	canvas: OffscreenCanvas;
	context: OffscreenCanvasRenderingContext2D;
	width: number;
	height: number;
	fps: FrameRate;
	readonly isPreview: boolean;

	constructor({ width, height, fps, isPreview = false }: CanvasRendererParams) {
		this.width = width;
		this.height = height;
		this.fps = fps;
		this.isPreview = isPreview;

		const surface = createCanvasSurface({ width, height });
		this.canvas = surface.canvas;
		this.context = surface.context;
	}

	getOutputCanvas(): HTMLCanvasElement {
		wasmCompositor.ensureInitialized({
			width: this.width,
			height: this.height,
		});
		return wasmCompositor.getCanvas();
	}

	/** Shown over the output canvas while it holds frames drawn for others. */
	getHoldCover(): HTMLCanvasElement {
		return wasmCompositor.getHoldCover();
	}

	/** Whether the preview should draw its frame again: frames drawn for others have stopped. */
	shouldRedrawHeld(): boolean {
		return wasmCompositor.isHoldSettled();
	}

	setSize({ width, height }: { width: number; height: number }) {
		this.width = width;
		this.height = height;

		const surface = createCanvasSurface({ width, height });
		this.canvas = surface.canvas;
		this.context = surface.context;
	}

	async render({
		node,
		time,
		filters,
		isForOthers = false,
	}: {
		node: AnyBaseNode;
		time: number;
		/** Export's, on each video and on the frame. */
		filters?: FilterPasses;
		/** Not to be seen in the preview, which holds its own frame meanwhile. */
		isForOthers?: boolean;
	}) {
		await measureSpanAsync({
			name: "resolve",
			fn: () => resolveRenderTree({ node, renderer: this, time }),
		});
		const { frame, textures } = await measureSpanAsync({
			name: "buildFrame",
			fn: () => buildFrameDescriptor({ node, renderer: this, filters }),
		});
		// From here to the frame drawn, nothing waits: the preview's canvas is
		// hidden, or shown again, along with what's drawn into it.
		if (isForOthers) wasmCompositor.holdOutput();
		wasmCompositor.ensureInitialized({
			width: this.width,
			height: this.height,
		});
		measureSpanSync({
			name: "syncTextures",
			fn: () => wasmCompositor.syncTextures(textures),
		});
		measureSpanSync({
			name: "renderFrame",
			fn: () => wasmCompositor.render(frame),
		});
		if (this.isPreview) wasmCompositor.releaseOutput();
	}

	async renderToCanvas({
		node,
		time,
		targetCanvas,
	}: {
		node: AnyBaseNode;
		time: number;
		targetCanvas: HTMLCanvasElement;
	}) {
		await this.render({ node, time, isForOthers: true });

		const ctx = targetCanvas.getContext("2d");
		if (!ctx) {
			throw new Error("Failed to get target canvas context");
		}

		measureSpanSync({
			name: "drawImage",
			fn: () =>
				ctx.drawImage(
					wasmCompositor.getCanvas(),
					0,
					0,
					targetCanvas.width,
					targetCanvas.height,
				),
		});
		onRenderPerfFrameComplete();
	}
}
