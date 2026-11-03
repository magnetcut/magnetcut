// Bits of H.264's bitstream (ITU-T H.264, 7.2 and 7.4.1): the RBSP inside a
// NAL unit, read and written a bit at a time, with Exp-Golomb codes.

/** A NAL unit's payload with its emulation prevention bytes taken out. */
export function unescapeRbsp({ nal }: { nal: Uint8Array }): Uint8Array {
	const out = new Uint8Array(nal.length);
	let length = 0;
	let zeros = 0;
	for (let i = 0; i < nal.length; i++) {
		const byte = nal[i];
		if (zeros >= 2 && byte === 3) {
			zeros = 0;
			continue;
		}
		out[length++] = byte;
		zeros = byte === 0 ? zeros + 1 : 0;
	}
	return out.subarray(0, length);
}

/** An RBSP made into a NAL unit's payload: no start code can appear in it. */
export function escapeRbsp({ rbsp }: { rbsp: Uint8Array }): Uint8Array {
	const out = new Uint8Array(rbsp.length + Math.ceil(rbsp.length / 2) + 1);
	let length = 0;
	let zeros = 0;
	for (let i = 0; i < rbsp.length; i++) {
		const byte = rbsp[i];
		if (zeros >= 2 && byte <= 3) {
			out[length++] = 3;
			zeros = 0;
		}
		out[length++] = byte;
		zeros = byte === 0 ? zeros + 1 : 0;
	}
	// An RBSP ending in a zero byte (CABAC's zero words) gets a last 0x03.
	if (length > 0 && out[length - 1] === 0) out[length++] = 3;
	return out.subarray(0, length);
}

/** Where the RBSP's stop bit is, counted in bits: its last bit set. */
export function findStopBit({ rbsp }: { rbsp: Uint8Array }): number {
	for (let i = rbsp.length - 1; i >= 0; i--) {
		const byte = rbsp[i];
		if (byte === 0) continue;
		let bit = 7;
		while (!((byte >> (7 - bit)) & 1)) bit--;
		return i * 8 + bit;
	}
	throw new Error("The NAL unit has no stop bit");
}

export class BitReader {
	readonly data: Uint8Array;
	position: number;

	constructor({ data, position = 0 }: { data: Uint8Array; position?: number }) {
		this.data = data;
		this.position = position;
	}

	bit(): number {
		const byte = this.data[this.position >> 3];
		if (byte === undefined)
			throw new Error("Read past the end of the NAL unit");
		const value = (byte >> (7 - (this.position & 7))) & 1;
		this.position++;
		return value;
	}

	flag(): boolean {
		return this.bit() === 1;
	}

	/** An unsigned number of `count` bits, up to 32. */
	bits({ count }: { count: number }): number {
		let value = 0;
		for (let i = 0; i < count; i++) value = value * 2 + this.bit();
		return value;
	}

	skip({ count }: { count: number }): void {
		this.position += count;
	}

	/** ue(v): an unsigned Exp-Golomb code. */
	ue(): number {
		let zeros = 0;
		while (this.bit() === 0) {
			zeros++;
			if (zeros > 31) throw new Error("An Exp-Golomb code too long");
		}
		return 2 ** zeros - 1 + this.bits({ count: zeros });
	}

	/** se(v): a signed Exp-Golomb code. */
	se(): number {
		const code = this.ue();
		return code % 2 === 1 ? (code + 1) / 2 : -(code / 2) || 0;
	}
}

export class BitWriter {
	private buffer = new Uint8Array(256);
	private length = 0;
	// Bits not yet in `buffer`, and how many.
	private pending = 0;
	private pendingCount = 0;

	get bitLength(): number {
		return this.length * 8 + this.pendingCount;
	}

	private push({ byte }: { byte: number }): void {
		if (this.length === this.buffer.length) {
			const grown = new Uint8Array(this.buffer.length * 2);
			grown.set(this.buffer);
			this.buffer = grown;
		}
		this.buffer[this.length++] = byte;
	}

	bit({ value }: { value: number }): void {
		this.pending = (this.pending << 1) | (value & 1);
		this.pendingCount++;
		if (this.pendingCount === 8) {
			this.push({ byte: this.pending });
			this.pending = 0;
			this.pendingCount = 0;
		}
	}

	bits({ value, count }: { value: number; count: number }): void {
		for (let i = count - 1; i >= 0; i--) {
			this.bit({ value: Math.floor(value / 2 ** i) % 2 });
		}
	}

	ue({ value }: { value: number }): void {
		const code = value + 1;
		const length = Math.floor(Math.log2(code));
		this.bits({ value: 0, count: length });
		this.bits({ value: code, count: length + 1 });
	}

	/** The bits of `data` from `from` to `to`, as they are. */
	copy({ data, from, to }: { data: Uint8Array; from: number; to: number }) {
		let position = from;
		while (position < to && position & 7) {
			this.bit({ value: (data[position >> 3] >> (7 - (position & 7))) & 1 });
			position++;
		}
		const wholeBytes = (to - position) >> 3;
		const start = position >> 3;
		if (this.pendingCount === 0) {
			this.ensure({ extra: wholeBytes });
			this.buffer.set(data.subarray(start, start + wholeBytes), this.length);
			this.length += wholeBytes;
		} else {
			const shift = this.pendingCount;
			let pending = this.pending;
			this.ensure({ extra: wholeBytes });
			for (let i = 0; i < wholeBytes; i++) {
				const byte = data[start + i];
				this.buffer[this.length++] =
					((pending << (8 - shift)) | (byte >> shift)) & 0xff;
				pending = byte & ((1 << shift) - 1);
			}
			this.pending = pending;
		}
		position += wholeBytes * 8;
		while (position < to) {
			this.bit({ value: (data[position >> 3] >> (7 - (position & 7))) & 1 });
			position++;
		}
	}

	/** Whole bytes, once the writer is at a byte's start. */
	bytes({ data }: { data: Uint8Array }): void {
		if (this.pendingCount !== 0)
			throw new Error("Bytes written off a byte boundary");
		this.ensure({ extra: data.length });
		this.buffer.set(data, this.length);
		this.length += data.length;
	}

	isAligned(): boolean {
		return this.pendingCount === 0;
	}

	/** rbsp_trailing_bits(): the stop bit, then zeros to the byte's end. */
	finish(): Uint8Array {
		this.bit({ value: 1 });
		while (this.pendingCount !== 0) this.bit({ value: 0 });
		return this.buffer.slice(0, this.length);
	}

	/** What's written, which must end on a byte's end. */
	take(): Uint8Array {
		if (this.pendingCount !== 0) throw new Error("Not on a byte boundary");
		return this.buffer.slice(0, this.length);
	}

	private ensure({ extra }: { extra: number }): void {
		const needed = this.length + extra;
		if (needed <= this.buffer.length) return;
		let size = this.buffer.length;
		while (size < needed) size *= 2;
		const grown = new Uint8Array(size);
		grown.set(this.buffer.subarray(0, this.length));
		this.buffer = grown;
	}
}
