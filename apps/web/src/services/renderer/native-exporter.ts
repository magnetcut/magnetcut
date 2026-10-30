import EventEmitter from "eventemitter3";
import { mediaTimeToSeconds } from "magnetcut-wasm";
import { TICKS_PER_SECOND } from "@/wasm";
import { DiskFile } from "@/media/disk-file";
import {
	NATIVE_FORMATS,
	NATIVE_VIDEO_CODECS,
	NativeExportSession,
	probeNativeSources,
	type NativeExportOptions,
	type NativeSourceInfo,
	type NativeVideoFrame,
} from "@/export/native";
import type { ExportFormat } from "@/export";
import type { FilterPasses } from "@/export/filters";
import type { ExportVideoCodec } from "@/export/settings";
import type { AnyBaseNode } from "./nodes/base-node";
import { BlurBackgroundNode } from "./nodes/blur-background-node";
import type { RootNode } from "./nodes/root-node";
import { VideoNode } from "./nodes/video-node";
import { CanvasRenderer } from "./canvas-renderer";
import { buildFrameDescriptor } from "./compositor/frame-descriptor";
import type { TextureUploadDescriptor } from "./compositor/types";
import { resolveRenderTree, type VideoReferences } from "./resolve";

/** The scene's videos, and whether anything draws from their frames itself. */
function collectVideos({ node }: { node: AnyBaseNode }) {
	const files = new Set<VideoNode["params"]["file"]>();
	let drawsFrames = false;
	const visit = (current: AnyBaseNode) => {
		if (current instanceof VideoNode) files.add(current.params.file);
		// Its backdrop is a video's frame, drawn and blurred in the web view.
		if (current instanceof BlurBackgroundNode) drawsFrames = true;
		for (const child of current.children) visit(child);
	};
	visit(node);
	return { files: [...files], drawsFrames };
}

/** The scene's videos by path, for the native export; or why it can't make this one. */
export type NativeSources =
	| { sources: Map<string, NativeSourceInfo> }
	| { reason: string };

/**
 * The scene's videos as the native export sees them, by path, if it can make
 * this export: on macOS, into MP4 or QuickTime, in H.264, HEVC or ProRes with
 * AAC or no sound, from videos on disk that AVFoundation decodes (turned as
 * they're shown: their sizes are). Otherwise why not, and the web view makes
 * it (but ProRes).
 */
export async function findNativeSources({
	rootNode,
	format,
	videoCodec,
	audioCodec,
}: {
	rootNode: RootNode;
	format: ExportFormat;
	videoCodec: ExportVideoCodec;
	/** The sound's in the file, encoded or copied: null for none. */
	audioCodec: string | null;
}): Promise<NativeSources> {
	if (!NATIVE_FORMATS.includes(format)) {
		return { reason: "it makes only MP4 and QuickTime files" };
	}
	if (!NATIVE_VIDEO_CODECS.includes(videoCodec)) {
		return { reason: "it encodes only H.264, HEVC and ProRes" };
	}
	if (audioCodec && audioCodec !== "aac") {
		return { reason: `it copies only AAC sound, and this is ${audioCodec}` };
	}
	const { files, drawsFrames } = collectVideos({ node: rootNode });
	if (drawsFrames) return { reason: "a clip has a blurred background" };
	const paths: string[] = [];
	for (const file of files) {
		if (!(file instanceof DiskFile)) {
			return { reason: `${file.name} isn't read from the disk` };
		}
		paths.push(file.path);
	}
	const infos = await probeNativeSources({ paths });
	if (!infos) return { reason: "there's no native export here" };
	const sources = new Map<string, NativeSourceInfo>();
	for (const [index, info] of infos.entries()) {
		const name = paths[index].split(/[\\/]/).pop();
		if (!info) return { reason: `the Mac can't decode ${name}` };
		sources.set(paths[index], info);
	}
	return { sources };
}

