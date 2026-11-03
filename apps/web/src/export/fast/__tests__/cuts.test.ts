import { describe, expect, test } from "bun:test";
import {
	getCopyStep,
	planClipCut,
	type PacketLookup,
	type PacketTiming,
} from "../cuts";

// Times in frames: a frame lasts 1.
interface Packet extends PacketTiming {
	key: boolean;
}

/** A file's packets in decode order, looked up as the exporter does. */
function makeLookup({ packets }: { packets: Packet[] }): PacketLookup<Packet> {
	const shown = [...packets].sort((a, b) => a.timestamp - b.timestamp);
	return {
		frameAt: async (time) =>
			shown.findLast((packet) => packet.timestamp <= time + 1e-9) ??
			shown[0] ??
			null,
		keyAt: async (time) =>
			packets.findLast(
				(packet) => packet.key && packet.timestamp <= time + 1e-9,
			) ??
			packets.find((packet) => packet.key) ??
			null,
		nextKey: async (packet) =>
			packets.slice(packets.indexOf(packet) + 1).find((next) => next.key) ??
			null,
		packetsFrom: async function* (packet) {
			yield* packets.slice(packets.indexOf(packet));
		},
	};
}

/** Packets from their times in decode order; keys marked with a "k". */
function makeStream({ order }: { order: (number | `${number}k`)[] }): Packet[] {
	return order.map((entry) => ({
		timestamp: Number.parseFloat(String(entry)),
		duration: 1,
		key: String(entry).endsWith("k"),
	}));
}

describe("planClipCut", () => {
	// Two closed groups of 10 frames, I B B P B B P B B P: each P-frame is
	// decoded before the B-frames shown before it.
	const lookup = makeLookup({
		packets: makeStream({
			order: [
				"0k",
				3,
				1,
				2,
				6,
				4,
				5,
				9,
				7,
				8,
				"10k",
				13,
				11,
				12,
				16,
				14,
				15,
				19,
				17,
				18,
			],
		}),
	});

	test("No re-encoding starts at the key frame before the cut", async () => {
		const cut = await planClipCut({ lookup, from: 3, to: 15, smart: false });
		expect(cut).toMatchObject({
			start: 0,
			headEnd: null,
			tailStart: null,
			copyUntil: 15,
		});
		expect(cut?.copyFrom?.timestamp).toBe(0);
		// Frame 14 is a B-frame needing P-frame 16, past the end: left out.
		expect(cut?.end).toBe(14);
	});

	test("Smart Cut re-encodes to the next key frame, and the frames the copy leaves", async () => {
		const cut = await planClipCut({ lookup, from: 3, to: 15, smart: true });
		expect(cut).toMatchObject({
			start: 3,
			end: 15,
			headEnd: 10,
			tailStart: 14,
		});
		expect(cut?.copyFrom?.timestamp).toBe(10);
	});

	test("a cut on a key frame is copied from it", async () => {
		const cut = await planClipCut({ lookup, from: 10, to: 16, smart: true });
		expect(cut).toMatchObject({
			start: 10,
			end: 16,
			headEnd: null,
			tailStart: 14,
		});
		expect(cut?.copyFrom?.timestamp).toBe(10);
	});

	test("a cut mid-frame starts at that frame", async () => {
		const cut = await planClipCut({ lookup, from: 3.5, to: 13, smart: true });
		expect(cut).toMatchObject({ start: 3, end: 13, headEnd: 10 });
	});

	test("the B-frames decoded after a P-frame past the end are re-encoded", async () => {
		// P-frame 13 ends the copy before B-frames 11 and 12.
		const cut = await planClipCut({ lookup, from: 0, to: 13, smart: true });
		expect(cut).toMatchObject({
			start: 0,
			end: 13,
			headEnd: null,
			tailStart: 11,
		});
	});

	test("ending after a P-frame's B-frames, nothing is re-encoded", async () => {
		const cut = await planClipCut({ lookup, from: 0, to: 14, smart: true });
		expect(cut).toMatchObject({
			start: 0,
			end: 14,
			headEnd: null,
			tailStart: null,
		});
	});

	test("a clip with no key frame in it is re-encoded whole", async () => {
		const cut = await planClipCut({ lookup, from: 3, to: 8, smart: true });
		expect(cut).toEqual({
			start: 3,
			end: 8,
			headEnd: 8,
			copyFrom: null,
			copyUntil: 8,
			tailStart: null,
		});
	});

	test("nothing to cut where the file has no frames", async () => {
		const empty = makeLookup({ packets: [] });
		expect(
			await planClipCut({ lookup: empty, from: 0, to: 5, smart: true }),
		).toBeNull();
		expect(
			await planClipCut({ lookup: empty, from: 0, to: 5, smart: false }),
		).toBeNull();
	});

	describe("an open GOP", () => {
		// B-frames 7 and 8 are decoded after key frame 9 and need P-frame 6.
		const open = makeLookup({
			packets: makeStream({
				order: ["0k", 3, 1, 2, 6, 4, 5, "9k", 7, 8, 12, 10, 11, 15, 13, 14],
			}),
		});

		test("its key frame's leading frames aren't copied", async () => {
			const cut = await planClipCut({
				lookup: open,
				from: 9,
				to: 13,
				smart: false,
			});
			expect(cut).toMatchObject({ start: 9, end: 13 });
		});

		test("Smart Cut re-encodes them when the clip starts with them", async () => {
			const cut = await planClipCut({
				lookup: open,
				from: 8,
				to: 13,
				smart: true,
			});
			expect(cut).toMatchObject({
				start: 8,
				end: 13,
				headEnd: 9,
				tailStart: null,
			});
			expect(cut?.copyFrom?.timestamp).toBe(9);
		});
	});
});

describe("getCopyStep", () => {
	const copyFrom = { timestamp: 10, duration: 1 };

	test("copies what's shown from the key frame up to the end", () => {
		expect(
			getCopyStep({
				packet: { timestamp: 10, duration: 1 },
				copyFrom,
				until: 15,
			}),
		).toBe("copy");
		expect(
			getCopyStep({
				packet: { timestamp: 14, duration: 1 },
				copyFrom,
				until: 15,
			}),
		).toBe("copy");
	});

	test("skips leading frames, and stops at the first past the end", () => {
		expect(
			getCopyStep({
				packet: { timestamp: 8, duration: 1 },
				copyFrom,
				until: 15,
			}),
		).toBe("skip");
		expect(
			getCopyStep({
				packet: { timestamp: 15, duration: 1 },
				copyFrom,
				until: 15,
			}),
		).toBe("stop");
	});
});
