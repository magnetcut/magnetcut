import {
	MkvOutputFormat,
	MovOutputFormat,
	Mp4OutputFormat,
	WebMOutputFormat,
	type MetadataTags,
	type OutputFormat,
} from "mediabunny";
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

/** The program that wrote the file, where ffprobe and MediaInfo look for it: MP4's encoding
 * tool (©too), QuickTime's software (©swr), Matroska's ENCODER tag. */
export function getWritingAppTags({
	format,
	writingApp,
}: {
	format: ExportFormat;
	writingApp: string;
}): MetadataTags {
	switch (format) {
		case "mp4":
			return { raw: { "©too": writingApp } };
		case "mov":
			return { raw: { "©swr": writingApp } };
		case "mkv":
		case "webm":
			return { raw: { ENCODER: writingApp } };
	}
}
