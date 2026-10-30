"use client";

import { ALL_FORMATS, AudioBufferSink, Input } from "mediabunny";
import { createAudioContext } from "@/media/audio";
import { createMediaSource, type MediaFile } from "@/media/disk-file";
import {
	buildSourceWaveformSummary,
	type SourceWaveformSummary,
	WaveformSummaryBuilder,
} from "@/media/waveform-summary";

interface GetSourceWaveformSummaryArgs {
	sourceKey: string;
	audioBuffer?: AudioBuffer;
	sourceFile?: MediaFile;
	audioUrl?: string;
}

/**
 * A file's waveform, decoded a piece at a time by WebCodecs, so a film's
 * soundtrack is never in memory whole; null if it can't decode it.
 */
async function summarizeStreamed({
	sourceKey,
	file,
}: {
	sourceKey: string;
	file: MediaFile;
}): Promise<SourceWaveformSummary | null> {
	const input = new Input({
		source: createMediaSource({ file }),
		formats: ALL_FORMATS,
	});
	try {
		const track = await input.getPrimaryAudioTrack();
		if (!track || !(await track.canDecode())) return null;
		const builder = new WaveformSummaryBuilder();
		for await (const { buffer } of new AudioBufferSink(track).buffers()) {
			builder.add({ buffer });
		}
		return builder.build({ sourceKey });
	} catch (error) {
		console.warn("Couldn't stream the waveform's audio:", error);
		return null;
	} finally {
		input.dispose();
	}
}

export class WaveformCache {
	private summaries = new Map<string, Promise<SourceWaveformSummary>>();

	getSourceSummary({
		sourceKey,
		audioBuffer,
		sourceFile,
		audioUrl,
	}: GetSourceWaveformSummaryArgs): Promise<SourceWaveformSummary> {
		const existing = this.summaries.get(sourceKey);
		if (existing) {
			return existing;
		}

		const promise = this.buildSummary({
			sourceKey,
			audioBuffer,
			sourceFile,
			audioUrl,
		}).catch((error) => {
			this.summaries.delete(sourceKey);
			throw error;
		});

		this.summaries.set(sourceKey, promise);
		return promise;
	}

	clearSource({ sourceKey }: { sourceKey: string }): void {
		this.summaries.delete(sourceKey);
	}

	clearAll(): void {
		this.summaries.clear();
	}

	private async buildSummary({
		sourceKey,
		audioBuffer,
		sourceFile,
		audioUrl,
	}: GetSourceWaveformSummaryArgs): Promise<SourceWaveformSummary> {
		if (audioBuffer) {
			return buildSourceWaveformSummary({ sourceKey, buffer: audioBuffer });
		}

		let arrayBuffer: ArrayBuffer | null = null;
		if (sourceFile) {
			const summary = await summarizeStreamed({ sourceKey, file: sourceFile });
			if (summary) return summary;
			// The web view's own decoder, which takes the file whole: only for an
			// audio file, which is small.
			if (!sourceFile.type.startsWith("audio/")) {
				throw new Error(`Can't decode the audio of ${sourceKey}`);
			}
			arrayBuffer = await sourceFile.arrayBuffer();
		} else if (audioUrl) {
			const response = await fetch(audioUrl);
			if (!response.ok) {
				throw new Error(`Failed to fetch waveform source: ${response.status}`);
			}
			arrayBuffer = await response.arrayBuffer();
		}

		if (!arrayBuffer) {
			throw new Error(`No waveform source available for ${sourceKey}`);
		}

		const audioContext = createAudioContext();
		try {
			const buffer = await audioContext.decodeAudioData(arrayBuffer.slice(0));
			return buildSourceWaveformSummary({ sourceKey, buffer });
		} finally {
			void audioContext.close();
		}
	}
}

export const waveformCache = new WaveformCache();