/** A window of the mix, interleaved, in as many channels as encoded. */
function interleave({
	buffer,
	channels,
}: {
	buffer: AudioBuffer;
	channels: number;
}): Float32Array {
	const samples = new Float32Array(buffer.length * channels);
	if (channels === 1) {
		for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
			const source = buffer.getChannelData(channel);
			for (let i = 0; i < buffer.length; i++) {
				samples[i] += source[i] / buffer.numberOfChannels;
			}
		}
		return samples;
	}
	for (let channel = 0; channel < channels; channel++) {
		const source = buffer.getChannelData(
			Math.min(channel, buffer.numberOfChannels - 1),
		);
		for (let i = 0; i < buffer.length; i++) {
			samples[i * channels + channel] = source[i];
		}
	}
	return samples;
}

// How far ahead of the frames the mix is sent, in seconds. AVAssetWriter
// interleaves the two by what it has encoded, and the AAC encoder holds back
// nearly a second of sound: frames sent up to where the sound ends wait for
// sound that isn't there yet (apps/desktop/src/render/tests.rs).
const AUDIO_LEAD = 3;

/** The mix, sent a window at a time ahead of the frames. */
class NativeSoundtrack {
	private readonly windows: AsyncGenerator<AudioBuffer, void, undefined>;
	private readonly session: NativeExportSession;
	private readonly channels: number;
	/** The window after those sent, read to know which is the last. */
	private following: IteratorResult<AudioBuffer, void> | null = null;
	private time = 0;
	private isDone = false;

	constructor({
		windows,
		session,
		channels,
	}: {
		windows: AsyncGenerator<AudioBuffer, void, undefined>;
		session: NativeExportSession;
		channels: number;
	}) {
		this.windows = windows;
		this.session = session;
		this.channels = channels;
	}

	/** Sends windows until the mix is well past `time` seconds, or all sent. */
	async addUntil({ time }: { time: number }) {
		while (!this.isDone && this.time <= time + AUDIO_LEAD) {
			const current = this.following ?? (await this.windows.next());
			this.following = current.done ? current : await this.windows.next();
			const isLast = !!this.following.done;
			await this.session.audio({
				samples: current.done
					? new Float32Array(0)
					: interleave({ buffer: current.value, channels: this.channels }),
				isLast,
			});
			if (!current.done) this.time += current.value.duration;
			this.isDone = isLast;
		}
	}
}

type UploadedTexture = { key: unknown; width: number; height: number };

/**
 * The editor's drawings for the native side: each drawn and sent when it
 * changes. Videos are sent as references, for the native side to decode.
 */
class NativeTextures {
	private uploaded = new Map<string, UploadedTexture>();
	private canvases = new Map<string, OffscreenCanvas>();

	constructor(private readonly session: NativeExportSession) {}

	/** The frame's video references, and the textures it no longer uses. */
	async sync({ textures }: { textures: TextureUploadDescriptor[] }) {
		const ids = new Set(textures.map((texture) => texture.id));
		const released = [...this.uploaded.keys()].filter((id) => !ids.has(id));
		for (const id of released) {
			this.uploaded.delete(id);
			this.canvases.delete(id);
		}

		const videos: NativeVideoFrame[] = [];
		for (const texture of textures) {
			const { id, width, height } = texture;
			if (texture.kind === "video") {
				const { file, streamKey, time } = texture.reference;
				if (!(file instanceof DiskFile)) {
					throw new Error(`${file.name} isn't on disk`);
				}
				videos.push({ textureId: id, path: file.path, streamKey, time });
				this.uploaded.set(id, { key: null, width, height });
				continue;
			}
			const key =
				texture.kind === "rendered" ? texture.contentHash : texture.source;
			const previous = this.uploaded.get(id);
			if (
				previous?.key === key &&
				previous.width === width &&
				previous.height === height
			) {
				continue;
			}
			const pixels = this.draw({ texture });
			await this.session.uploadTexture({ id, width, height, pixels });
			this.uploaded.set(id, { key, width, height });
		}
		return { videos, released };
	}

