import {
	EncodedPacket,
	VideoSampleSink,
	type InputVideoTrack,
} from "mediabunny";

// Smart Cut's encoder: the frames from a cut to the next key frame, decoded
// from the file and encoded again in its codec, at its size, each run
// starting with a key frame. The web view's own encoders (WebCodecs).

export type SmartCutCodec = "avc" | "vp9";

// Frames waiting in the encoder before more are given: a few, so the decoded
// pictures held stay few.
const MAX_ENCODE_QUEUE = 4;
// The re-encoded frames get more bits than the source had on average: they're
// few, and a key frame comes first.
const BITRATE_FACTOR = 1.5;
const MIN_BITRATE = 1_000_000;
// Closer than this, in seconds, is the same time.
const EPSILON = 1e-6;

function isWebKit(): boolean {
	const { userAgent } = navigator;
	return (
		/AppleWebKit/.test(userAgent) && !/Chrome|Chromium|Edg/.test(userAgent)
	);
}

/**
 * The codec strings to try, the source's first. WebKit's H.264 encoder puts
 * out nothing in the Main and High profiles (`preferBaselineInWebKit`), so
 * there Baseline comes first; its frames join the source's all the same.
 */
export function getEncoderCodecs({
	codec,
	sourceCodec,
	isWebKit: webKit,
}: {
	codec: SmartCutCodec;
	sourceCodec: string;
	isWebKit: boolean;
}): string[] {
	if (codec === "vp9") {
		return [...new Set([sourceCodec, "vp09.00.40.08", "vp09.00.10.08"])];
	}
	const level =
		/^avc[13]\.[0-9a-f]{4}([0-9a-f]{2})$/i.exec(sourceCodec)?.[1] ?? "33";
	const high = `avc1.6400${level}`;
	const main = `avc1.4d00${level}`;
	const baseline = `avc1.4200${level}`;
	const candidates = webKit
		? [baseline, "avc1.420033", sourceCodec, main]
		: [sourceCodec, high, main, baseline, "avc1.640033", "avc1.420033"];
	return [...new Set(candidates)];
}

/** An encoded packet, and the description it was made under (H.264's parameter sets). */
export interface EncodedPiecePacket {
	packet: EncodedPacket;
	description: Uint8Array | null;
}

export interface PieceEncoder {
	/**
	 * Encodes the frame of `track` at `at` and throws it away: what it's
	 * encoded under. A source's frames all are, so a frame of each tells the
	 * file's description, before it's written, what the encoder will use.
	 */
	survey: (frame: {
		track: InputVideoTrack;
		at: number;
		colour: VideoColorSpaceInit;
	}) => Promise<Uint8Array | null>;
	/**
	 * The frames of `track` from `from` up to `to`, encoded, the first a key
	 * frame, at their time in the file plus `offset`, in the colour space of
	 * the frames they're joined to (`colour`, the source's).
	 */
	encode: (piece: {
		track: InputVideoTrack;
		from: number;
		to: number;
		offset: number;
		colour: VideoColorSpaceInit;
	}) => Promise<EncodedPiecePacket[]>;
	close: () => void;
}

export function toBytes({
	source,
}: {
	source: AllowSharedBufferSource;
}): Uint8Array {
	// No `SharedArrayBuffer` to test against where the page isn't cross-origin
	// isolated, as in the app's web view.
	return ArrayBuffer.isView(source)
		? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
		: new Uint8Array(source);
}

// The YUV formats of WebCodecs: their bit depth, the chroma planes' size
// against the luma's (horizontally, vertically), and whether the chroma is
// one plane of U and V side by side.
const YUV_FORMATS: Record<
	string,
	{ depth: number; across: number; down: number; interleaved?: boolean }
