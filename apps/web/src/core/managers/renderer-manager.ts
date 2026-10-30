import type { EditorCore } from "@/core";
import type { RootNode } from "@/services/renderer/nodes/root-node";
import type { ExportOptions, ExportResult } from "@/export";
import { CanvasRenderer } from "@/services/renderer/canvas-renderer";
import { SceneExporter } from "@/services/renderer/scene-exporter";
import { openExportFile } from "@/export/disk-target";
import { buildScene } from "@/services/renderer/scene-builder";
import { mixTimelineAudio } from "@/media/audio-mix";
import {
	fitExportSize,
	getVideoBitrate,
	isCropped,
	type ExportCrop,
} from "@/export/settings";
import { findFrameBars, mergeBlackBars } from "@/export/black-bars";
import { formatTimecode } from "magnetcut-wasm";
import { TICKS_PER_SECOND } from "@/wasm";
import { frameRateToFloat } from "@/fps/utils";
import { downloadBlob } from "@/utils/browser";

// Frames looked at for black bars, spread across the timeline.
const BLACK_BAR_SAMPLES = 12;

type SnapshotResult =
	| { success: true; blob: Blob; filename: string }
	| { success: false; error: string };

export class RendererManager {
	private renderTree: RootNode | null = null;
	private _isDegraded = false;
	private listeners = new Set<() => void>();

	constructor(private editor: EditorCore) {}

	get isDegraded(): boolean {
		return this._isDegraded;
	}

	setDegraded(degraded: boolean): void {
		if (this._isDegraded === degraded) return;
		this._isDegraded = degraded;
		this.notify();
	}

	setRenderTree({ renderTree }: { renderTree: RootNode | null }): void {
		this.renderTree = renderTree;
		this.notify();
	}

	getRenderTree(): RootNode | null {
		return this.renderTree;
	}

	async saveSnapshot(): Promise<{ success: boolean; error?: string }> {
		const snapshot = await this.createSnapshot();
		if (!snapshot.success) {
			return snapshot;
		}

		downloadBlob({ blob: snapshot.blob, filename: snapshot.filename });
		return { success: true };
	}

	async copySnapshot(): Promise<{ success: boolean; error?: string }> {
		if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
			return {
				success: false,
				error: "Clipboard image copy is not supported in this browser",
			};
		}

		const snapshot = await this.createSnapshot();
		if (!snapshot.success) {
			return snapshot;
		}

