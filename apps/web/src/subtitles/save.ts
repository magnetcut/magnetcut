import type { SubtitleFormat } from "magnetcut-wasm";
import { openExportFile, pickExportFile } from "@/export/disk-target";
import { canReadDiskFiles } from "@/media/disk-file";
import { downloadBlob } from "@/utils/browser";

const EXTENSIONS: Record<SubtitleFormat, string> = {
	srt: "srt",
	vtt: "vtt",
	ass: "ass",
	ssa: "ssa",
	subviewer: "sub",
	microdvd: "sub",
};

export const SUBTITLE_FORMAT_NAMES: Record<SubtitleFormat, string> = {
	srt: "SubRip (SRT)",
	vtt: "WebVTT",
	ass: "Advanced SubStation (ASS)",
	ssa: "SubStation Alpha (SSA)",
	subviewer: "SubViewer",
	microdvd: "MicroDVD",
};

/** A subtitle file's text saved: in the desktop app where its save dialog
 * says, else downloaded. False if the dialog was cancelled. */
export async function saveSubtitleFile({
	text,
	name,
	format,
	besidePath,
}: {
	text: string;
	name: string;
	format: SubtitleFormat;
	besidePath?: string;
}): Promise<boolean> {
	const extension = EXTENSIONS[format];
	const bytes = new TextEncoder().encode(text);
	if (!canReadDiskFiles()) {
		downloadBlob({
			blob: new Blob([bytes], { type: "text/plain;charset=utf-8" }),
			filename: `${name}.${extension}`,
		});
		return true;
	}
	const path = await pickExportFile({ name, extension, besidePath });
	if (!path) return false;
	const file = await openExportFile({ path });
	const writer = file.writable.getWriter();
	try {
		await writer.write({ type: "write", data: bytes, position: 0 });
		await writer.close();
	} catch (error) {
		await file.discard();
		throw error;
	}
	return true;
}
