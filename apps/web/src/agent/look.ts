import type { EditorCore } from "@/core";
import { CanvasRenderer } from "@/services/renderer/canvas-renderer";
import { buildScene } from "@/services/renderer/scene-builder";
import { formatTime } from "./time";

// The picture, for an agent to look at (docs/AUTOMATION.md): drawn by the
// editor's own renderer, as the preview and the export are, and sent small,
// as JPEG. A model pays for an image by its pixels, so one frame or a sheet
// of small ones with their times on them, never a film.

// The most frames on a sheet, and how many across.
export const MAX_SHEET = 16;
const COLUMNS = 4;

export interface Picture {
	data: string;
	mimeType: "image/jpeg";
}

function toJpeg({ canvas }: { canvas: HTMLCanvasElement }): Promise<Picture> {
	return new Promise((resolve, reject) => {
		canvas.toBlob(
			(blob) => {
				if (!blob) {
					reject(new Error("Couldn't make the picture"));
					return;
				}
				void blob.arrayBuffer().then((buffer) => {
					let binary = "";
					const bytes = new Uint8Array(buffer);
					for (let i = 0; i < bytes.length; i += 0x8000) {
						binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
					}
					resolve({ data: btoa(binary), mimeType: "image/jpeg" });
				});
			},
			"image/jpeg",
			0.75,
		);
	});
}

/** Draws the timeline at each of `times` (ticks), each `width` wide: one
 * picture, or a sheet with the times on. */
export async function look({
	editor,
	times,
	width,
}: {
	editor: EditorCore;
	times: number[];
	width: number;
}): Promise<Picture> {
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
	const isSheet = times.length > 1;
	const columns = Math.min(COLUMNS, times.length);
	const cellWidth = isSheet ? Math.floor(width / columns) : width;
	const cellHeight = Math.round(
		(cellWidth * canvasSize.height) / canvasSize.width,
	);
	const rows = Math.ceil(times.length / columns);
	const sheet = document.createElement("canvas");
	sheet.width = cellWidth * columns;
	sheet.height = cellHeight * rows;
	const context = sheet.getContext("2d");
	if (!context) throw new Error("Couldn't draw the picture");
	context.imageSmoothingQuality = "high";
	context.fillStyle = "black";
	context.fillRect(0, 0, sheet.width, sheet.height);
	for (const [index, time] of times.entries()) {
		await renderer.renderToCanvas({ node: scene, time, targetCanvas: full });
		const x = (index % columns) * cellWidth;
		const y = Math.floor(index / columns) * cellHeight;
		context.drawImage(full, x, y, cellWidth, cellHeight);
		if (isSheet) {
			const label = formatTime({ ticks: time });
			const size = Math.max(10, Math.round(cellHeight / 10));
			context.font = `${size}px sans-serif`;
			const labelWidth = context.measureText(label).width + size * 0.6;
			context.fillStyle = "rgba(0, 0, 0, 0.7)";
			context.fillRect(x, y, labelWidth, size * 1.4);
			context.fillStyle = "white";
			context.fillText(label, x + size * 0.3, y + size * 1.05);
		}
	}
	return toJpeg({ canvas: sheet });
}
