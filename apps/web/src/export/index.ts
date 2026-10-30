import type { FrameRate } from "magnetcut-wasm";
import { EXPORT_MIME_TYPES } from "./mime-types";
import type {
	ExportAudioSettings,
	ExportCrop,
	ExportVideoCodec,
	ExportVideoQuality,
} from "./settings";

export const EXPORT_QUALITY_VALUES = [
	"low",
	"medium",
	"high",
	"very_high",
] as const;

export const EXPORT_FORMAT_VALUES = ["mp4", "mov", "mkv", "webm"] as const;

export type ExportFormat = (typeof EXPORT_FORMAT_VALUES)[number];
export type ExportQuality = (typeof EXPORT_QUALITY_VALUES)[number];

export interface ExportOptions {
	format: ExportFormat;
	videoCodec: ExportVideoCodec;
	quality: ExportVideoQuality;
	/** The shorter side of the picture; the project's size if none. */
	shortSide?: number;
	/** What's cut from the picture's edges, before it's scaled. */
	crop?: ExportCrop;
	fps?: FrameRate;
	/** None: no sound. */
	audio: ExportAudioSettings | null;
	/** In the desktop app, the file picked in its save dialog, written as it's made. */
	path?: string;
}

export interface ExportResult {
	success: boolean;
	buffer?: ArrayBuffer;
	/** Where it was saved, when it went to a file. */
	path?: string;
	error?: string;
	cancelled?: boolean;
}

export interface ExportState {
	isExporting: boolean;
	progress: number;
	result: ExportResult | null;
}

export function getExportMimeType({
	format,
}: {
	format: ExportFormat;
}): string {
	return EXPORT_MIME_TYPES[format];
}

export function getExportFileExtension({
	format,
}: {
	format: ExportFormat;
}): string {
	return `.${format}`;
}

export function downloadBuffer({
	buffer,
	filename,
	mimeType,
}: {
	buffer: ArrayBuffer;
	filename: string;
	mimeType: string;
}): void {
	const blob = new Blob([buffer], { type: mimeType });
	const url = URL.createObjectURL(blob);
	const downloadLink = document.createElement("a");
	downloadLink.href = url;
	downloadLink.download = filename;
	document.body.appendChild(downloadLink);
	downloadLink.click();
	document.body.removeChild(downloadLink);
	URL.revokeObjectURL(url);
}
