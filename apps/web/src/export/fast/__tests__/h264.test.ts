import { describe, expect, test } from "bun:test";
import { BitReader, findStopBit, unescapeRbsp } from "../bits";
import {
	AvcParameterSets,
	findSliceHeaderEnd,
	getNalType,
	isIdrPacket,
	parseAvcConfig,
	parsePps,
	parseSps,
	readSpsColour,
	rewritePpsIds,
	rewriteSpsId,
	serializeAvcConfig,
	splitNalUnits,
	type AvcConfig,
	type PpsInfo,
	type SpsInfo,
} from "../h264";
import { fromHex, STREAMS, type StreamFixture } from "./streams";

function configOf({ stream }: { stream: StreamFixture }): AvcConfig {
	return parseAvcConfig({ data: fromHex({ hex: stream.avcC }) });
}

function bitsOf({
	data,
	from,
	to,
}: {
	data: Uint8Array;
	from: number;
	to: number;
}) {
	let out = "";
	for (let position = from; position < to; position++) {
		out += (data[position >> 3] >> (7 - (position & 7))) & 1;
	}
	return out;
}

function hasStartCode({ unit }: { unit: Uint8Array }): boolean {
	for (let i = 3; i < unit.length; i++) {
		if (unit[i - 2] === 0 && unit[i - 1] === 0 && unit[i] <= 2) return true;
	}
	return false;
}

/** A slice's parts: its PPS id, its header after the id, and its data. */
function readSlice({
	unit,
	sps,
	pps,
}: {
	unit: Uint8Array;
	sps: SpsInfo;
	pps: PpsInfo;
}) {
	const rbsp = unescapeRbsp({ nal: unit.subarray(1) });
	const reader = new BitReader({ data: rbsp });
	reader.ue();
	reader.ue();
	const beforeId = reader.position;
	const ppsId = reader.ue();
	const afterId = reader.position;
	const headerEnd = findSliceHeaderEnd({ reader, unit, sps, pps });
	return {
		ppsId,
		start: bitsOf({ data: rbsp, from: 0, to: beforeId }),
		header: bitsOf({ data: rbsp, from: afterId, to: headerEnd }),
		// CAVLC: the data follows bit for bit; CABAC: from the next byte.
		data: pps.entropyCodingMode
			? [...rbsp.subarray(Math.ceil(headerEnd / 8))]
			: bitsOf({ data: rbsp, from: headerEnd, to: findStopBit({ rbsp }) }),
	};
}

describe("avcC", () => {
	test("round trips", () => {
		for (const stream of Object.values(STREAMS)) {
			const data = fromHex({ hex: stream.avcC });
			expect([
				...serializeAvcConfig({ config: parseAvcConfig({ data }) }),
			]).toEqual([...data]);
		}
	});

	test("says what's in it", () => {
		const high = configOf({ stream: STREAMS.high });
		expect(high).toMatchObject({ profile: 100, level: 10, lengthSize: 4 });
		expect(high.sps).toHaveLength(1);
		expect(high.pps).toHaveLength(1);
		expect(configOf({ stream: STREAMS.base })).toMatchObject({ profile: 66 });
	});
});

