import { invoke, isTauri } from "@tauri-apps/api/core";
import { BlobSource, StreamSource, type Source } from "mediabunny";

/** As the desktop app describes a file (apps/desktop/src/media.rs). */
interface DiskFileInfo {
	path: string;
	name: string;
	size: number;
	lastModified: number;
}

// The most the desktop app returns at once (MAX_READ in media.rs).
const MAX_READ = 64 * 1024 * 1024;

// What the file picker offers, as types: the editor tells media apart by them.
const MIME_TYPES: Record<string, string> = {
	mp4: "video/mp4",
	m4v: "video/mp4",
	mov: "video/quicktime",
	mkv: "video/x-matroska",
	webm: "video/webm",
	avi: "video/x-msvideo",
	mts: "video/mp2t",
	m2ts: "video/mp2t",
	ts: "video/mp2t",
	"3gp": "video/3gpp",
	mp3: "audio/mpeg",
	m4a: "audio/mp4",
	aac: "audio/aac",
	wav: "audio/wav",
	flac: "audio/flac",
	ogg: "audio/ogg",
	oga: "audio/ogg",
	opus: "audio/opus",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	avif: "image/avif",
	bmp: "image/bmp",
	svg: "image/svg+xml",
};

function mimeTypeFromName({ name }: { name: string }) {
	const extension = name.split(".").pop()?.toLowerCase() ?? "";
	return MIME_TYPES[extension] ?? "";
}

/**
 * A file on this computer that the desktop app reads where it is, by the piece,
 * rather than one copied into the web view's storage (docs/NATIVE.md).
 */
export class DiskFile {
	readonly path: string;
	readonly name: string;
	readonly size: number;
	readonly lastModified: number;
	readonly type: string;

	constructor({ path, name, size, lastModified }: DiskFileInfo) {
		this.path = path;
		this.name = name;
		this.size = size;
		this.lastModified = lastModified;
		this.type = mimeTypeFromName({ name });
	}

	async read({ start, end }: { start: number; end: number }) {
		const bytes = await invoke<ArrayBuffer>("read_media_file", {
			path: this.path,
			start,
			end,
		});
		return new Uint8Array(bytes);
	}

	/** All of it, in memory, as `File.arrayBuffer` would. */
	async arrayBuffer(): Promise<ArrayBuffer> {
		const bytes = new Uint8Array(this.size);
		for (let start = 0; start < this.size; start += MAX_READ) {
			const end = Math.min(this.size, start + MAX_READ);
			bytes.set(await this.read({ start, end }), start);
		}
		return bytes.buffer;
	}

	/** Its bytes in memory, for what needs a `File`: images, which are small. */
	async toFile(): Promise<File> {
		return new File([await this.arrayBuffer()], this.name, {
			type: this.type,
			lastModified: this.lastModified,
		});
	}
}

/** A media file's bytes: in the web view's storage, or where it is on disk. */
export type MediaFile = File | DiskFile;

/** An object URL for a file in memory; none for one read on disk. */
export function createObjectUrl({ file }: { file: MediaFile }) {
	return file instanceof DiskFile ? undefined : URL.createObjectURL(file);
}

/** Where mediabunny reads a media file from. */
export function createMediaSource({ file }: { file: MediaFile }): Source {
	if (!(file instanceof DiskFile)) return new BlobSource(file);
	return new StreamSource({
		getSize: () => file.size,
		read: (start, end) => file.read({ start, end }),
		prefetchProfile: "fileSystem",
	});
}

/** Whether media can stay where it is: in the desktop app. */
export const canReadDiskFiles = () => isTauri();

/** The open dialog: the files picked, which the editor may read from now on. */
export async function pickDiskFiles(): Promise<DiskFile[]> {
	const infos = await invoke<DiskFileInfo[]>("pick_media_files");
	return infos.map((info) => new DiskFile(info));
}

/** A file the editor was given before, as it is now; null if it's gone. */
export async function openDiskFile({
	path,
}: {
	path: string;
}): Promise<DiskFile | null> {
	const info = await invoke<DiskFileInfo | null>("media_file_info", { path });
	return info ? new DiskFile(info) : null;
}

/**
 * Dropped files as files on disk, where the desktop app knows their paths (on
 * macOS, from the drag pasteboard); the others stay as they are, to be copied.
 */
export async function findDroppedDiskFiles({
	files,
}: {
	files: File[];
}): Promise<MediaFile[]> {
	if (!canReadDiskFiles() || files.length === 0) return files;
	let dropped: DiskFile[];
	try {
		const infos = await invoke<DiskFileInfo[]>("dropped_media_files");
		dropped = infos.map((info) => new DiskFile(info));
	} catch (error) {
		console.warn("Couldn't find the dropped files on disk", error);
		return files;
	}
	return files.map(
		(file) =>
			dropped.find(
				(candidate) =>
					candidate.name === file.name && candidate.size === file.size,
			) ?? file,
	);
}