		try {
			await navigator.clipboard.write([
				new ClipboardItem({
					[snapshot.blob.type || "image/png"]: snapshot.blob,
				}),
			]);
			return { success: true };
		} catch (error) {
			console.error("Copy snapshot failed:", error);
			return {
				success: false,
				error: error instanceof Error ? error.message : "Unknown error",
			};
		}
	}

	private async createSnapshot(): Promise<SnapshotResult> {
		try {
			const renderTree = this.getRenderTree();
			const activeProject = this.editor.project.getActive();

			if (!renderTree || !activeProject) {
				return { success: false, error: "No project or scene to capture" };
			}

			const duration = this.editor.timeline.getTotalDuration();
			if (duration === 0) {
				return { success: false, error: "Project is empty" };
			}

			const { canvasSize, fps } = activeProject.settings;
			const renderTime = Math.min(
				this.editor.playback.getCurrentTime(),
				this.editor.timeline.getLastFrameTime(),
			);

			const renderer = new CanvasRenderer({
				width: canvasSize.width,
				height: canvasSize.height,
				fps,
			});

			const tempCanvas = document.createElement("canvas");
			tempCanvas.width = canvasSize.width;
			tempCanvas.height = canvasSize.height;

			await renderer.renderToCanvas({
				node: renderTree,
				time: renderTime,
				targetCanvas: tempCanvas,
			});

			const blob = await new Promise<Blob | null>((resolve) => {
				tempCanvas.toBlob((result) => resolve(result), "image/png");
			});

			if (!blob) {
				return { success: false, error: "Failed to create image" };
			}

			const timecode = formatTimecode({ time: renderTime, rate: fps })!.replace(/:/g, "-");
			const safeName =
				activeProject.metadata.name.replace(/[<>:"/\\|?*]/g, "-").trim() ||
				"snapshot";
			const filename = `${safeName}-${timecode}.png`;

			return { success: true, blob, filename };
		} catch (error) {
			console.error("Snapshot capture failed:", error);
			return {
				success: false,
				error: error instanceof Error ? error.message : "Unknown error",
			};
		}
	}

	async exportProject({
		options,
		onProgress,
		onCancel,
	}: {
		options: ExportOptions;
		onProgress?: ({ progress }: { progress: number }) => void;
		onCancel?: () => boolean;
	}): Promise<ExportResult> {
		const { format, videoCodec, quality, shortSide, crop, fps, audio, path } =
			options;

		try {
			const tracks = this.editor.scenes.getActiveScene().tracks;
			const mediaAssets = this.editor.media.getAssets();
			const activeProject = this.editor.project.getActive();

			if (!activeProject) {
				return { success: false, error: "No active project" };
			}

			const duration = this.editor.timeline.getTotalDuration();
			if (duration === 0) {
				return { success: false, error: "Project is empty" };
			}

			const exportFps = fps ?? activeProject.settings.fps;
			const canvasSize = activeProject.settings.canvasSize;

			const hasCrop = isCropped({ crop });
			const outputSize = fitExportSize({
				canvas: canvasSize,
				shortSide,
				crop: hasCrop ? crop : undefined,
			});
			const isScaled =
				hasCrop ||
				outputSize.width !== canvasSize.width ||
				outputSize.height !== canvasSize.height;
			const audioBitrate = audio ? audio.kbps * 1000 : 0;
			const videoBitrate = getVideoBitrate({
				quality,
				codec: videoCodec,
				...outputSize,
				duration: duration / TICKS_PER_SECOND,
				audioBitrate,
			});

			const scene = buildScene({
				tracks,
				mediaAssets,
				duration,
				canvasSize,
				background: activeProject.settings.background,
			});

			const exporter = new SceneExporter({
				width: canvasSize.width,
				height: canvasSize.height,
				outputSize: isScaled ? outputSize : undefined,
				crop: hasCrop ? crop : undefined,
				fps: exportFps,
				format,
				videoCodec,
				videoBitrate,
				// A file size is kept to only at a constant bitrate.
				bitrateMode: quality.mode === "size" ? "constant" : undefined,
				// Mixed as the frames go, a window ahead.
				audio: audio
					? (mixTimelineAudio({ tracks, mediaAssets, duration }) ?? undefined)
					: undefined,
				audioSettings: audio ?? undefined,
				file: path ? await openExportFile({ path }) : undefined,
			});

			exporter.on("progress", (progress) => {
				onProgress?.({ progress });
			});

			let cancelled = false;
			const checkCancel = () => {
				if (onCancel?.()) {
					cancelled = true;
					exporter.cancel();
				}
			};

			const cancelInterval = setInterval(checkCancel, 100);

			try {
				const output = await exporter.export({ rootNode: scene });
				clearInterval(cancelInterval);

				if (cancelled) {
					return { success: false, cancelled: true };
				}

				if (!output) {
					return { success: false, error: "Export failed to produce buffer" };
				}

				return "buffer" in output
					? { success: true, buffer: output.buffer }
					: { success: true, path };
			} finally {
				clearInterval(cancelInterval);
			}
		} catch (error) {
			console.error("Export failed:", error);
			return {
				success: false,
				error: error instanceof Error ? error.message : "Unknown export error",
			};
		}
	}

	/**
	 * Black bars around the picture, for Export's crop, from frames rendered
	 * across the timeline as they'd be exported: null if there's nothing to look at.
	 */
	async detectBlackBars(): Promise<ExportCrop | null> {
		const activeProject = this.editor.project.getActiveOrNull();
		const duration = this.editor.timeline.getTotalDuration();
		if (!activeProject || duration === 0) return null;

		const { canvasSize, fps, background } = activeProject.settings;
		const scene = buildScene({
			tracks: this.editor.scenes.getActiveScene().tracks,
			mediaAssets: this.editor.media.getAssets(),
			duration,
			canvasSize,
			background,
		});
		const renderer = new CanvasRenderer({ ...canvasSize, fps });
		const target = document.createElement("canvas");
		target.width = canvasSize.width;
		target.height = canvasSize.height;
		const context = target.getContext("2d", { willReadFrequently: true });
		if (!context) return null;

		// One frame's pixels at a time: a dozen 4K frames would be 400 MB.
		const bars = [];
		for (let i = 0; i < BLACK_BAR_SAMPLES; i++) {
			const time = Math.floor(((i + 0.5) / BLACK_BAR_SAMPLES) * duration);
			await renderer.renderToCanvas({ node: scene, time, targetCanvas: target });
			const frame = context.getImageData(0, 0, target.width, target.height);
			bars.push(findFrameBars({ frame }));
		}
		return mergeBlackBars({ bars, ...canvasSize });
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(): void {
		this.listeners.forEach((fn) => {
			fn();
		});
	}
}