> = {
	I420: { depth: 8, across: 2, down: 2 },
	I420A: { depth: 8, across: 2, down: 2 },
	I420P10: { depth: 10, across: 2, down: 2 },
	I420AP10: { depth: 10, across: 2, down: 2 },
	I420P12: { depth: 12, across: 2, down: 2 },
	I420AP12: { depth: 12, across: 2, down: 2 },
	I422: { depth: 8, across: 2, down: 1 },
	I422A: { depth: 8, across: 2, down: 1 },
	I422P10: { depth: 10, across: 2, down: 1 },
	I422AP10: { depth: 10, across: 2, down: 1 },
	I422P12: { depth: 12, across: 2, down: 1 },
	I422AP12: { depth: 12, across: 2, down: 1 },
	I444: { depth: 8, across: 1, down: 1 },
	I444A: { depth: 8, across: 1, down: 1 },
	I444P10: { depth: 10, across: 1, down: 1 },
	I444AP10: { depth: 10, across: 1, down: 1 },
	I444P12: { depth: 12, across: 1, down: 1 },
	I444AP12: { depth: 12, across: 1, down: 1 },
	NV12: { depth: 8, across: 1, down: 2, interleaved: true },
};

/**
 * What each sample becomes going from one range to the other, luma and
 * chroma: limited is 16 to 235 (chroma 16 to 240) at 8 bits, full 0 to 255.
 */
export function makeRangeTables({
	depth,
	toFull,
}: {
	depth: number;
	toFull: boolean;
}): { luma: Uint16Array; chroma: Uint16Array } {
	const size = 2 ** depth;
	const max = size - 1;
	const scale = 2 ** (depth - 8);
	const half = size / 2;
	const luma = new Uint16Array(size);
	const chroma = new Uint16Array(size);
	const clamp = (value: number) =>
		Math.min(max, Math.max(0, Math.round(value)));
	for (let value = 0; value < size; value++) {
		luma[value] = clamp(
			toFull
				? ((value - 16 * scale) * max) / (219 * scale)
				: 16 * scale + (value * 219 * scale) / max,
		);
		chroma[value] = clamp(
			toFull
				? half + ((value - half) * max) / (224 * scale)
				: half + ((value - half) * 224 * scale) / max,
		);
	}
	return { luma, chroma };
}

/**
 * The frame in `colour`, its samples moved into that range when its own is
 * the other: WebKit decodes limited-range video to full range, and its
 * encoder writes the samples as they come, under the range the frame says.
 * Null when the frame is already in that range.
 */
export async function toColourSpace({
	frame,
	colour,
}: {
	frame: VideoFrame;
	colour: VideoColorSpaceInit;
}): Promise<VideoFrame | null> {
	const own = frame.colorSpace.fullRange;
	const toFull = colour.fullRange ?? false;
	const yuv = frame.format ? YUV_FORMATS[frame.format] : undefined;
	if (
		own === null ||
		own === toFull ||
		!frame.format ||
		!yuv ||
		!frame.visibleRect
	) {
		return null;
	}
	const { width, height } = frame.visibleRect;
	const data = new Uint8Array(frame.allocationSize());
	const layout = await frame.copyTo(data);
	const tables = makeRangeTables({ depth: yuv.depth, toFull });
	const wide = yuv.depth > 8;
	// Luma, then the chroma planes; an alpha plane stays as it is.
	const planes = yuv.interleaved ? 2 : 3;
	for (let plane = 0; plane < planes; plane++) {
		const { offset, stride } = layout[plane];
		const table = plane === 0 ? tables.luma : tables.chroma;
		const rows = plane === 0 ? height : Math.ceil(height / yuv.down);
		const chromaWidth = Math.ceil(width / (yuv.interleaved ? 2 : yuv.across));
		// NV12's chroma plane has U and V side by side: twice the samples.
		const samples =
			plane === 0 ? width : yuv.interleaved ? chromaWidth * 2 : chromaWidth;
		for (let row = 0; row < rows; row++) {
			const start = offset + row * stride;
			if (wide) {
				const line = new Uint16Array(data.buffer, start, samples);
				for (let i = 0; i < samples; i++) line[i] = table[line[i]];
			} else {
				for (let i = start; i < start + samples; i++) data[i] = table[data[i]];
			}
		}
	}
	return new VideoFrame(data, {
		format: frame.format,
		codedWidth: width,
		codedHeight: height,
		displayWidth: frame.displayWidth,
		displayHeight: frame.displayHeight,
		timestamp: frame.timestamp,
		duration: frame.duration ?? undefined,
		layout,
		colorSpace: colour,
	});
}

