import { invoke } from "@tauri-apps/api/core";
import {
	ALL_FORMATS,
	BufferTarget,
	canEncodeVideo,
	Conversion,
	Input,
	Output,
	StreamTarget,
	type VideoCodec,
} from "mediabunny";
import { toast } from "sonner";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { EditorCore } from "@/core";
import { adoptSavedFile, openFolderFile } from "@/export/disk-target";
import { createOutputFormat } from "@/export/output-format";
import { canReadDiskFiles, createMediaSource } from "@/media/disk-file";
import { checkEncoderColour } from "@/media/encoder-colour";
import { FILE_CHUNK_SIZE } from "@/services/renderer/scene-exporter";
import type { MediaAsset, MediaProxy } from "./types";

/*
 * Proxies (docs/CONFORM.md, phase 4): a video's small copy, which the preview
 * plays while Export reads the original. Whole files, so a clip can be trimmed
 * anywhere; picture only, as the sound is cheap to decode.
 */

/** A proxy's longer side, in pixels. */
export const PROXY_LONG_SIDE = 960;
// Videos up to this long side play well enough as they are.
const SMALL_LONG_SIDE = 1280;
// Bits per second for a proxy at PROXY_LONG_SIDE, 16:9.
const PROXY_BITRATE = 3e6;

const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);

/** A proxy's size for a video: its shape kept, or null if it's small already. */
export function chooseProxySize({
	width,
	height,
}: {
	width: number;
	height: number;
}): { width: number; height: number } | null {
	const longSide = Math.max(width, height);
	if (!(longSide > SMALL_LONG_SIDE)) return null;
	const scale = PROXY_LONG_SIDE / longSide;
	return { width: even(width * scale), height: even(height * scale) };
}

/** Whether a video can have a proxy: it's big enough to need one. */
export function canHaveProxy({ asset }: { asset: MediaAsset }): boolean {
	return (
		asset.type === "video" &&
		!asset.proxy &&
		chooseProxySize({ width: asset.width ?? 0, height: asset.height ?? 0 }) !==
			null
	);
}

/** "talk.mov" as "talk (proxy 960×540).mp4". */
export function nameProxyFile({
	name,
	size,
	extension,
}: {
	name: string;
	size: { width: number; height: number };
	extension: string;
}): string {
	const stem = name.replace(/\.[^.]*$/, "") || name;
	return `${stem} (proxy ${size.width}×${size.height}).${extension}`;
}

/** H.264 where this computer encodes it, VP9 otherwise. */
async function chooseProxyCodec({
	size,
}: {
	size: { width: number; height: number };
}): Promise<VideoCodec | null> {
	for (const codec of ["avc", "vp9"] as const) {
		const canEncode = await canEncodeVideo(codec, size).catch(() => false);
		if (canEncode) return codec;
	}
	return null;
}

/**
 * A video's proxy, converted: in the desktop app a file in the app's cache
 * (`proxies_folder`), in a browser kept in memory, then with the project.
 */
export async function makeProxy({
	asset,
	signal,
	onProgress,
}: {
	asset: MediaAsset;
	signal?: AbortSignal;
	onProgress?: (progress: number) => void;
}): Promise<MediaProxy> {
	const size = chooseProxySize({
		width: asset.width ?? 0,
		height: asset.height ?? 0,
	});
	if (!size) throw new Error(`"${asset.name}" is small enough as it is.`);
	const codec = await chooseProxyCodec({ size });
	if (!codec) throw new Error("This computer can't encode a proxy.");
	const format = codec === "vp9" ? "webm" : "mp4";
	const name = nameProxyFile({ name: asset.name, size, extension: format });
	const folder = canReadDiskFiles()
		? await invoke<string>("proxies_folder")
		: null;

	const input = new Input({
		source: createMediaSource({ file: asset.file }),
		formats: ALL_FORMATS,
	});
	const opened = folder ? await openFolderFile({ folder, name }) : null;
	// mediabunny closes its stream when it's done and when it's cancelled: the
	// file is kept only once the conversion has finished.
	const writer = opened?.file.writable.getWriter();
	const destination = writer
		? new StreamTarget(
				new WritableStream({ write: (chunk) => writer.write(chunk) }),
				{ chunked: true, chunkSize: FILE_CHUNK_SIZE },
			)
		: new BufferTarget();
	try {
		// WebKit's H.264 says it's full range when it isn't (media/encoder-colour.ts).
		checkEncoderColour();
		const output = new Output({
			format: createOutputFormat({ format, isStreamed: !!writer }),
			target: destination,
		});
		const conversion = await Conversion.init({
			input,
			output,
			video: {
				codec,
				width: size.width,
				height: size.height,
				fit: "fill",
				bitrate: Math.round(
					(PROXY_BITRATE * size.width * size.height) / (960 * 540),
				),
				forceTranscode: true,
				allowRotationMetadata: false,
			},
			audio: { discard: true },
			showWarnings: false,
		});
		if (!conversion.isValid) {
			const reasons = conversion.discardedTracks.map(({ reason }) => reason);
			throw new Error(
				`"${asset.name}" can't be converted here (${reasons.join(", ") || "no picture to convert"}).`,
			);
		}
		const cancel = () => void conversion.cancel();
		signal?.addEventListener("abort", cancel, { once: true });
		conversion.onProgress = (progress) => onProgress?.(progress);
		try {
			await conversion.execute();
		} finally {
			signal?.removeEventListener("abort", cancel);
		}
		if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");

		if (writer && opened) {
			await writer.close();
			const file = await adoptSavedFile({ path: opened.path });
			return { file, ...size };
		}
		const buffer =
			destination instanceof BufferTarget ? destination.buffer : null;
		if (!buffer) throw new Error(`"${asset.name}"'s proxy came out empty.`);
		const file = new File([buffer], name, {
			type: format === "webm" ? "video/webm" : "video/mp4",
		});
		return { file, ...size };
	} catch (error) {
		writer?.releaseLock();
		await opened?.file.discard();
		throw error;
	} finally {
		input.dispose();
	}
}

