import type { EditorCore } from "@/core";
import { pickFolder } from "@/export/disk-target";
import { canReadDiskFiles, DiskFile } from "@/media/disk-file";
import {
	addMediaFile,
	replaceClipsMedia,
	secondsToTicks,
	type Replacement,
} from "@/media/replace";
import type { ConformPlan } from "./conform";
import { convertFile, getConvertedPart, type ConformFit } from "./convert";

export interface ConformProgress {
	/** The file being converted, counted from 0. */
	index: number;
	count: number;
	name: string;
	/** Of that file, 0 to 1. */
	progress: number;
}

export interface ConformResult {
	/** The files converted, whose clips now use the new ones. */
	converted: number;
	/** Whether it stopped before the end. */
	cancelled: boolean;
}

/**
 * The plan's files converted one after another, and the main track's clips
 * that used them given the new files, in one step that Undo takes back. In
 * the desktop app a folder is asked for first, beside the first file; null if
 * that's cancelled.
 */
export async function runConform({
	editor,
	plan,
	fit,
	wholeFiles,
	signal,
	onProgress,
}: {
	editor: EditorCore;
	plan: ConformPlan;
	fit: ConformFit;
	wholeFiles: boolean;
	signal: AbortSignal;
	onProgress: (progress: ConformProgress) => void;
}): Promise<ConformResult | null> {
	const [first] = plan.files;
	if (!first) return { converted: 0, cancelled: false };
	let folder: string | null = null;
	if (canReadDiskFiles()) {
		folder = await pickFolder({
			title: "Where the converted files go",
			besidePath:
				first.file.asset.file instanceof DiskFile
					? first.file.asset.file.path
					: undefined,
		});
		if (!folder) return null;
	}

	const replacements: Replacement[] = [];
	let cancelled = false;
	try {
		for (const [index, { file }] of plan.files.entries()) {
			if (signal.aborted) {
				cancelled = true;
				break;
			}
			const part = wholeFiles ? null : getConvertedPart({ file });
			const report = (progress: number) =>
				onProgress({
					index,
					count: plan.files.length,
					name: file.asset.name,
					progress,
				});
			report(0);
			let converted;
			try {
				converted = await convertFile({
					file,
					target: plan.target,
					sound: plan.sound,
					colour: plan.colour,
					fit,
					part,
					folder,
					signal,
					onProgress: report,
				});
			} catch (error) {
				if (signal.aborted) {
					cancelled = true;
					break;
				}
				throw error;
			}
			const asset = await addMediaFile({ editor, file: converted });
			if (!asset) throw new Error(`"${converted.name}" couldn't be added.`);
			const main = editor.scenes.getActiveScene().tracks.main;
			for (const element of main.elements) {
				if (!("mediaId" in element) || element.mediaId !== file.asset.id) {
					continue;
				}
				replacements.push({
					trackId: main.id,
					elementId: element.id,
					asset,
					offset: part ? secondsToTicks(part.start) : 0,
				});
			}
		}
	} finally {
		// What's finished is used, even when a later file fails or is cancelled.
		replaceClipsMedia({ editor, replacements });
	}
	return {
		converted: new Set(replacements.map(({ asset }) => asset.id)).size,
		cancelled,
	};
}
