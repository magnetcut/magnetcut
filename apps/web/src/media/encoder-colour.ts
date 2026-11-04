import { parseAvcConfig, readSpsColour } from "@/export/fast/h264";

/*
 * WebKit's H.264 encoder (macOS 27's) writes its pictures in limited range,
 * under an SPS that says nothing of colour, which in H.264 means limited; yet
 * its decoder config says full range and sRGB, whatever frames it's given.
 * mediabunny writes the MP4's colour box from that config, and ffmpeg, VLC and
 * QuickTime believe the box: the files look washed out everywhere but in
 * WebKit, which follows the stream. So the config is put right from the
 * stream's own SPS wherever the two disagree on the range.
 */

const toBytes = (source: AllowSharedBufferSource) =>
	ArrayBuffer.isView(source)
		? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
		: new Uint8Array(source);

/** What an H.264 stream's own SPS says of its colour; null if it isn't H.264. */
export function readStreamColour({
	config,
}: {
	config: VideoDecoderConfig;
}): VideoColorSpaceInit | null {
	if (!/^avc[13]\./.test(config.codec) || !config.description) return null;
	try {
		const [sps] = parseAvcConfig({ data: toBytes(config.description) }).sps;
		return sps ? readSpsColour({ unit: sps }) : null;
	} catch {
		return null;
	}
}

/** What an encoder's decoder config should say of its colour; null if it's right. */
export function correctEncodedColour({
	config,
}: {
	config: VideoDecoderConfig;
}): VideoColorSpaceInit | null {
	const claimed = config.colorSpace;
	if (!claimed || claimed.fullRange == null) return null;
	const stream = readStreamColour({ config });
	if (!stream || claimed.fullRange === stream.fullRange) return null;
	return {
		primaries: stream.primaries ?? claimed.primaries ?? null,
		// sRGB is the canvas's, not the video's: the pictures are the source's
		// samples as they were, under the transfer video has.
		transfer:
			stream.transfer ??
			(claimed.transfer === "iec61966-2-1" ? "bt709" : claimed.transfer) ??
			null,
		matrix: stream.matrix ?? claimed.matrix ?? null,
		fullRange: stream.fullRange,
	};
}

let isChecking = false;

/**
 * From now on, what the web view's video encoders say of their colour is
 * checked against their stream, and put right (above). Once is enough.
 */
export function checkEncoderColour(): void {
	if (isChecking || typeof VideoEncoder === "undefined") return;
	isChecking = true;
	const Encoder = VideoEncoder;
	class CheckedEncoder extends Encoder {
		constructor(init: VideoEncoderInit) {
			super({
				...init,
				output: (chunk, metadata) => {
					const config = metadata?.decoderConfig;
					const colorSpace = config ? correctEncodedColour({ config }) : null;
					init.output(
						chunk,
						config && colorSpace
							? { ...metadata, decoderConfig: { ...config, colorSpace } }
							: metadata,
					);
				},
			});
		}
	}
	globalThis.VideoEncoder = CheckedEncoder;
}
