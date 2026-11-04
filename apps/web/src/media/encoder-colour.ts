import type { InputVideoTrack } from "mediabunny";
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

/**
 * The colour space a track's pictures are in: H.264's from its SPS, which
 * each frame is decoded by, others' from the container. Limited range if
 * unsaid.
 */
export async function readTrackColour({
	video,
	config,
}: {
	video: InputVideoTrack;
	config: VideoDecoderConfig | null;
}): Promise<VideoColorSpaceInit> {
	const stream = config ? readStreamColour({ config }) : null;
	if (stream) return stream;
	const colour = await video.getColorSpace();
	return {
		primaries: colour.primaries ?? null,
		transfer: colour.transfer ?? null,
		matrix: colour.matrix ?? null,
		fullRange: colour.fullRange ?? false,
	};
}

const FIELDS = ["primaries", "transfer", "matrix", "fullRange"] as const;

const isSameColour = ({
	a,
	b,
}: {
	a: VideoColorSpaceInit | undefined;
	b: VideoColorSpaceInit;
}) => FIELDS.every((field) => (a?.[field] ?? null) === (b[field] ?? null));

/**
 * The colour a file made from an encoder's output says it's in: its SPS's,
 * and where that says nothing, its decoder config's, which mediabunny writes
 * in the MP4's colour box when it says all of it (WebKitGTK's says BT.601 of
 * frames that leave it unsaid). Null if it isn't H.264.
 */
export function readWrittenColour({
	config,
}: {
	config: VideoDecoderConfig;
}): VideoColorSpaceInit | null {
	const stream = readStreamColour({ config });
	if (!stream) return null;
	const claimed = config.colorSpace;
	const box =
		claimed && FIELDS.every((field) => claimed[field] != null) ? claimed : null;
	return {
		primaries: stream.primaries ?? box?.primaries ?? null,
		transfer: stream.transfer ?? box?.transfer ?? null,
		matrix: stream.matrix ?? box?.matrix ?? null,
		fullRange: stream.fullRange,
	};
}

/**
 * What an encoder's decoder config should say of its colour; null if it's
 * right. `written` is the colour space of the YUV frames it was given, if it
 * was: their samples are coded as they are, so they say what the stream
 * doesn't (WebKit's SPS says nothing of the matrix, and its config says
 * BT.709 whatever the frames are).
 */
export function correctEncodedColour({
	config,
	written,
}: {
	config: VideoDecoderConfig;
	written?: VideoColorSpaceInit | null;
}): VideoColorSpaceInit | null {
	const claimed = config.colorSpace;
	const stream = readStreamColour({ config });
	if (stream && written) {
		const colour = {
			primaries: stream.primaries ?? written.primaries ?? null,
			transfer: stream.transfer ?? written.transfer ?? null,
			matrix: stream.matrix ?? written.matrix ?? null,
			fullRange: stream.fullRange ?? written.fullRange ?? null,
		};
		return isSameColour({ a: claimed, b: colour }) ? null : colour;
	}
	if (!claimed || claimed.fullRange == null) return null;
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

// WebCodecs' YUV formats: I420, I422, I444 and their kin, and NV12.
const YUV_FORMAT = /^(I4|NV)/;

let isChecking = false;

/**
 * From now on, what the web view's video encoders say of their colour is
 * checked against their stream and the frames they're given, and put right
 * (above). Once is enough.
 */
export function checkEncoderColour(): void {
	if (isChecking || typeof VideoEncoder === "undefined") return;
	isChecking = true;
	const Encoder = VideoEncoder;
	class CheckedEncoder extends Encoder {
		readonly #frames: { written: VideoColorSpaceInit | null };

		constructor(init: VideoEncoderInit) {
			const frames: { written: VideoColorSpaceInit | null } = {
				written: null,
			};
			super({
				...init,
				output: (chunk, metadata) => {
					const config = metadata?.decoderConfig;
					const colorSpace = config
						? correctEncodedColour({ config, written: frames.written })
						: null;
					init.output(
						chunk,
						config && colorSpace
							? { ...metadata, decoderConfig: { ...config, colorSpace } }
							: metadata,
					);
				},
			});
			this.#frames = frames;
		}

		// eslint-disable-next-line magnetcut/prefer-object-params -- VideoEncoder's own signature.
		override encode(frame: VideoFrame, options?: VideoEncoderEncodeOptions) {
			this.#frames.written =
				frame.format && YUV_FORMAT.test(frame.format)
					? frame.colorSpace.toJSON()
					: null;
			super.encode(frame, options);
		}
	}
	globalThis.VideoEncoder = CheckedEncoder;
}
