import {
	MkvOutputFormat,
	MovOutputFormat,
	Mp4OutputFormat,
	WebMOutputFormat,
	type MetadataTags,
	type OutputFormat,
} from "mediabunny";
import { getDateTime, type FileTags } from "@/project/file-tags";
import type { ExportFormat } from "./index";

/** The container, with MP4's and MOV's index at the end when written to a file as it goes, and
 * Matroska's WritingApp the program writing it (mediabunny's, patched). */
export function createOutputFormat({
	format,
	isStreamed,
	writingApp,
}: {
	format: ExportFormat;
	isStreamed: boolean;
	writingApp?: string;
}): OutputFormat {
	const fastStart = isStreamed ? false : "in-memory";
	switch (format) {
		case "mp4":
			return new Mp4OutputFormat({ fastStart });
		case "mov":
			return new MovOutputFormat({ fastStart });
		case "mkv":
			return new MkvOutputFormat({ writingApp });
		case "webm":
			return new WebMOutputFormat({ writingApp });
	}
}

// Where the program that wrote the file goes, as ffprobe and MediaInfo
// look for it: MP4's encoding tool, QuickTime's software, Matroska's ENCODER
// tag.
const WRITING_APP_KEYS: Record<ExportFormat, string> = {
	mp4: "©too",
	mov: "©swr",
	mkv: "ENCODER",
	webm: "ENCODER",
};

/**
 * The tags written: the program that wrote the file (`WRITING_APP_KEYS`), and
 * the project's details. In a QuickTime file they're its user data (©nam and
 * the others), the place and the camera too (©xyz, ©mak, ©mod), as Apple's
 * frameworks read them, and the day as a date and time, as they misread a day
 * alone. In an MP4 they're iTunes' items, where Apple's frameworks and
 * Android's read no place or camera: the desktop app writes an MP4's details
 * itself as it puts the file in place (`ExportFile.commit`), and these are
 * for one downloaded. Matroska has no tags for the place or the camera.
 */
export function getOutputTags({
	format,
	writingApp,
	tags = {},
}: {
	format: ExportFormat;
	writingApp: string;
	tags?: FileTags;
}): MetadataTags {
	const raw: Record<string, string> = {
		[WRITING_APP_KEYS[format]]: writingApp,
	};
	const isQuickTime = format === "mov";
	if (format === "mp4" || isQuickTime) {
		if (tags.location) raw["©xyz"] = tags.location;
		if (tags.make) raw["©mak"] = tags.make;
		if (tags.model) raw["©mod"] = tags.model;
	}
	if (isQuickTime && tags.date) raw["©day"] = getDateTime({ day: tags.date });
	return {
		...(tags.title && { title: tags.title }),
		...(tags.artist && { artist: tags.artist }),
		...(tags.genre && { genre: tags.genre }),
		...(tags.description && { description: tags.description }),
		...(tags.comment && { comment: tags.comment }),
		...(tags.date &&
			!isQuickTime && { date: new Date(getDateTime({ day: tags.date })) }),
		raw,
	};
}
