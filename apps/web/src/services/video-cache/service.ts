import { Input, ALL_FORMATS, CanvasSink, type WrappedCanvas } from "mediabunny";
import { createMediaSource, type MediaFile } from "@/media/disk-file";

interface VideoSinkData {
	mediaId: string;
	input: Input;
	sink: CanvasSink;
	iterator: AsyncGenerator<WrappedCanvas, void, unknown> | null;
	currentFrame: WrappedCanvas | null;
	nextFrame: WrappedCanvas | null;
	lastTime: number;
	prefetching: boolean;
	prefetchPromise: Promise<void> | null;
}

/**
 * How far past the time asked for a frame is looked up, in seconds. The
 * timeline's frames start where a source's do, and the two times, rounded
 * each its own way, can fall either side: a hair later, the frame that starts
 * there, not the one before, whichever the decoder has ready.
 */
const FRAME_START_TOLERANCE = 1e-6;

/**
 * A file's decoder, by the stream it serves: one per file, and more for clips
 * that show side by side (`streamKey`).
 */
function getSinkKey({
	mediaId,
	streamKey,
}: {
	mediaId: string;
	streamKey?: string;
}): string {
	return streamKey ? `${mediaId}#${streamKey}` : mediaId;
}

export class VideoCache {
	private sinks = new Map<string, VideoSinkData>();
	private initPromises = new Map<string, Promise<void>>();
	private frameChain = new Map<string, Promise<unknown>>();
	private seekGenerations = new Map<string, number>();

	async getFrameAt({
		mediaId,
		file,
		time,
		streamKey,
	}: {
		mediaId: string;
		file: MediaFile;
		time: number;
		streamKey?: string;
	}): Promise<WrappedCanvas | null> {
		const key = getSinkKey({ mediaId, streamKey });
		await this.ensureSink({ key, mediaId, file });

		const sinkData = this.sinks.get(key);
		if (!sinkData) return null;

		const generation = (this.seekGenerations.get(key) ?? 0) + 1;
		this.seekGenerations.set(key, generation);

		const previous = this.frameChain.get(key) ?? Promise.resolve();
		const current = previous.then(() => {
			if (this.seekGenerations.get(key) !== generation) {
				return sinkData.currentFrame ?? null;
			}
			return this.resolveFrame({
				sinkData,
				time: time + FRAME_START_TOLERANCE,
			});
		});
		this.frameChain.set(
			key,
			current.catch(() => {}),
		);
		return current;
	}

	private async resolveFrame({
		sinkData,
		time,
	}: {
		sinkData: VideoSinkData;
		time: number;
	}): Promise<WrappedCanvas | null> {
		if (sinkData.nextFrame && sinkData.nextFrame.timestamp <= time) {
			sinkData.currentFrame = sinkData.nextFrame;
			sinkData.nextFrame = null;
			this.startPrefetch({ sinkData });
		}

		if (
			sinkData.currentFrame &&
			this.isFrameValid({ frame: sinkData.currentFrame, time })
		) {
			if (!sinkData.nextFrame && !sinkData.prefetching) {
				this.startPrefetch({ sinkData });
			}
			return sinkData.currentFrame;
		}

		if (
			sinkData.iterator &&
			sinkData.currentFrame &&
			time >= sinkData.lastTime &&
			time < sinkData.lastTime + 2.0
		) {
			const frame = await this.iterateToTime({ sinkData, targetTime: time });
			if (frame) {
				if (!sinkData.nextFrame && !sinkData.prefetching) {
					this.startPrefetch({ sinkData });
				}
				return frame;
			}
		}

		const frame = await this.seekToTime({ sinkData, time });
		if (frame && !sinkData.nextFrame && !sinkData.prefetching) {
			this.startPrefetch({ sinkData });
		}
		return frame;
	}

	private isFrameValid({
		frame,
		time,
	}: {
		frame: WrappedCanvas;
		time: number;
	}): boolean {
		return time >= frame.timestamp && time < frame.timestamp + frame.duration;
	}
	private async iterateToTime({
		sinkData,
		targetTime,
	}: {
		sinkData: VideoSinkData;
		targetTime: number;
	}): Promise<WrappedCanvas | null> {
		if (!sinkData.iterator) return null;

		try {
			while (true) {
				// Wait for any pending prefetch to finish before touching iterator
				if (sinkData.prefetching && sinkData.prefetchPromise) {
					await sinkData.prefetchPromise;
				}

				// Check if the nextFrame (which might have just arrived) is what we need
				if (
					sinkData.nextFrame &&
					sinkData.nextFrame.timestamp <= targetTime + 0.05 // Tolerance
				) {
					sinkData.currentFrame = sinkData.nextFrame;
					sinkData.nextFrame = null;
				} else {
					const { value: frame, done } = await sinkData.iterator.next();

					if (done || !frame) break;

					sinkData.currentFrame = frame;
				}

				const frame = sinkData.currentFrame;
				if (!frame) break;

				sinkData.lastTime = frame.timestamp;

				if (this.isFrameValid({ frame, time: targetTime })) {
					return frame;
				}

				if (frame.timestamp > targetTime + 1.0) break;
			}
		} catch (error) {
			console.warn("Iterator failed, will restart:", error);
			sinkData.iterator = null;
		}

		return null;
	}
	private async seekToTime({
		sinkData,
		time,
	}: {
		sinkData: VideoSinkData;
		time: number;
	}): Promise<WrappedCanvas | null> {
		try {
			if (sinkData.prefetching && sinkData.prefetchPromise) {
				await sinkData.prefetchPromise;
			}

			if (sinkData.iterator) {
				await sinkData.iterator.return();
				sinkData.iterator = null;
			}

			sinkData.nextFrame = null;
			sinkData.iterator = sinkData.sink.canvases(time);
			sinkData.lastTime = time;

			// Fetch current frame
			const { value: frame } = await sinkData.iterator.next();

			if (frame) {
				sinkData.currentFrame = frame;
				this.startPrefetch({ sinkData });
				return frame;
			}
		} catch (error) {
			console.warn("Failed to seek video:", error);
		}

		return null;
	}