	private draw({
		texture,
	}: {
		texture: Exclude<TextureUploadDescriptor, { kind: "video" }>;
	}): Uint8ClampedArray {
		const { id, width, height } = texture;
		let canvas = this.canvases.get(id);
		if (!canvas || canvas.width !== width || canvas.height !== height) {
			canvas = new OffscreenCanvas(width, height);
			this.canvases.set(id, canvas);
		}
		const context = canvas.getContext("2d", { willReadFrequently: true });
		if (!context) throw new Error(`Couldn't draw texture ${id}`);
		context.clearRect(0, 0, width, height);
		if (texture.kind === "rendered") {
			texture.draw(context);
		} else {
			context.drawImage(texture.source, 0, 0, width, height);
		}
		return context.getImageData(0, 0, width, height).data;
	}
}

type NativeExporterParams = {
	options: NativeExportOptions;
	/** The scene's videos, by path (`findNativeSources`). */
	sources: Map<string, NativeSourceInfo>;
	/** The mix, a window at a time (`mixTimelineAudio`), if there's sound. */
	audio?: AsyncGenerator<AudioBuffer, void, undefined>;
	/** Filters on each video and on the frame (`export/filters.ts`). */
	filters?: FilterPasses;
};

export type NativeExporterEvents = {
	progress: [progress: number];
};

/** An export made by the desktop app, natively, from the scene's descriptions. */
export class NativeSceneExporter extends EventEmitter<NativeExporterEvents> {
	private readonly params: NativeExporterParams;
	private isCancelled = false;

	constructor(params: NativeExporterParams) {
		super();
		this.params = params;
	}

	cancel(): void {
		this.isCancelled = true;
	}

	/** Whether the file was made: false if cancelled. */
	async export({ rootNode }: { rootNode: RootNode }): Promise<boolean> {
		const session = await NativeExportSession.start({
			options: this.params.options,
		});
		try {
			const isMade = await this.write({ rootNode, session });
			if (!isMade) {
				await session.cancel();
				return false;
			}
			await session.finish();
			this.emit("progress", 1);
			return true;
		} catch (error) {
			await session.cancel().catch(() => {});
			throw error;
		} finally {
			// Stops the mix where it got to, closing its files.
			await this.params.audio?.return(undefined);
		}
	}

	private async write({
		rootNode,
		session,
	}: {
		rootNode: RootNode;
		session: NativeExportSession;
	}): Promise<boolean> {
		const { options, sources, audio, filters } = this.params;
		const { fps } = options;
		const renderer = new CanvasRenderer({
			width: options.width,
			height: options.height,
			fps,
		});
		const ticksPerFrame = Math.round(
			(TICKS_PER_SECOND * fps.denominator) / fps.numerator,
		);
		const frameCount = Math.floor(rootNode.duration / ticksPerFrame);
		const videoReferences: VideoReferences = {
			getSize: ({ file }) =>
				file instanceof DiskFile ? (sources.get(file.path) ?? null) : null,
		};
		const textures = new NativeTextures(session);
		const soundtrack =
			audio && options.audio
				? new NativeSoundtrack({
						windows: audio,
						session,
						channels: options.audio.channels,
					})
				: null;

		for (let i = 0; i < frameCount; i++) {
			if (this.isCancelled) return false;
			const time = i * ticksPerFrame;
			await soundtrack?.addUntil({ time: mediaTimeToSeconds({ time }) });
			await resolveRenderTree({
				node: rootNode,
				renderer,
				time,
				videoReferences,
			});
			const { frame, textures: frameTextures } = await buildFrameDescriptor({
				node: rootNode,
				renderer,
				filters,
			});
			const { videos, released } = await textures.sync({
				textures: frameTextures,
			});
			await session.frame({ frame, videos, released });
			this.emit("progress", i / frameCount);
		}
		if (this.isCancelled) return false;
		await soundtrack?.addUntil({ time: Infinity });
		return true;
	}
}