interface ProxyState {
	/** The preview plays proxies where there are some. */
	isOn: boolean;
	/** The videos waiting, the first being made. */
	queue: string[];
	/** How far the one being made is, 0 to 1. */
	progress: number;
	setOn: (isOn: boolean) => void;
}

export const useProxyStore = create<ProxyState>()(
	persist(
		(set) => ({
			isOn: true,
			queue: [],
			progress: 0,
			setOn: (isOn) => set({ isOn }),
		}),
		{
			name: "magnetcut-proxies",
			partialize: ({ isOn }) => ({ isOn }),
		},
	),
);

let running: { id: string; controller: AbortController } | null = null;

/** Makes proxies for these videos, one after another, behind any already asked for. */
export function queueProxies({
	editor,
	assets,
}: {
	editor: EditorCore;
	assets: MediaAsset[];
}): void {
	const { queue } = useProxyStore.getState();
	const added = assets
		.filter((asset) => canHaveProxy({ asset }))
		.map(({ id }) => id)
		.filter((id) => !queue.includes(id));
	if (added.length === 0) return;
	useProxyStore.setState({ queue: [...queue, ...added] });
	if (!running) void runQueue({ editor });
}

/** Stops making a video's proxy, or takes it out of the queue. */
export function cancelProxy({ id }: { id: string }): void {
	if (running?.id === id) {
		running.controller.abort();
		return;
	}
	useProxyStore.setState(({ queue }) => ({
		queue: queue.filter((queued) => queued !== id),
	}));
}

/** Takes a video's proxy away: the preview plays the original again. */
export async function removeProxy({
	editor,
	id,
}: {
	editor: EditorCore;
	id: string;
}): Promise<void> {
	const project = editor.project.getActiveOrNull();
	if (!project) return;
	await editor.media.setProxy({
		projectId: project.metadata.id,
		id,
		proxy: null,
	});
}

async function runQueue({ editor }: { editor: EditorCore }): Promise<void> {
	for (;;) {
		const [id] = useProxyStore.getState().queue;
		if (!id) return;
		const project = editor.project.getActiveOrNull();
		const asset = editor.media.getAssets().find((item) => item.id === id);
		const controller = new AbortController();
		running = { id, controller };
		useProxyStore.setState({ progress: 0 });
		try {
			if (project && asset && canHaveProxy({ asset })) {
				const proxy = await makeProxy({
					asset,
					signal: controller.signal,
					onProgress: (progress) => useProxyStore.setState({ progress }),
				});
				await editor.media.setProxy({
					projectId: project.metadata.id,
					id,
					proxy,
				});
			}
		} catch (error) {
			if (!controller.signal.aborted) {
				toast.error(`No proxy for "${asset?.name ?? "a video"}"`, {
					description: error instanceof Error ? error.message : String(error),
				});
			}
		} finally {
			running = null;
			useProxyStore.setState(({ queue }) => ({
				queue: queue.filter((queued) => queued !== id),
				progress: 0,
			}));
		}
	}
}
