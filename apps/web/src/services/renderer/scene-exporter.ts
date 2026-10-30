import EventEmitter from "eventemitter3";

import {
	Output,
	Mp4OutputFormat,
	MovOutputFormat,
	MkvOutputFormat,
	WebMOutputFormat,
	BufferTarget,
	StreamTarget,
	CanvasSource,
	AudioBufferSource,
	canEncodeAudio,
	type OutputFormat,
} from "mediabunny";
import type { FrameRate } from "magnetcut-wasm";
import { mediaTimeToSeconds } from "magnetcut-wasm";
import { TICKS_PER_SECOND } from "@/wasm";
import { frameRateToFloat } from "@/fps/utils";
import type { RootNode } from "./nodes/root-node";
import type { ExportFormat } from "@/export";
import type { ExportFile } from "@/export/disk-target";
import {
	FORMAT_CODECS,
	NO_CROP,
	type ExportAudioSettings,
	type ExportCrop,
	type ExportVideoCodec,
} from "@/export/settings";
import { EXPORT_SAMPLE_RATE } from "@/media/audio-mix";
import { CanvasRenderer } from "./canvas-renderer";

type ExportParams = {
	/** The project's size, which the scene is drawn at. */
	width: number;
	height: number;
	/** The size encoded, if not the project's: the picture is scaled to it. */
	outputSize?: { width: number; height: number };
	/** What's cut from the picture's edges first; needs `outputSize`. */
	crop?: ExportCrop;
	fps: FrameRate;
	format: ExportFormat;
	videoCodec: ExportVideoCodec;
	/** In bits a second. */
	videoBitrate: number;
	/** Constant for a file size to keep to; otherwise the encoder's choice. */
	bitrateMode?: "constant" | "variable";
	/** The soundtrack, a window at a time (`mixTimelineAudio`), and how it's encoded. */
	audio?: AsyncGenerator<AudioBuffer, void, undefined>;
	audioSettings?: ExportAudioSettings;
	/** Where it's written as it's made; otherwise it's kept in memory. */
	file?: ExportFile;
};

/** An export in memory, or the file it was written to. */
export type ExportOutput = { buffer: ArrayBuffer } | { file: ExportFile };

// What's handed to the file at a time.
const FILE_CHUNK_SIZE = 16 * 1024 * 1024;

/** The container, with MP4's and MOV's index at the end when written to a file as it goes. */
function createOutputFormat({
	format,
	isStreamed,
}: {
	format: ExportFormat;
	isStreamed: boolean;
}): OutputFormat {
	const fastStart = isStreamed ? false : "in-memory";
	switch (format) {
		case "mp4":
			return new Mp4OutputFormat({ fastStart });
		case "mov":
			return new MovOutputFormat({ fastStart });
		case "mkv":
			return new MkvOutputFormat();
		case "webm":
			return new WebMOutputFormat();
	}
}

/** A window of the stereo mix, as one channel. */
function downmix({ buffer }: { buffer: AudioBuffer }): AudioBuffer {
	const mono = new AudioBuffer({
		numberOfChannels: 1,
		length: buffer.length,
		sampleRate: buffer.sampleRate,
	});
	const data = mono.getChannelData(0);
	for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
		const source = buffer.getChannelData(channel);
		for (let i = 0; i < data.length; i++) {
			data[i] += source[i] / buffer.numberOfChannels;
		}
	}
	return mono;
}

/**
 * WebKit's H.264 encoder (macOS, and Safari) puts out nothing in the High and
 * Main profiles, which mediabunny asks for, so the export stopped after a few
 * frames; in real time it drops frames after each key frame. Baseline it
 * encodes, at the level mediabunny chose. (Phase 4 encodes natively.)
 */
function preferBaselineInWebKit({ config }: { config: VideoEncoderConfig }) {
	const { userAgent } = navigator;
	const isWebKit =
		/AppleWebKit/.test(userAgent) && !/Chrome|Chromium|Edg/.test(userAgent);
	if (!isWebKit) return;
	config.codec = config.codec.replace(/^avc1\.(64|4d)/, "avc1.42");
}

/** The soundtrack, handed to the encoder a window at a time ahead of the frames. */
class SoundtrackFeed {
	private readonly windows: AsyncGenerator<AudioBuffer, void, undefined>;
	private readonly source: AudioBufferSource;
	private readonly isMono: boolean;
	private time = 0;
	private isDone = false;

	constructor({
		windows,
		source,
		isMono,
	}: {
		windows: AsyncGenerator<AudioBuffer, void, undefined>;
		source: AudioBufferSource;
		isMono: boolean;
	}) {
		this.windows = windows;
		this.source = source;
		this.isMono = isMono;
	}

