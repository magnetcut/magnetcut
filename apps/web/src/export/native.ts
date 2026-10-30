import { invoke, isTauri } from "@tauri-apps/api/core";
import type { FrameRate } from "magnetcut-wasm";
import type { FrameDescriptor } from "@/services/renderer/compositor/types";
import type { ExportFormat } from "./index";
import type { ExportCrop, ExportVideoCodec } from "./settings";

// The desktop app's native export (apps/desktop/src/render/, docs/NATIVE.md):
// the system decodes and encodes (AVFoundation on macOS, Media Foundation on
// Windows, GStreamer on Linux), and the compositor draws each frame on the
// GPU. The editor sends
// frames' descriptions, its own drawings and the mix; the frames themselves
// never cross.

/** A source as the system's decoder sees it. */
export interface NativeSourceInfo {
	width: number;
	height: number;
	/** Clockwise, in degrees. */
	rotation: number;
}

/**
 * What the native export makes on this computer. On a Mac: MP4 and QuickTime;
 * H.264, HEVC, ProRes, and AV1 in software (rav1e). On Windows and Linux:
 * MP4, in the codecs the system has encoders for.
 */
export interface NativeCapabilities {
	formats: ExportFormat[];
	videoCodecs: ExportVideoCodec[];
	/** H.264 and HEVC at a constant quality: on Apple silicon. */
	constantQuality: boolean;
	/** Whether a source's sound can be copied as it's stored. */
	audioCopy: boolean;
	/** Whether subtitle tracks can be written (timed text, on a Mac). */
	subtitleTracks: boolean;
}

let capabilities: Promise<NativeCapabilities | null> | undefined;

/** Null where there's no native export: in a browser. */
export function getNativeCapabilities(): Promise<NativeCapabilities | null> {
	capabilities ??= isTauri()
		? invoke<NativeCapabilities>("native_export_capabilities").catch(() => null)
		: Promise.resolve(null);
	return capabilities;
}

/**
 * What the native export makes of each file, by path: null for each it
 * can't decode, and null altogether where there's no native export.
 */
export async function probeNativeSources({
	paths,
}: {
	paths: string[];
}): Promise<(NativeSourceInfo | null)[] | null> {
	if (!isTauri()) return null;
	try {
		return await invoke<(NativeSourceInfo | null)[]>("native_export_probe", {
			paths,
		});
	} catch {
		// Not on this system: the app has no such command.
		return null;
	}
}

export interface NativeExportOptions {
	/** Picked in the save dialog. */
	path: string;
	format: ExportFormat;
	/** The project's size, which frames are drawn at. */
	width: number;
	height: number;
	crop?: ExportCrop;
	outputWidth: number;
	outputHeight: number;
	fps: FrameRate;
	videoCodec: ExportVideoCodec;
	/** In bits a second. */
	videoBitrate: number;
	/** A constant quality instead, from 0 to 1, where the encoder takes it. */
	videoQuality?: number;
	/** AAC from the mix: float samples, interleaved. */
	audio: { channels: number; sampleRate: number; bitrate: number } | null;
	/** Or a source's sound, copied as it is up to `end` seconds. */
	audioCopy?: { path: string; end: number };
	/** Subtitle tracks, written as timed text (tx3g), as Apple's players show. */
	subtitles?: Array<{
		cues: Array<{ start: number; end: number; text: string }>;
	}>;
}

/** A video's frame for the native side to decode into a texture. */
export interface NativeVideoFrame {
	textureId: string;
	path: string;
	streamKey?: string;
	/** In the source, in seconds. */
	time: number;
}

/** One export, made by the desktop app; each call waits while it's behind. */
export class NativeExportSession {
	private constructor(private readonly id: number) {}

	static async start({
		options,
	}: {
		options: NativeExportOptions;
	}): Promise<NativeExportSession> {
		const id = await invoke<number>("native_export_start", { options });
		return new NativeExportSession(id);
	}

	/** One of the editor's drawings: RGBA, straight alpha. */
	async uploadTexture({
		id,
		width,
		height,
		pixels,
	}: {
		id: string;
		width: number;
		height: number;
		pixels: Uint8ClampedArray;
	}) {
		const bytes = new Uint8Array(
			pixels.buffer,
			pixels.byteOffset,
			pixels.byteLength,
		);
		await invoke("native_export_texture", bytes, {
			headers: {
				session: String(this.id),
				"texture-id": id,
				width: String(width),
				height: String(height),
			},
		});
	}

	/** The next frame, and the drawings it no longer uses. */
	async frame({
		frame,
		videos,
		released,
	}: {
		frame: FrameDescriptor;
		videos: NativeVideoFrame[];
		released: string[];
	}) {
		await invoke("native_export_frame", {
			session: this.id,
			frame,
			videos,
			released,
		});
	}

	/**
	 * The mix's next samples, and whether they're its last: the encoder
	 * holds back the end of the sound, and the frames with it, until told.
	 */
	async audio({ samples, isLast }: { samples: Float32Array; isLast: boolean }) {
		const bytes = new Uint8Array(
			samples.buffer,
			samples.byteOffset,
			samples.byteLength,
		);
		await invoke("native_export_audio", bytes, {
			headers: { session: String(this.id), last: String(isLast) },
		});
	}

	async finish() {
		await invoke("native_export_finish", { session: this.id });
	}

	/** Stops, deleting what was written. */
	async cancel() {
		await invoke("native_export_cancel", { session: this.id });
	}
}
