/*
 * WAV files, 16-bit PCM: what a recording is written as while it's made, its
 * sizes filled in as it grows, so what's on disk plays even if the app stops.
 */

export const WAV_HEADER_BYTES = 44;

/** The 44 bytes before the samples, for `dataBytes` of them. */
export function buildWavHeader({
	sampleRate,
	channels,
	dataBytes,
}: {
	sampleRate: number;
	channels: number;
	dataBytes: number;
}): Uint8Array<ArrayBuffer> {
	const header = new Uint8Array(WAV_HEADER_BYTES);
	const view = new DataView(header.buffer);
	const text = ({ at, value }: { at: number; value: string }) => {
		for (let index = 0; index < value.length; index++) {
			header[at + index] = value.charCodeAt(index);
		}
	};
	text({ at: 0, value: "RIFF" });
	view.setUint32(4, 36 + dataBytes, true);
	text({ at: 8, value: "WAVE" });
	text({ at: 12, value: "fmt " });
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, channels, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * channels * 2, true);
	view.setUint16(32, channels * 2, true);
	view.setUint16(34, 16, true);
	text({ at: 36, value: "data" });
	view.setUint32(40, dataBytes, true);
	return header;
}

/** Samples from -1 to 1 as 16-bit PCM, the channels interleaved. */
export function floatsToPcm16({
	channels,
}: {
	channels: Float32Array[];
}): Uint8Array<ArrayBuffer> {
	const length = channels[0]?.length ?? 0;
	const bytes = new Uint8Array(length * channels.length * 2);
	const view = new DataView(bytes.buffer);
	let offset = 0;
	for (let index = 0; index < length; index++) {
		for (const channel of channels) {
			const sample = Math.max(-1, Math.min(1, channel[index] ?? 0));
			view.setInt16(
				offset,
				Math.round(sample < 0 ? sample * 0x8000 : sample * 0x7fff),
				true,
			);
			offset += 2;
		}
	}
	return bytes;
}

/** A WAV file's length in seconds, from its header: null if it isn't one. */
export function readWavDuration({
	bytes,
}: {
	bytes: ArrayBuffer;
}): number | null {
	const view = new DataView(bytes);
	const tag = (at: number) =>
		String.fromCharCode(
			view.getUint8(at),
			view.getUint8(at + 1),
			view.getUint8(at + 2),
			view.getUint8(at + 3),
		);
	if (bytes.byteLength < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") {
		return null;
	}
	let byteRate = 0;
	let at = 12;
	while (at + 8 <= bytes.byteLength) {
		const id = tag(at);
		const size = view.getUint32(at + 4, true);
		if (id === "fmt " && at + 20 <= bytes.byteLength) {
			byteRate = view.getUint32(at + 16, true);
		}
		if (id === "data") {
			if (!byteRate) return null;
			// A size left unfilled (streamed) is the rest of the file.
			const available = bytes.byteLength - at - 8;
			const dataBytes = size === 0 || size > available ? available : size;
			return dataBytes / byteRate;
		}
		at += 8 + size + (size % 2);
	}
	return null;
}
