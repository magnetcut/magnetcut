import type { ExportOptions } from "./index";

export const DEFAULT_EXPORT_OPTIONS = {
	format: "mp4",
	videoCodec: "avc",
	quality: { mode: "level", level: "high" },
	audio: { codec: "aac", kbps: 192, channels: 2 },
} satisfies ExportOptions;
