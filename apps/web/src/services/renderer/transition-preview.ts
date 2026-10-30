import { createCanvasSurface } from "./canvas-utils";
import { gpuRenderer, initializeGpuRenderer } from "./gpu-renderer";
import type { TransitionDefinition } from "@/transitions";

// 16:9, sharp at twice the thumbnails' size.
const PREVIEW_WIDTH = 224;
const PREVIEW_HEIGHT = 126;
const PREVIEW_IMAGE_PATH = "/effects/preview.jpg";

interface SampleImages {
	from: OffscreenCanvas;
	to: OffscreenCanvas;
}

function loadImage({ src }: { src: string }): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const image = new Image();
		image.onload = () => resolve(image);
		image.onerror = () => reject(new Error(`Failed to load ${src}`));
		image.src = src;
	});
}

/** The image cropped to fill the preview, mirrored and tinted if asked. */
function drawSample({
	image,
	mirrored,
	tint,
}: {
	image: HTMLImageElement;
	mirrored: boolean;
	tint: string;
}): OffscreenCanvas {
	const { canvas, context } = createCanvasSurface({
		width: PREVIEW_WIDTH,
		height: PREVIEW_HEIGHT,
	});
	const scale = Math.max(
		PREVIEW_WIDTH / image.naturalWidth,
		PREVIEW_HEIGHT / image.naturalHeight,
	);
	const width = image.naturalWidth * scale;
	const height = image.naturalHeight * scale;
	if (mirrored) {
		context.translate(PREVIEW_WIDTH, 0);
		context.scale(-1, 1);
	}
	context.drawImage(
		image,
		(PREVIEW_WIDTH - width) / 2,
		(PREVIEW_HEIGHT - height) / 2,
		width,
		height,
	);
	context.setTransform(1, 0, 0, 1, 0, 0);
	context.globalCompositeOperation = "color";
	context.fillStyle = tint;
	context.fillRect(0, 0, PREVIEW_WIDTH, PREVIEW_HEIGHT);
	return canvas;
}

/** The catalogue's thumbnails: each transition between two sample images. */
class TransitionPreviewService {
	private samples: SampleImages | null = null;
	private loading: Promise<void> | null = null;

	ready(): Promise<void> {
		this.loading ??= Promise.all([
			initializeGpuRenderer(),
			loadImage({ src: PREVIEW_IMAGE_PATH }),
		]).then(([, image]) => {
			this.samples = {
				from: drawSample({ image, mirrored: false, tint: "#e8a33d" }),
				to: drawSample({ image, mirrored: true, tint: "#3d7fe8" }),
			};
		});
		return this.loading;
	}

	render({
		definition,
		progress,
		target,
	}: {
		definition: TransitionDefinition;
		progress: number;
		target: HTMLCanvasElement;
	}): void {
		const context = target.getContext("2d");
		if (!context || !this.samples) return;
		target.width = PREVIEW_WIDTH;
		target.height = PREVIEW_HEIGHT;
		const { from, to } = this.samples;

		let result: OffscreenCanvas | null = null;
		try {
			result = gpuRenderer.applyTransition({
				from,
				to,
				width: PREVIEW_WIDTH,
				height: PREVIEW_HEIGHT,
				transition: definition.shader,
				params: definition.params,
				progress,
			});
		} catch (error) {
			console.warn("Failed to render transition preview", {
				type: definition.id,
				error,
			});
		}

		if (result) {
			context.drawImage(result, 0, 0);
			return;
		}
		// Without a GPU, a plain dissolve.
		context.drawImage(from, 0, 0);
		context.globalAlpha = progress;
		context.drawImage(to, 0, 0);
		context.globalAlpha = 1;
	}
}

export const transitionPreviewService = new TransitionPreviewService();