	private startPrefetch({ sinkData }: { sinkData: VideoSinkData }): void {
		if (sinkData.prefetching || !sinkData.iterator || sinkData.nextFrame) {
			return;
		}

		sinkData.prefetching = true;
		sinkData.prefetchPromise = this.prefetchNextFrame({ sinkData });
	}

	private async prefetchNextFrame({
		sinkData,
	}: {
		sinkData: VideoSinkData;
	}): Promise<void> {
		if (!sinkData.iterator) {
			sinkData.prefetching = false;
			sinkData.prefetchPromise = null;
			return;
		}

		try {
			const { value: frame, done } = await sinkData.iterator.next();

			if (done || !frame) {
				sinkData.prefetching = false;
				sinkData.prefetchPromise = null;
				return;
			}

			sinkData.nextFrame = frame;
			sinkData.prefetching = false;
			sinkData.prefetchPromise = null;
		} catch (error) {
			console.warn("Prefetch failed:", error);
			sinkData.prefetching = false;
			sinkData.prefetchPromise = null;
			sinkData.iterator = null;
		}
	}
	private async ensureSink({
		key,
		mediaId,
		file,
	}: {
		key: string;
		mediaId: string;
		file: MediaFile;
	}): Promise<void> {
		if (this.sinks.has(key)) return;

		if (this.initPromises.has(key)) {
			await this.initPromises.get(key);
			return;
		}

		const initPromise = this.initializeSink({ key, mediaId, file });
		this.initPromises.set(key, initPromise);

		try {
			await initPromise;
		} finally {
			this.initPromises.delete(key);
		}
	}
	private async initializeSink({
		key,
		mediaId,
		file,
	}: {
		key: string;
		mediaId: string;
		file: MediaFile;
	}): Promise<void> {
		const input = new Input({
			source: createMediaSource({ file }),
			formats: ALL_FORMATS,
		});

		try {
			const videoTrack = await input.getPrimaryVideoTrack();
			if (!videoTrack) {
				throw new Error("No video track found");
			}

			const canDecode = await videoTrack.canDecode();
			if (!canDecode) {
				throw new Error("Video codec not supported for decoding");
			}

			const sink = new CanvasSink(videoTrack, {
				poolSize: 3,
				fit: "contain",
			});

			this.sinks.set(key, {
				mediaId,
				input,
				sink,
				iterator: null,
				currentFrame: null,
				nextFrame: null,
				lastTime: -1,
				prefetching: false,
				prefetchPromise: null,
			});
		} catch (error) {
			input.dispose();
			console.error(`Failed to initialize video sink for ${mediaId}:`, error);
			throw error;
		}
	}

	/** All of a file's decoders. */
	clearVideo({ mediaId }: { mediaId: string }): void {
		const isOfFile = (key: string) =>
			key === mediaId || key.startsWith(`${mediaId}#`);
		for (const [key, sinkData] of this.sinks) {
			if (sinkData.mediaId !== mediaId) continue;
			if (sinkData.iterator) {
				void sinkData.iterator.return();
			}

			sinkData.input.dispose();
			this.sinks.delete(key);
		}

		for (const map of [
			this.initPromises,
			this.frameChain,
			this.seekGenerations,
		]) {
			for (const key of [...map.keys()]) {
				if (isOfFile(key)) map.delete(key);
			}
		}
	}

	clearAll(): void {
		for (const mediaId of new Set(
			[...this.sinks.values()].map((s) => s.mediaId),
		)) {
			this.clearVideo({ mediaId });
		}
	}

	getStats() {
		return {
			totalSinks: this.sinks.size,
			activeSinks: Array.from(this.sinks.values()).filter((s) => s.iterator)
				.length,
			cachedFrames: Array.from(this.sinks.values()).filter(
				(s) => s.currentFrame,
			).length,
		};
	}
}

export const videoCache = new VideoCache();