describe("parameter sets", () => {
	test("the SPS and PPS of a High stream and a Baseline one", () => {
		const high = configOf({ stream: STREAMS.high });
		expect(parseSps({ unit: high.sps[0] })).toMatchObject({
			id: 0,
			profileIdc: 100,
			chromaArrayType: 1,
			frameMbsOnly: true,
		});
		expect(parsePps({ unit: high.pps[0] })).toMatchObject({
			id: 0,
			spsId: 0,
			entropyCodingMode: true,
			weightedPred: true,
		});
		const base = configOf({ stream: STREAMS.base });
		expect(parseSps({ unit: base.sps[0] })).toMatchObject({
			id: 0,
			profileIdc: 66,
		});
		expect(parsePps({ unit: base.pps[0] })).toMatchObject({
			id: 0,
			entropyCodingMode: false,
			weightedPred: false,
		});
	});

	test("the colour space: limited range if the SPS doesn't say", () => {
		expect(
			readSpsColour({ unit: configOf({ stream: STREAMS.high }).sps[0] }),
		).toEqual({
			primaries: null,
			transfer: null,
			matrix: null,
			fullRange: false,
		});
		expect(
			readSpsColour({ unit: configOf({ stream: STREAMS.full }).sps[0] }),
		).toEqual({
			primaries: "bt709",
			transfer: "bt709",
			matrix: "bt709",
			fullRange: true,
		});
	});

	test("ids rewritten, the rest as it was", () => {
		// This SPS has an emulation prevention byte, which moves with the bits.
		const [sps] = configOf({ stream: STREAMS.high }).sps;
		const [pps] = configOf({ stream: STREAMS.high }).pps;
		for (const id of [1, 7, 31]) {
			const unit = rewriteSpsId({ unit: sps, id });
			expect(hasStartCode({ unit })).toBe(false);
			expect(parseSps({ unit })).toEqual({ ...parseSps({ unit: sps }), id });
			expect(readSpsColour({ unit })).toEqual(readSpsColour({ unit: sps }));
		}
		for (const [id, spsId] of [
			[1, 1],
			[200, 31],
		]) {
			const unit = rewritePpsIds({ unit: pps, id, spsId });
			expect(hasStartCode({ unit })).toBe(false);
			expect(parsePps({ unit })).toEqual({
				...parsePps({ unit: pps }),
				id,
				spsId,
			});
		}
	});

	test("an IDR packet is told from the others", () => {
		const packets = STREAMS.high.packets.map(({ data }) =>
			isIdrPacket({ data: fromHex({ hex: data }), lengthSize: 4 }),
		);
		expect(packets).toEqual([true, false, false, false, false]);
	});
});

describe("AvcParameterSets", () => {
	test("a source with the first one's sets is copied as it is", () => {
		const high = configOf({ stream: STREAMS.high });
		const sets = new AvcParameterSets({ primary: high });
		const { rewrite } = sets.add({
			config: configOf({ stream: STREAMS.high }),
		});
		const packet = fromHex({ hex: STREAMS.high.packets[1].data });
		expect(rewrite(packet)).toBe(packet);
		expect([...sets.description]).toEqual([
			...fromHex({ hex: STREAMS.high.avcC }),
		]);
	});

	for (const [first, second] of [
		["high", "base"],
		["base", "high"],
	] as const) {
		test(`${second} joined to ${first}: its sets under new ids, its slices pointing at them`, () => {
			const primary = configOf({ stream: STREAMS[first] });
			const joined = configOf({ stream: STREAMS[second] });
			const sets = new AvcParameterSets({ primary });
			const { rewrite } = sets.add({ config: joined });

			const merged = parseAvcConfig({ data: sets.description });
			expect(merged.profile).toBe(primary.profile);
			expect(merged.sps.map((unit) => parseSps({ unit }).id)).toEqual([0, 1]);
			expect(merged.pps.map((unit) => parsePps({ unit }))).toMatchObject([
				{ id: 0, spsId: 0 },
				{ id: 1, spsId: 1 },
			]);
			expect([...merged.sps[0]]).toEqual([...primary.sps[0]]);

			const sps = parseSps({ unit: joined.sps[0] });
			const pps = parsePps({ unit: joined.pps[0] });
			for (const packet of STREAMS[second].packets) {
				const data = fromHex({ hex: packet.data });
				const before = splitNalUnits({ data, lengthSize: 4 });
				const after = splitNalUnits({ data: rewrite(data), lengthSize: 4 });
				expect(after.map((unit) => getNalType({ unit }))).toEqual(
					before.map((unit) => getNalType({ unit })),
				);
				for (const [i, unit] of after.entries()) {
					expect(hasStartCode({ unit })).toBe(false);
					const was = readSlice({ unit: before[i], sps, pps });
					const now = readSlice({ unit, sps, pps });
					expect(was.ppsId).toBe(0);
					expect(now).toEqual({ ...was, ppsId: 1 });
				}
			}
		});
	}
});
