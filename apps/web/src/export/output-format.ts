import {
	MkvOutputFormat,
	MovOutputFormat,
	Mp4OutputFormat,
	WebMOutputFormat,
	type OutputFormat,
} from "mediabunny";
import type { ExportFormat } from "./index";

/** The container, with MP4's and MOV's index at the end when written to a file as it goes. */
export function createOutputFormat({
	format,
	isStreamed,
}: {
	format: ExportFormat;
	isStreamed: boolean;
}): OutputFormat {
	const fastStart = isStreamed ? false : "in-memory";
	switch (format) {
		case "mp4":
			return new Mp4OutputFormat({ fastStart });
		case "mov":
			return new MovOutputFormat({ fastStart });
		case "mkv":
			return new MkvOutputFormat();
		case "webm":
			return new WebMOutputFormat();
	}
}
