import type { EditorCore } from "@/core";
import type { RootNode } from "@/services/renderer/nodes/root-node";
import type { ExportOptions, ExportResult } from "@/export";
import { CanvasRenderer } from "@/services/renderer/canvas-renderer";
import { SceneExporter } from "@/services/renderer/scene-exporter";
import {
	NativeSceneExporter,
	findNativeSources,
	type NativeSources,
} from "@/services/renderer/native-exporter";
import type { NativeExportOptions, NativeSourceInfo } from "@/export/native";
import { canEncodeVideo } from "mediabunny";
import { openExportFile } from "@/export/disk-target";
import { DiskFile } from "@/media/disk-file";
import {
	buildFilterPasses,
	hasFilters,
	type FilterPasses,
} from "@/export/filters";
import {
	canHoldSubtitleTracks,
	getPictureTracks,
	getSubtitleFiles,
} from "@/export/subtitles";
import { buildScene } from "@/services/renderer/scene-builder";
import { EXPORT_SAMPLE_RATE, mixTimelineAudio } from "@/media/audio-mix";
import {
	VIDEO_CODEC_NAMES,
	fitExportSize,
	getVideoBitrate,
	isCropped,
	isNativeOnlyCodec,
	type ExportCrop,
} from "@/export/settings";
import { findFrameBars, mergeBlackBars } from "@/export/black-bars";
import {
	openAudioPassthrough,
	type AudioPassthrough,
} from "@/export/passthrough";
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
		const {
			format,
			videoCodec,
			quality,
			shortSide,
			crop,
			fps,
			audio,
			filters,
			subtitles = "picture",
			path,
		} = options;
		const filterPasses =
			filters && hasFilters({ filters })
				? buildFilterPasses({ filters })
				: undefined;
		// Closed by the exporter, or here if it never gets to run.
		let passthrough: AudioPassthrough | null = null;

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

			// The source's sound copied, if asked for and it can be.
			passthrough = audio?.passthrough
				? await openAudioPassthrough({ tracks, mediaAssets, duration, format })
				: null;
			const audioBitrate = passthrough
				? passthrough.bitrate
				: audio
					? audio.kbps * 1000
					: 0;
			const videoBitrate = getVideoBitrate({
				quality,
				codec: videoCodec,
				...outputSize,
				fps: frameRateToFloat(exportFps),
				duration: duration / TICKS_PER_SECOND,
				audioBitrate,
			});

			const subtitleFiles = getSubtitleFiles({ tracks, subtitles });
			if (subtitleFiles.length > 0 && !canHoldSubtitleTracks({ format })) {
				passthrough?.close();
				return {
					success: false,
					error:
						"A QuickTime file can't hold subtitle tracks here: choose MP4, MKV or WebM, or put the subtitles in the picture.",
				};
			}
			const scene = buildScene({
				tracks: getPictureTracks({ tracks, subtitles }),
				mediaAssets,
				duration,
				canvasSize,
				background: activeProject.settings.background,
			});
			// The desktop app's own export, where it can make this one: it
			// copies sound from a file on disk.
			const copiedFile = passthrough?.file;
			const native: NativeSources = !path
				? { reason: "it's only in the desktop app" }
				: subtitleFiles.length > 0
					? { reason: "it doesn't write subtitle tracks yet" }
					: copiedFile && !(copiedFile instanceof DiskFile)
					? { reason: "the sound to copy isn't read from the disk" }
					: await findNativeSources({
							rootNode: scene,
							format,
							videoCodec,
							audioCodec: passthrough?.codec ?? audio?.codec ?? null,
						});
			if (path && "sources" in native) {
				const audioCopy =
					passthrough && copiedFile instanceof DiskFile
						? { path: copiedFile.path, end: passthrough.end }
						: undefined;
				passthrough?.close();
				passthrough = null;
				return await this.exportNatively({
					scene,
					sources: native.sources,
					filters: filterPasses,
					path,
					options: {
						path,
						format,
						width: canvasSize.width,
						height: canvasSize.height,
						crop: hasCrop ? crop : undefined,
						outputWidth: outputSize.width,
						outputHeight: outputSize.height,
						fps: exportFps,
						videoCodec,
						videoBitrate,
						videoQuality:
							quality.mode === "constant" ? quality.quality / 100 : undefined,
						audio:
							audio && !audioCopy
								? {
										channels: audio.channels,
										sampleRate: EXPORT_SAMPLE_RATE,
										bitrate: audio.kbps * 1000,
									}
								: null,
						audioCopy,
					},
					onProgress,
					onCancel,
				});
			}
			const reason =
				"reason" in native ? native.reason : "it's only in the desktop app";
			if (isNativeOnlyCodec(videoCodec)) {
				passthrough?.close();
				return {
					success: false,
					error: `${VIDEO_CODEC_NAMES[videoCodec]} is made by the Mac's own encoder, which can't make this film: ${reason}.`,
				};
			}
			// AV1 on a Mac, which only the native export encodes.
			const canEncode = await canEncodeVideo(videoCodec, outputSize).catch(
				() => false,
			);
			if (!canEncode) {
				passthrough?.close();
				return {
					success: false,
					error: `${VIDEO_CODEC_NAMES[videoCodec]} can't be encoded here, and the Mac's own export can't make this film: ${reason}.`,
				};
			}

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
				audio:
					audio && !passthrough
						? (mixTimelineAudio({ tracks, mediaAssets, duration }) ?? undefined)
						: undefined,
				audioSettings: audio ?? undefined,
				audioPassthrough: passthrough ?? undefined,
				file: path ? await openExportFile({ path }) : undefined,
				filters: filterPasses,
				subtitles: subtitleFiles,
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
			passthrough?.close();
			console.error("Export failed:", error);
			return {
				success: false,
				error: error instanceof Error ? error.message : "Unknown export error",
			};
		}
	}

	/** An export made by the desktop app, natively (`NativeSceneExporter`). */
	private async exportNatively({
		scene,
		sources,
		filters,
		path,
		options,
		onProgress,
		onCancel,
	}: {
		scene: RootNode;
		sources: Map<string, NativeSourceInfo>;
		filters?: FilterPasses;
		path: string;
		options: NativeExportOptions;
		onProgress?: ({ progress }: { progress: number }) => void;
		onCancel?: () => boolean;
	}): Promise<ExportResult> {
		const tracks = this.editor.scenes.getActiveScene().tracks;
		const mediaAssets = this.editor.media.getAssets();
		const duration = this.editor.timeline.getTotalDuration();
		// Mixed as the frames go; none when nothing's heard, and no sound track.
		const audio = options.audio
			? mixTimelineAudio({ tracks, mediaAssets, duration })
			: null;
		const exporter = new NativeSceneExporter({
			options: { ...options, audio: audio ? options.audio : null },
			sources,
			audio: audio ?? undefined,
			filters,
		});
		exporter.on("progress", (progress) => {
			onProgress?.({ progress });
		});
		let cancelled = false;
		const cancelInterval = setInterval(() => {
			if (onCancel?.()) {
				cancelled = true;
				exporter.cancel();
			}
		}, 100);
		try {
			const isMade = await exporter.export({ rootNode: scene });
			if (cancelled || !isMade) {
				return { success: false, cancelled: true };
			}
			return { success: true, path };
		} finally {
			clearInterval(cancelInterval);
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
