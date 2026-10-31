import { canEncodeVideo } from "mediabunny";
import type { ExportFormat } from "./index";
import { getNativeCapabilities } from "./native";
import {
	isNativeOnlyCodec,
	type ExportVideoCodec,
	type WebVideoCodec,
} from "./settings";

/** The codecs this computer encodes a picture this big in, for `format`: the
 * web view's, and the desktop app's own where it takes that format. */
export async function findEncodableCodecs({
	width,
	height,
	format,
}: {
	width: number;
	height: number;
	format: ExportFormat;
}): Promise<Set<ExportVideoCodec>> {
	const codecs: WebVideoCodec[] = ["avc", "hevc", "vp9", "av1"];
	const [results, native] = await Promise.all([
		Promise.all(
			codecs.map((codec) =>
				canEncodeVideo(codec, { width, height }).catch(() => false),
			),
		),
		getNativeCapabilities(),
	]);
	const found = new Set<ExportVideoCodec>(
		codecs.filter((_, index) => results[index]),
	);
	for (const codec of native?.videoCodecs ?? []) {
		const fits =
			isNativeOnlyCodec(codec) ||
			(native?.formats.includes(format) &&
				(codec !== "av1" || format === "mp4"));
		if (fits) found.add(codec);
	}
	return found;
}
