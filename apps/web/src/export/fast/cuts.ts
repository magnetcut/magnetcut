// Where Fast mode cuts a clip out of its file. Packets are copied in decode
// order from a key frame; the copy stops at the first packet shown at or past
// the clip's end, so that every frame copied can be decoded (a B-frame needs
// the frame after it). Smart Cut re-encodes what that leaves out at either end.

/** What a cut needs to know of a packet: when it's shown, for how long. */
export interface PacketTiming {
	/** In seconds. */
	timestamp: number;
	duration: number;
}

/** A file's video packets, looked up. */
export interface PacketLookup<Packet extends PacketTiming = PacketTiming> {
	/** The frame shown at `time`: the last one starting at or before it, or the first. */
	frameAt: (time: number) => Promise<Packet | null>;
	/** The last key frame at or before `time` that decoding can start afresh from, or the first. */
	keyAt: (time: number) => Promise<Packet | null>;
	/** The next such key frame after `packet`, in decode order. */
	nextKey: (packet: Packet) => Promise<Packet | null>;
	/** The packets from `packet` on, in decode order. */
	packetsFrom: (packet: Packet) => AsyncIterable<PacketTiming>;
}

/** How a clip is cut, in seconds of its file. */
export interface ClipCut<Packet extends PacketTiming = PacketTiming> {
	/** Where its first frame starts. */
	start: number;
	/** Where its last frame ends. */
	end: number;
	/** Re-encoded first: the frames from `start` up to this, if any. */
	headEnd: number | null;
	/** Copied: the packets from this key frame, if any... */
	copyFrom: Packet | null;
	/** ...up to the first one shown at or past this. */
	copyUntil: number;
	/** Re-encoded last: the frames from this to the clip's end, if any. */
	tailStart: number | null;
}

// Closer than this, in seconds, is the same time.
const EPSILON = 1e-6;

/** Where a copy from `copyFrom` up to `until` ends: the end of its last frame. */
async function findCopyEnd<Packet extends PacketTiming>({
	lookup,
	copyFrom,
	until,
}: {
	lookup: PacketLookup<Packet>;
	copyFrom: Packet;
	until: number;
}): Promise<number> {
	// Only the key frame's group of pictures the clip ends in can hold a frame
	// past its end, so the search starts there.
	const last = await lookup.frameAt(until - EPSILON);
	const lastKey = last ? await lookup.keyAt(last.timestamp) : null;
	const from =
		lastKey && lastKey.timestamp > copyFrom.timestamp ? lastKey : copyFrom;
	let end = copyFrom.timestamp;
	for await (const packet of lookup.packetsFrom(from)) {
		const step = getCopyStep({ packet, copyFrom, until });
		if (step === "stop") break;
		if (step === "copy")
			end = Math.max(end, packet.timestamp + packet.duration);
	}
	return end;
}

/**
 * How the clip from `from` to `to` in its file is cut: copied from the key
 * frame before `from`; or, with `smart`, re-encoded from `from` to the next
 * key frame, copied from there, and its last frames re-encoded where the copy
 * stops short. Null if the file has nothing there.
 */
export async function planClipCut<Packet extends PacketTiming>({
	lookup,
	from,
	to,
	smart,
}: {
	lookup: PacketLookup<Packet>;
	from: number;
	to: number;
	smart: boolean;
}): Promise<ClipCut<Packet> | null> {
	if (!smart) {
		const key = await lookup.keyAt(from);
		if (!key || key.timestamp >= to - EPSILON) return null;
		const end = await findCopyEnd({ lookup, copyFrom: key, until: to });
		return {
			start: key.timestamp,
			end,
			headEnd: null,
			copyFrom: key,
			copyUntil: to,
			tailStart: null,
		};
	}

	const first = await lookup.frameAt(from);
	const last = await lookup.frameAt(to - EPSILON);
	if (!first || !last || first.timestamp >= to - EPSILON) return null;
	const start = first.timestamp;
	const end = last.timestamp + last.duration;

	const key = await lookup.keyAt(start);
	let copyFrom: Packet | null = null;
	let headEnd: number | null = null;
	if (key && Math.abs(key.timestamp - start) < EPSILON) {
		copyFrom = key;
	} else {
		let next = key ? await lookup.nextKey(key) : null;
		while (next && next.timestamp <= start + EPSILON) {
			next = await lookup.nextKey(next);
		}
		if (next && next.timestamp < to - EPSILON) {
			copyFrom = next;
			headEnd = next.timestamp;
		} else {
			headEnd = to;
		}
	}
	if (!copyFrom) {
		return {
			start,
			end,
			headEnd,
			copyFrom: null,
			copyUntil: to,
			tailStart: null,
		};
	}
	const copyEnd = await findCopyEnd({ lookup, copyFrom, until: to });
	return {
		start,
		end,
		headEnd,
		copyFrom,
		copyUntil: to,
		tailStart: copyEnd < end - EPSILON ? copyEnd : null,
	};
}

/** Whether a packet is part of a copy from `copyFrom` up to `until`, and whether it ends it. */
export function getCopyStep({
	packet,
	copyFrom,
	until,
}: {
	packet: PacketTiming;
	copyFrom: PacketTiming;
	until: number;
}): "copy" | "skip" | "stop" {
	if (packet.timestamp >= until - EPSILON) return "stop";
	// Shown before the key frame: an open group's leading frame, which needs
	// the frames before it.
	if (packet.timestamp < copyFrom.timestamp) return "skip";
	return "copy";
}
