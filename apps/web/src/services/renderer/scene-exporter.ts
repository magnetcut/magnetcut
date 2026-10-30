import EventEmitter from "eventemitter3";

import {
	Output,
	Mp4OutputFormat,
	WebMOutputFormat,
	BufferTarget,
	StreamTarget,
	CanvasSource,
	AudioBufferSource,
	QUALITY_LOW,
	QUALITY_MEDIUM,
	QUALITY_HIGH,
	QUALITY_VERY_HIGH,
} from "mediabunny";
import type { FrameRate } from "magnetcut-wasm";
import { mediaTimeToSeconds } from "magnetcut-wasm";
import { TICKS_PER_SECOND } from "@/wasm";
import { frameRateToFloat } from "@/fps/utils";
import type { RootNode } from "./nodes/root-node";
import type { ExportFormat, ExportQuality } from "@/export";
import type { ExportFile } from "@/export/disk-target";
import { CanvasRenderer } from "./canvas-renderer";

type ExportParams = {
	width: number;
	height: number;
	fps: FrameRate;
	format: ExportFormat;
	quality: ExportQuality;
	shouldIncludeAudio?: boolean;
	audioBuffer?: AudioBuffer;
	/** Where it's written as it's made; otherwise it's kept in memory. */
	file?: ExportFile;
};

/** An export in memory, or the file it was written to. */
export type ExportOutput = { buffer: ArrayBuffer } | { file: ExportFile };

// What's handed to the file at a time.
const FILE_CHUNK_SIZE = 16 * 1024 * 1024;

const qualityMap = {
	low: QUALITY_LOW,
	medium: QUALITY_MEDIUM,
	high: QUALITY_HIGH,
	very_high: QUALITY_VERY_HIGH,
};

/**
 * WebKit's H.264 encoder (macOS, and Safari) keeps a few frames before it lets
 * any go, while mediabunny waits for one to go before it sends a fifth: the
 * export stops after a few frames. In real time it lets each go at once.
 */
function isWebKit() {
	const { userAgent } = navigator;
	return (
		/AppleWebKit/.test(userAgent) && !/Chrome|Chromium|Edg/.test(userAgent)
	);
}

export type SceneExporterEvents = {
	progress: [progress: number];
	complete: [output: ExportOutput];
	error: [error: Error];
	cancelled: [];
};

export class SceneExporter extends EventEmitter<SceneExporterEvents> {
	private renderer: CanvasRenderer;
	private format: ExportFormat;
	private quality: ExportQuality;
	private shouldIncludeAudio: boolean;
	private audioBuffer?: AudioBuffer;
	private file?: ExportFile;

	private isCancelled = false;

	constructor({
		width,
		height,
		fps,
		format,
		quality,
		shouldIncludeAudio,
		audioBuffer,
		file,
	}: ExportParams) {
		super();
		this.renderer = new CanvasRenderer({
			width,
			height,
			fps,
		});

		this.format = format;
		this.quality = quality;
		this.shouldIncludeAudio = shouldIncludeAudio ?? false;
		this.audioBuffer = audioBuffer;
		this.file = file;
	}

	cancel(): void {
		this.isCancelled = true;
	}

	async export({
		rootNode,
	}: {
		rootNode: RootNode;
	}): Promise<ExportOutput | null> {
		try {
			return await this.write({ rootNode });
		} catch (error) {
			await this.file?.discard();
			throw error;
		}
	}

	private async write({
		rootNode,
	}: {
		rootNode: RootNode;
	}): Promise<ExportOutput | null> {
		const fps = this.renderer.fps;
		const fpsFloat = frameRateToFloat(fps);
		const ticksPerFrame = Math.round(
			(TICKS_PER_SECOND * fps.denominator) / fps.numerator,
		);
		const frameCount = Math.floor(rootNode.duration / ticksPerFrame);

		const outputFormat =
			this.format === "webm"
				? new WebMOutputFormat()
				: // Its index at the end, written once: nothing held in memory.
					new Mp4OutputFormat(this.file ? { fastStart: false } : {});

		const target = this.file
			? new StreamTarget(this.file.writable, {
					chunked: true,
					chunkSize: FILE_CHUNK_SIZE,
				})
			: new BufferTarget();
		const output = new Output({ format: outputFormat, target });

		const codec = this.format === "webm" ? "vp9" : "avc";
		const videoSource = new CanvasSource(this.renderer.getOutputCanvas(), {
			codec,
			bitrate: qualityMap[this.quality],
			...(codec === "avc" && isWebKit() ? { latencyMode: "realtime" } : {}),
		});

		output.addVideoTrack(videoSource, { frameRate: fpsFloat });

		let audioSource: AudioBufferSource | null = null;
		if (this.shouldIncludeAudio && this.audioBuffer) {
			let audioCodec: "aac" | "opus" = this.format === "webm" ? "opus" : "aac";

			if (audioCodec === "aac" && typeof AudioEncoder !== "undefined") {
				const { supported } = await AudioEncoder.isConfigSupported({
					codec: "mp4a.40.2",
					sampleRate: this.audioBuffer.sampleRate,
					numberOfChannels: this.audioBuffer.numberOfChannels,
					bitrate: 192000,
				});
				if (!supported) audioCodec = "opus";
			}

			audioSource = new AudioBufferSource({
				codec: audioCodec,
				bitrate: qualityMap[this.quality],
			});
			output.addAudioTrack(audioSource);
		}

		await output.start();

		if (audioSource && this.audioBuffer) {
			await audioSource.add(this.audioBuffer);
			audioSource.close();
		}

		for (let i = 0; i < frameCount; i++) {
			if (this.isCancelled) {
				await output.cancel();
				await this.file?.discard();
				this.emit("cancelled");
				return null;
			}

			const timeTicks = i * ticksPerFrame;
			const timeSeconds = mediaTimeToSeconds({ time: timeTicks });
			await this.renderer.render({ node: rootNode, time: timeTicks });
			await videoSource.add(timeSeconds, 1 / fpsFloat);

			this.emit("progress", i / frameCount);
		}

		if (this.isCancelled) {
			await output.cancel();
			await this.file?.discard();
			this.emit("cancelled");
			return null;
		}

		videoSource.close();
		await output.finalize();
		this.emit("progress", 1);

		if (this.file) {
			this.emit("complete", { file: this.file });
			return { file: this.file };
		}
		const buffer = target instanceof BufferTarget ? target.buffer : null;
		if (!buffer) {
			this.emit("error", new Error("Failed to export video"));
			return null;
		}

		this.emit("complete", { buffer });
		return { buffer };
	}
}
