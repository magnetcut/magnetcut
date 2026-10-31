import type { EditorCore } from "@/core";
import { CanvasRenderer } from "@/services/renderer/canvas-renderer";
import { buildScene } from "@/services/renderer/scene-builder";
import { TICKS_PER_SECOND } from "@/wasm";

// Where the picture cuts from one shot to another (docs/AUTOMATION.md): the
// timeline drawn small, frame by frame, each frame's brightness histogram
// against the last's; a cut is a change far bigger than those around it.

const BINS = 32;
// The frames compared: this wide.
const WIDTH = 96;
// Frames either side whose changes a cut must stand out from.
const NEIGHBOURS = 6;

/** A frame's brightness, as shares of its pixels in each of `BINS` bins. */
export function histogram({ rgba }: { rgba: Uint8ClampedArray }): number[] {
	const bins = new Array<number>(BINS).fill(0);
	const pixels = rgba.length / 4;
	for (let i = 0; i < rgba.length; i += 4) {
		const luma = 0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2];
		bins[Math.min(BINS - 1, Math.floor((luma / 256) * BINS))] += 1 / pixels;
	}
	return bins;
}

/** How different two histograms are: from 0 (the same) to 1. */
function distance({ a, b }: { a: number[]; b: number[] }): number {
	let sum = 0;
	for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
	return sum / 2;
}

/** The indices of the frames that start a new shot: a change from the frame
 * before over `threshold`, and several times the usual change around it. */
export function findCuts({
	histograms,
	threshold = 0.3,
	contrast = 3,
}: {
	histograms: number[][];
	threshold?: number;
	contrast?: number;
}): number[] {
	const changes = histograms.map((current, index) =>
		index === 0 ? 0 : distance({ a: histograms[index - 1], b: current }),
	);
	const cuts: number[] = [];
	for (let index = 1; index < changes.length; index++) {
		const change = changes[index];
		if (change < threshold) continue;
		const around: number[] = [];
		for (
			let other = Math.max(1, index - NEIGHBOURS);
			other <= Math.min(changes.length - 1, index + NEIGHBOURS);
			other++
		) {
			if (other !== index) around.push(changes[other]);
		}
		const usual = around.length
			? around.reduce((sum, value) => sum + value, 0) / around.length
			: 0;
		if (change >= usual * contrast) cuts.push(index);
	}
	return cuts;
}

/** The times (ticks) where shots change between `from` and `to`, each frame
 * of the timeline looked at. */
export async function findShots({
	editor,
	from,
	to,
	onProgress,
	isCancelled,
}: {
	editor: EditorCore;
	from: number;
	to: number;
	onProgress: (progress: number) => void;
	isCancelled: () => boolean;
}): Promise<number[]> {
	const project = editor.project.getActive();
	const { canvasSize, fps, background } = project.settings;
	const scene = buildScene({
		tracks: editor.scenes.getActiveScene().tracks,
		mediaAssets: editor.media.getAssets(),
		duration: editor.timeline.getTotalDuration(),
		canvasSize,
		background,
	});
	const renderer = new CanvasRenderer({ ...canvasSize, fps });
	const full = document.createElement("canvas");
	full.width = canvasSize.width;
	full.height = canvasSize.height;
	const small = document.createElement("canvas");
	small.width = WIDTH;
	small.height = Math.max(
		1,
		Math.round((WIDTH * canvasSize.height) / canvasSize.width),
	);
	const context = small.getContext("2d", { willReadFrequently: true });
	if (!context) return [];
	const frameTicks = Math.max(
		1,
		Math.round((TICKS_PER_SECOND * fps.denominator) / fps.numerator),
	);
	const times: number[] = [];
	const histograms: number[][] = [];
	for (let time = from; time < to; time += frameTicks) {
		if (isCancelled()) break;
		await renderer.renderToCanvas({ node: scene, time, targetCanvas: full });
		context.drawImage(full, 0, 0, small.width, small.height);
		histograms.push(
			histogram({
				rgba: context.getImageData(0, 0, small.width, small.height).data,
			}),
		);
		times.push(time);
		onProgress((time - from) / (to - from));
	}
	return findCuts({ histograms }).map((index) => times[index]);
}