/** The web view's encoder for this codec at this size, or null if it has none. */
export async function openPieceEncoder({
	codec,
	sourceCodec,
	width,
	height,
	sourceBitrate,
	frameRate,
}: {
	codec: SmartCutCodec;
	sourceCodec: string;
	width: number;
	height: number;
	/** The source's average, in bits a second. */
	sourceBitrate: number;
	frameRate: number;
}): Promise<PieceEncoder | null> {
	if (typeof VideoEncoder === "undefined") return null;
	const bitrate = Math.max(
		MIN_BITRATE,
		Math.round(sourceBitrate * BITRATE_FACTOR),
	);
	let config: VideoEncoderConfig | null = null;
	for (const candidate of getEncoderCodecs({
		codec,
		sourceCodec,
		isWebKit: isWebKit(),
	})) {
		const tried: VideoEncoderConfig = {
			codec: candidate,
			width,
			height,
			bitrate,
			framerate: frameRate,
			latencyMode: "quality",
			bitrateMode: "variable",
			...(codec === "avc" && { avc: { format: "avc" } }),
		};
		const support = await VideoEncoder.isConfigSupported(tried).catch(
			() => null,
		);
		if (support?.supported) {
			config = tried;
			break;
		}
	}
	if (!config) return null;

	// Set by the encoder's callbacks: what it put out, the description it
	// last said it makes (it says so again when that changes, as it does with
	// the frames' colour space), and what went wrong.
	const state: {
		packets: EncodedPiecePacket[];
		description: Uint8Array | null;
		failure: Error | null;
	} = { packets: [], description: null, failure: null };
	const encoder = new VideoEncoder({
		output: (chunk, metadata) => {
			const description = metadata?.decoderConfig?.description;
			if (description)
				state.description = toBytes({ source: description }).slice();
			state.packets.push({
				packet: EncodedPacket.fromEncodedChunk(chunk),
				description: state.description,
			});
		},
		error: (error) => {
			state.failure = error;
		},
	});
	encoder.configure(config);
	const close = () => {
		if (encoder.state !== "closed") encoder.close();
	};
	const waitForQueue = async () => {
		while (encoder.encodeQueueSize > MAX_ENCODE_QUEUE) {
			await new Promise((resolve) => setTimeout(resolve, 2));
		}
	};
	const take = () => {
		const packets = state.packets;
		state.packets = [];
		return packets;
	};

	return {
		survey: async ({ track, at, colour }) => {
			const sample = await new VideoSampleSink(track).getSample(at);
			if (!sample) return state.description;
			try {
				const frame = sample.toVideoFrame();
				const converted = await toColourSpace({ frame, colour });
				encoder.encode(converted ?? frame, { keyFrame: true });
				converted?.close();
				frame.close();
			} finally {
				sample.close();
			}
			await encoder.flush();
			if (state.failure) throw state.failure;
			const [encoded] = take();
			return encoded?.description ?? state.description;
		},
		encode: async ({ track, from, to, offset, colour }) => {
			const sink = new VideoSampleSink(track);
			let isFirst = true;
			for await (const sample of sink.samples(from, to)) {
				try {
					// The frame shown at `from` may have started just before it.
					if (sample.timestamp < from - EPSILON) continue;
					const timestamp = Math.max(
						0,
						Math.round((sample.timestamp + offset) * 1e6),
					);
					const decoded = sample.toVideoFrame();
					const converted = await toColourSpace({ frame: decoded, colour });
					const frame = new VideoFrame(converted ?? decoded, {
						timestamp,
						duration: Math.round(sample.duration * 1e6),
					});
					converted?.close();
					decoded.close();
					await waitForQueue();
					encoder.encode(frame, { keyFrame: isFirst });
					frame.close();
					isFirst = false;
				} finally {
					sample.close();
				}
				if (state.failure) throw state.failure;
			}
			await encoder.flush();
			if (state.failure) throw state.failure;
			return take();
		},
		close,
	};
}