	/** Adds windows until the soundtrack is past `time` seconds, or all in. */
	async addUntil({ time }: { time: number }) {
		while (!this.isDone && this.time <= time) {
			const next = await this.windows.next();
			if (next.done) {
				this.isDone = true;
				this.source.close();
				return;
			}
			const buffer = next.value;
			await this.source.add(this.isMono ? downmix({ buffer }) : buffer);
			this.time += buffer.duration;
		}
	}
}

export type SceneExporterEvents = {
	progress: [progress: number];
	complete: [output: ExportOutput];
	error: [error: Error];
	cancelled: [];
};

export class SceneExporter extends EventEmitter<SceneExporterEvents> {
	private renderer: CanvasRenderer;
	private outputSize?: { width: number; height: number };
	private crop?: ExportCrop;
	private format: ExportFormat;
	private videoCodec: ExportVideoCodec;
	private videoBitrate: number;
	private bitrateMode?: "constant" | "variable";
	private audio?: AsyncGenerator<AudioBuffer, void, undefined>;
	private audioSettings?: ExportAudioSettings;
	private file?: ExportFile;

	private isCancelled = false;

	constructor({
		width,
		height,
		outputSize,
		crop,
		fps,
		format,
		videoCodec,
		videoBitrate,
		bitrateMode,
		audio,
		audioSettings,
		file,
	}: ExportParams) {
		super();
		this.renderer = new CanvasRenderer({
			width,
			height,
			fps,
		});

		this.outputSize = outputSize;
		this.crop = crop;
		this.format = format;
		this.videoCodec = videoCodec;
		this.videoBitrate = videoBitrate;
		this.bitrateMode = bitrateMode;
		this.audio = audio;
		this.audioSettings = audioSettings;
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
		} finally {
			// Stops the mix where it got to, closing its files.
			await this.audio?.return(undefined);
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

		const outputFormat = createOutputFormat({
			format: this.format,
			isStreamed: !!this.file,
		});

		const target = this.file
			? new StreamTarget(this.file.writable, {
					chunked: true,
					chunkSize: FILE_CHUNK_SIZE,
				})
			: new BufferTarget();
		const output = new Output({ format: outputFormat, target });

		// The composited frame, or a copy cropped and scaled to the size encoded.
		const composited = this.renderer.getOutputCanvas();
		const crop = this.crop ?? NO_CROP;
		const source = {
			x: crop.left,
			y: crop.top,
			width: this.renderer.width - crop.left - crop.right,
			height: this.renderer.height - crop.top - crop.bottom,
		};
		const scaled = this.outputSize
			? new OffscreenCanvas(this.outputSize.width, this.outputSize.height)
			: null;
		const scaledContext = scaled?.getContext("2d") ?? null;
		if (scaledContext) scaledContext.imageSmoothingQuality = "high";
		const videoSource = new CanvasSource(scaled ?? composited, {
			codec: this.videoCodec,
			bitrate: this.videoBitrate,
			bitrateMode: this.bitrateMode,
			onEncoderConfig: (config) => preferBaselineInWebKit({ config }),
		});

		output.addVideoTrack(videoSource, { frameRate: fpsFloat });

		let audioSource: AudioBufferSource | null = null;
		const { audioSettings } = this;
		if (this.audio && audioSettings) {
			const bitrate = audioSettings.kbps * 1000;
			let codec = audioSettings.codec;
			// A web view without an AAC encoder: Opus, where the container takes it.
			if (
				codec === "aac" &&
				FORMAT_CODECS[this.format].audio.includes("opus") &&
				!(await canEncodeAudio("aac", {
					numberOfChannels: audioSettings.channels,
					sampleRate: EXPORT_SAMPLE_RATE,
					bitrate,
				}))
			) {
				codec = "opus";
			}
			audioSource = new AudioBufferSource({ codec, bitrate });
			output.addAudioTrack(audioSource);
		}

		await output.start();

		const soundtrack =
			audioSource && this.audio
				? new SoundtrackFeed({
						windows: this.audio,
						source: audioSource,
						isMono: audioSettings?.channels === 1,
					})
				: null;

		for (let i = 0; i < frameCount; i++) {
			if (this.isCancelled) {
				await output.cancel();
				await this.file?.discard();
				this.emit("cancelled");
				return null;
			}

			const timeTicks = i * ticksPerFrame;
			const timeSeconds = mediaTimeToSeconds({ time: timeTicks });
			await soundtrack?.addUntil({ time: timeSeconds });
			await this.renderer.render({ node: rootNode, time: timeTicks });
			if (scaled && scaledContext) {
				scaledContext.drawImage(
					composited,
					source.x,
					source.y,
					source.width,
					source.height,
					0,
					0,
					scaled.width,
					scaled.height,
				);
			}
			await videoSource.add(timeSeconds, 1 / fpsFloat);

			this.emit("progress", i / frameCount);
		}

		if (this.isCancelled) {
			await output.cancel();
			await this.file?.discard();
			this.emit("cancelled");
			return null;
		}

		await soundtrack?.addUntil({ time: Infinity });
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
