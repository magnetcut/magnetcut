import {
	BitReader,
	BitWriter,
	escapeRbsp,
	findStopBit,
	unescapeRbsp,
} from "./bits";

// H.264 for Fast mode's Smart Cut (ITU-T H.264, 7.3; ISO/IEC 14496-15, 5.3).
// An MP4 track has one description, the avcC, but it may hold several SPSs and
// PPSs: the frames re-encoded around a cut keep the encoder's own, given ids the
// source doesn't use, and their slices are rewritten to point at them. Every
// decoder then has both from the start, as the format intends.

const NAL_SLICE = 1;
const NAL_IDR = 5;
const NAL_SPS = 7;
const NAL_PPS = 8;

const MAX_SPS_ID = 31;
const MAX_PPS_ID = 255;

// The profiles whose SPS says its chroma format and bit depth (7.3.2.1.1).
const HIGH_PROFILES = new Set([
	100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135,
]);

/** An AVCDecoderConfigurationRecord: the avcC. */
export interface AvcConfig {
	profile: number;
	compatibility: number;
	level: number;
	/** Bytes before each NAL unit in a packet, saying how long it is. */
	lengthSize: 1 | 2 | 4;
	sps: Uint8Array[];
	pps: Uint8Array[];
	/** What follows the PPSs (the High profiles' chroma format and bit depth), as it is. */
	extension: Uint8Array;
}

export function parseAvcConfig({ data }: { data: Uint8Array }): AvcConfig {
	if (data.length < 7 || data[0] !== 1) throw new Error("Not an avcC");
	const lengthSize = (data[4] & 3) + 1;
	if (lengthSize !== 1 && lengthSize !== 2 && lengthSize !== 4) {
		throw new Error("An avcC with 3-byte NAL lengths");
	}
	let offset = 5;
	const readSets = ({ count }: { count: number }) => {
		const sets: Uint8Array[] = [];
		for (let i = 0; i < count; i++) {
			const size = (data[offset] << 8) | data[offset + 1];
			offset += 2;
			sets.push(data.slice(offset, offset + size));
			offset += size;
		}
		return sets;
	};
	const sps = readSets({ count: data[offset++] & 31 });
	const pps = readSets({ count: data[offset++] });
	if (offset > data.length) throw new Error("A truncated avcC");
	return {
		profile: data[1],
		compatibility: data[2],
		level: data[3],
		lengthSize,
		sps,
		pps,
		extension: data.slice(offset),
	};
}

export function serializeAvcConfig({
	config,
}: {
	config: AvcConfig;
}): Uint8Array {
	const sets = [...config.sps, ...config.pps];
	const size =
		7 +
		sets.reduce((total, set) => total + 2 + set.length, 0) +
		config.extension.length;
	const out = new Uint8Array(size);
	out.set([
		1,
		config.profile,
		config.compatibility,
		config.level,
		0xfc | (config.lengthSize - 1),
	]);
	let offset = 5;
	const writeSets = ({ list }: { list: Uint8Array[] }) => {
		for (const set of list) {
			out[offset++] = set.length >> 8;
			out[offset++] = set.length & 0xff;
			out.set(set, offset);
			offset += set.length;
		}
	};
	out[offset++] = 0xe0 | config.sps.length;
	writeSets({ list: config.sps });
	out[offset++] = config.pps.length;
	writeSets({ list: config.pps });
	out.set(config.extension, offset);
	return out;
}

/** The NAL units of a packet in the avcC's layout, each with its header byte. */
export function splitNalUnits({
	data,
	lengthSize,
}: {
	data: Uint8Array;
	lengthSize: number;
}): Uint8Array[] {
	const units: Uint8Array[] = [];
	let offset = 0;
	while (offset + lengthSize <= data.length) {
		let size = 0;
		for (let i = 0; i < lengthSize; i++) size = size * 256 + data[offset + i];
		offset += lengthSize;
		if (size === 0) continue;
		if (offset + size > data.length)
			throw new Error("A NAL unit past the packet's end");
		units.push(data.subarray(offset, offset + size));
		offset += size;
	}
	return units;
}

export function joinNalUnits({
	units,
	lengthSize,
}: {
	units: Uint8Array[];
	lengthSize: number;
}): Uint8Array {
	const size = units.reduce(
		(total, unit) => total + lengthSize + unit.length,
		0,
	);
	const out = new Uint8Array(size);
	let offset = 0;
	for (const unit of units) {
		if (unit.length >= 2 ** (8 * lengthSize)) {
			throw new Error("A NAL unit too long for the avcC's lengths");
		}
		for (let i = lengthSize - 1; i >= 0; i--) {
			out[offset + i] =
				Math.floor(unit.length / 2 ** (8 * (lengthSize - 1 - i))) & 0xff;
		}
		offset += lengthSize;
		out.set(unit, offset);
		offset += unit.length;
	}
	return out;
}

export function getNalType({ unit }: { unit: Uint8Array }): number {
	return unit[0] & 31;
}

/** Whether a packet holds an IDR picture, where decoding may start afresh. */
export function isIdrPacket({
	data,
	lengthSize,
}: {
	data: Uint8Array;
	lengthSize: number;
}): boolean {
	return splitNalUnits({ data, lengthSize }).some(
		(unit) => getNalType({ unit }) === NAL_IDR,
	);
}

/** What a slice header needs to know of its SPS. */
export interface SpsInfo {
	id: number;
	profileIdc: number;
	chromaArrayType: number;
	separateColourPlane: boolean;
	/** 0 is monochrome, 1 is 4:2:0, 2 is 4:2:2, 3 is 4:4:4. */
	chromaFormatIdc: number;
	/** The luma's bits a sample. */
	bitDepth: number;
	log2MaxFrameNum: number;
	pocType: number;
	log2MaxPocLsb: number;
	deltaPicOrderAlwaysZero: boolean;
	frameMbsOnly: boolean;
}

/** What a slice header needs to know of its PPS. */
export interface PpsInfo {
	id: number;
	spsId: number;
	entropyCodingMode: boolean;
	bottomFieldPicOrderPresent: boolean;
	numRefIdxL0Default: number;
	numRefIdxL1Default: number;
	weightedPred: boolean;
	weightedBipredIdc: number;
	deblockingFilterControlPresent: boolean;
	redundantPicCntPresent: boolean;
}

function skipScalingList({
	reader,
	size,
}: {
	reader: BitReader;
	size: number;
}): void {
	let last = 8;
	let next = 8;
	for (let j = 0; j < size; j++) {
		if (next !== 0) next = (last + reader.se() + 256) % 256;
		last = next === 0 ? last : next;
	}
}

export function parseSps({ unit }: { unit: Uint8Array }): SpsInfo {
	return readSpsStart({ unit }).info;
}

/** The SPS read up to its frame_mbs_only_flag, and the reader there. */
function readSpsStart({ unit }: { unit: Uint8Array }): {
	info: SpsInfo;
	reader: BitReader;
} {
	const reader = new BitReader({
		data: unescapeRbsp({ nal: unit.subarray(1) }),
	});
	const profileIdc = reader.bits({ count: 8 });
	reader.skip({ count: 16 });
	const id = reader.ue();
	let chromaFormatIdc = 1;
	let separateColourPlane = false;
	let bitDepth = 8;
	if (HIGH_PROFILES.has(profileIdc)) {
		chromaFormatIdc = reader.ue();
		if (chromaFormatIdc === 3) separateColourPlane = reader.flag();
		bitDepth = reader.ue() + 8;
		reader.ue();
		reader.skip({ count: 1 });
		if (reader.flag()) {
			const lists = chromaFormatIdc !== 3 ? 8 : 12;
			for (let i = 0; i < lists; i++) {
				if (reader.flag()) skipScalingList({ reader, size: i < 6 ? 16 : 64 });
			}
		}
	}
	const log2MaxFrameNum = reader.ue() + 4;
	const pocType = reader.ue();
	let log2MaxPocLsb = 0;
	let deltaPicOrderAlwaysZero = false;
	if (pocType === 0) {
		log2MaxPocLsb = reader.ue() + 4;
	} else if (pocType === 1) {
		deltaPicOrderAlwaysZero = reader.flag();
		reader.se();
		reader.se();
		const cycle = reader.ue();
		for (let i = 0; i < cycle; i++) reader.se();
	}
	reader.ue();
	reader.skip({ count: 1 });
	reader.ue();
	reader.ue();
	const frameMbsOnly = reader.flag();
	const info = {
		id,
		profileIdc,
		chromaArrayType: separateColourPlane ? 0 : chromaFormatIdc,
		separateColourPlane,
		chromaFormatIdc,
		bitDepth,
		log2MaxFrameNum,
		pocType,
		log2MaxPocLsb,
		deltaPicOrderAlwaysZero,
		frameMbsOnly,
	};
	return { info, reader };
}

// The colour codes of H.273 that WebCodecs has names for, of the 8-bit video
// Smart Cut re-encodes (wide gamut and HDR are 10-bit).
const PRIMARIES: Partial<Record<number, VideoColorPrimaries>> = {
	1: "bt709",
	5: "bt470bg",
	6: "smpte170m",
};
const TRANSFERS: Partial<Record<number, VideoTransferCharacteristics>> = {
	1: "bt709",
	6: "smpte170m",
	13: "iec61966-2-1",
};
const MATRICES: Partial<Record<number, VideoMatrixCoefficients>> = {
	0: "rgb",
	1: "bt709",
	5: "bt470bg",
	6: "smpte170m",
};

/**
 * The colour space the SPS gives its pictures (its VUI's video signal type):
 * limited range if it doesn't say, and null for what it leaves unsaid.
 */
export function readSpsColour({
	unit,
}: {
	unit: Uint8Array;
}): VideoColorSpaceInit {
	const { info, reader } = readSpsStart({ unit });
	const colour: VideoColorSpaceInit = {
		primaries: null,
		transfer: null,
		matrix: null,
		fullRange: false,
	};
	if (!info.frameMbsOnly) reader.skip({ count: 1 });
	reader.skip({ count: 1 });
	if (reader.flag()) {
		for (let i = 0; i < 4; i++) reader.ue();
	}
	if (!reader.flag()) return colour;
	if (reader.flag() && reader.bits({ count: 8 }) === 255) {
		reader.skip({ count: 32 });
	}
	if (reader.flag()) reader.skip({ count: 1 });
	if (!reader.flag()) return colour;
	reader.skip({ count: 3 });
	colour.fullRange = reader.flag();
	if (reader.flag()) {
		colour.primaries = PRIMARIES[reader.bits({ count: 8 })] ?? null;
		colour.transfer = TRANSFERS[reader.bits({ count: 8 })] ?? null;
		colour.matrix = MATRICES[reader.bits({ count: 8 })] ?? null;
	}
	return colour;
}

export function parsePps({ unit }: { unit: Uint8Array }): PpsInfo {
	const reader = new BitReader({
		data: unescapeRbsp({ nal: unit.subarray(1) }),
	});
	const id = reader.ue();
	const spsId = reader.ue();
	const entropyCodingMode = reader.flag();
	const bottomFieldPicOrderPresent = reader.flag();
	if (reader.ue() > 0) {
		throw new Error("Slice groups (FMO) aren't supported");
	}
	const numRefIdxL0Default = reader.ue() + 1;
	const numRefIdxL1Default = reader.ue() + 1;
	const weightedPred = reader.flag();
	const weightedBipredIdc = reader.bits({ count: 2 });
	reader.se();
	reader.se();
	reader.se();
	const deblockingFilterControlPresent = reader.flag();
	reader.skip({ count: 1 });
	const redundantPicCntPresent = reader.flag();
	return {
		id,
		spsId,
		entropyCodingMode,
		bottomFieldPicOrderPresent,
		numRefIdxL0Default,
		numRefIdxL1Default,
		weightedPred,
		weightedBipredIdc,
		deblockingFilterControlPresent,
		redundantPicCntPresent,
	};
}

/** A NAL unit from its header byte and a new RBSP. */
function makeUnit({ header, rbsp }: { header: number; rbsp: Uint8Array }) {
	const payload = escapeRbsp({ rbsp });
	const unit = new Uint8Array(payload.length + 1);
	unit[0] = header;
	unit.set(payload, 1);
	return unit;
}

export function rewriteSpsId({
	unit,
	id,
}: {
	unit: Uint8Array;
	id: number;
}): Uint8Array {
	const rbsp = unescapeRbsp({ nal: unit.subarray(1) });
	const reader = new BitReader({ data: rbsp, position: 24 });
	reader.ue();
	const writer = new BitWriter();
	writer.copy({ data: rbsp, from: 0, to: 24 });
	writer.ue({ value: id });
	writer.copy({ data: rbsp, from: reader.position, to: findStopBit({ rbsp }) });
	return makeUnit({ header: unit[0], rbsp: writer.finish() });
}

export function rewritePpsIds({
	unit,
	id,
	spsId,
}: {
	unit: Uint8Array;
	id: number;
	spsId: number;
}): Uint8Array {
	const rbsp = unescapeRbsp({ nal: unit.subarray(1) });
	const reader = new BitReader({ data: rbsp });
	reader.ue();
	reader.ue();
	const writer = new BitWriter();
	writer.ue({ value: id });
	writer.ue({ value: spsId });
	writer.copy({ data: rbsp, from: reader.position, to: findStopBit({ rbsp }) });
	return makeUnit({ header: unit[0], rbsp: writer.finish() });
}

function skipRefPicListModification({ reader }: { reader: BitReader }) {
	if (!reader.flag()) return;
	for (;;) {
		const idc = reader.ue();
		if (idc === 3) return;
		if (idc > 5) throw new Error("A bad reference list modification");
		reader.ue();
	}
}

function skipPredWeightTable({
	reader,
	sps,
	l0,
	l1,
}: {
	reader: BitReader;
	sps: SpsInfo;
	l0: number;
	l1: number;
}) {
	reader.ue();
	if (sps.chromaArrayType !== 0) reader.ue();
	for (const count of [l0, l1]) {
		for (let i = 0; i < count; i++) {
			if (reader.flag()) {
				reader.se();
				reader.se();
			}
			if (sps.chromaArrayType !== 0 && reader.flag()) {
				for (let j = 0; j < 4; j++) reader.se();
			}
		}
	}
}

function skipDecRefPicMarking({
	reader,
	isIdr,
}: {
	reader: BitReader;
	isIdr: boolean;
}) {
	if (isIdr) {
		reader.skip({ count: 2 });
		return;
	}
	if (!reader.flag()) return;
	for (;;) {
		const operation = reader.ue();
		if (operation === 0) return;
		if (operation > 6) throw new Error("A bad memory management operation");
		if (operation === 1 || operation === 3) reader.ue();
		if (operation === 2) reader.ue();
		if (operation === 3 || operation === 6) reader.ue();
		if (operation === 4) reader.ue();
	}
}

/**
 * Where a slice's header ends, in bits of its RBSP (7.3.3): needed under
 * CABAC, whose slice data starts on the next byte.
 */
export function findSliceHeaderEnd({
	reader,
	unit,
	sps,
	pps,
}: {
	reader: BitReader;
	unit: Uint8Array;
	sps: SpsInfo;
	pps: PpsInfo;
}): number {
	const nalRefIdc = (unit[0] >> 5) & 3;
	const isIdr = getNalType({ unit }) === NAL_IDR;
	reader.position = 0;
	reader.ue();
	const sliceType = reader.ue() % 5;
	reader.ue();
	const isP = sliceType === 0 || sliceType === 3;
	const isB = sliceType === 1;
	if (sps.separateColourPlane) reader.skip({ count: 2 });
	reader.skip({ count: sps.log2MaxFrameNum });
	let isField = false;
	if (!sps.frameMbsOnly) {
		isField = reader.flag();
		if (isField) reader.skip({ count: 1 });
	}
	if (isIdr) reader.ue();
	if (sps.pocType === 0) {
		reader.skip({ count: sps.log2MaxPocLsb });
		if (pps.bottomFieldPicOrderPresent && !isField) reader.se();
	}
	if (sps.pocType === 1 && !sps.deltaPicOrderAlwaysZero) {
		reader.se();
		if (pps.bottomFieldPicOrderPresent && !isField) reader.se();
	}
	if (pps.redundantPicCntPresent) reader.ue();
	if (isB) reader.skip({ count: 1 });
	let l0 = pps.numRefIdxL0Default;
	let l1 = pps.numRefIdxL1Default;
	if (isP || isB) {
		if (reader.flag()) {
			l0 = reader.ue() + 1;
			if (isB) l1 = reader.ue() + 1;
		}
	}
	if (sliceType !== 2 && sliceType !== 4)
		skipRefPicListModification({ reader });
	if (isB) skipRefPicListModification({ reader });
	if ((pps.weightedPred && isP) || (pps.weightedBipredIdc === 1 && isB)) {
		skipPredWeightTable({ reader, sps, l0, l1: isB ? l1 : 0 });
	}
	if (nalRefIdc !== 0) skipDecRefPicMarking({ reader, isIdr });
	if (pps.entropyCodingMode && sliceType !== 2 && sliceType !== 4) reader.ue();
	reader.se();
	if (sliceType === 3 || sliceType === 4) {
		if (sliceType === 3) reader.skip({ count: 1 });
		reader.se();
	}
	if (pps.deblockingFilterControlPresent) {
		if (reader.ue() !== 1) {
			reader.se();
			reader.se();
		}
	}
	return reader.position;
}

/** A slice pointing at another PPS id, its picture as it was. */
export function rewriteSlicePpsId({
	unit,
	ppsId,
	sps,
	pps,
}: {
	unit: Uint8Array;
	ppsId: number;
	sps: SpsInfo;
	pps: PpsInfo;
}): Uint8Array {
	const rbsp = unescapeRbsp({ nal: unit.subarray(1) });
	const reader = new BitReader({ data: rbsp });
	reader.ue();
	reader.ue();
	const beforeId = reader.position;
	reader.ue();
	const afterId = reader.position;
	const writer = new BitWriter();
	writer.copy({ data: rbsp, from: 0, to: beforeId });
	writer.ue({ value: ppsId });
	if (!pps.entropyCodingMode) {
		// CAVLC: the slice data follows the header bit after bit.
		writer.copy({ data: rbsp, from: afterId, to: findStopBit({ rbsp }) });
		return makeUnit({ header: unit[0], rbsp: writer.finish() });
	}
	// CABAC: ones to the byte's end, then the slice data byte for byte.
	const headerEnd = findSliceHeaderEnd({ reader, unit, sps, pps });
	const dataStart = Math.ceil(headerEnd / 8);
	const alignment = new BitReader({ data: rbsp, position: headerEnd });
	while (alignment.position < dataStart * 8) {
		if (!alignment.flag()) throw new Error("A slice header that doesn't parse");
	}
	writer.copy({ data: rbsp, from: afterId, to: headerEnd });
	while (!writer.isAligned()) writer.bit({ value: 1 });
	writer.bytes({ data: rbsp.subarray(dataStart) });
	return makeUnit({ header: unit[0], rbsp: writer.take() });
}

/** Rewrites one source's packets for the merged avcC. */
export interface AvcPacketRewriter {
	rewrite: (data: Uint8Array) => Uint8Array;
}

/**
 * The avcC of an export joining sources with different parameter sets: the
 * first one's as they are, then each other's under ids of their own.
 */
export class AvcParameterSets {
	private readonly config: AvcConfig;
	private readonly primary: AvcConfig;
	private nextSpsId: number;
	private nextPpsId: number;

	constructor({ primary }: { primary: AvcConfig }) {
		this.primary = primary;
		this.config = { ...primary, sps: [...primary.sps], pps: [...primary.pps] };
		const spsIds = primary.sps.map((unit) => parseSps({ unit }).id);
		const ppsIds = primary.pps.map((unit) => parsePps({ unit }).id);
		this.nextSpsId = Math.max(-1, ...spsIds) + 1;
		this.nextPpsId = Math.max(-1, ...ppsIds) + 1;
	}

	/** The avcC holding every source's parameter sets. */
	get description(): Uint8Array {
		return serializeAvcConfig({ config: this.config });
	}

	/** Takes in a source's parameter sets: how its packets are rewritten. */
	add({ config }: { config: AvcConfig }): AvcPacketRewriter {
		const outLength = this.config.lengthSize;
		const sameSets =
			sameUnits({ a: config.sps, b: this.primary.sps }) &&
			sameUnits({ a: config.pps, b: this.primary.pps });
		if (sameSets) {
			if (config.lengthSize === outLength) return { rewrite: (data) => data };
			return {
				rewrite: (data) =>
					joinNalUnits({
						units: splitNalUnits({ data, lengthSize: config.lengthSize }),
						lengthSize: outLength,
					}),
			};
		}

		const spsIds = new Map<number, number>();
		const spsById = new Map<number, SpsInfo>();
		for (const unit of config.sps) {
			const info = parseSps({ unit });
			const id = this.takeSpsId();
			spsIds.set(info.id, id);
			spsById.set(info.id, info);
			this.config.sps.push(rewriteSpsId({ unit, id }));
		}
		const ppsIds = new Map<number, number>();
		const ppsById = new Map<number, PpsInfo>();
		const addPps = ({ unit }: { unit: Uint8Array }) => {
			const info = parsePps({ unit });
			const spsId = spsIds.get(info.spsId);
			if (spsId === undefined)
				throw new Error("A PPS for an SPS that isn't there");
			const id = ppsIds.get(info.id) ?? this.takePpsId();
			ppsIds.set(info.id, id);
			ppsById.set(info.id, info);
			return rewritePpsIds({ unit, id, spsId });
		};
		for (const unit of config.pps) this.config.pps.push(addPps({ unit }));

		const rewriteUnit = (unit: Uint8Array): Uint8Array => {
			const type = getNalType({ unit });
			if (type === NAL_SPS) {
				// The same set again, in the stream: kept, under its new id.
				const info = parseSps({ unit });
				const id = spsIds.get(info.id);
				if (id === undefined) throw new Error("A new SPS in the stream");
				spsById.set(info.id, info);
				return rewriteSpsId({ unit, id });
			}
			if (type === NAL_PPS) return addPps({ unit });
			if (type !== NAL_SLICE && type !== NAL_IDR) return unit;
			// The three numbers the PPS id ends, which fit in the first bytes.
			const reader = new BitReader({
				data: unescapeRbsp({ nal: unit.subarray(1, 20) }),
			});
			reader.ue();
			reader.ue();
			const oldPpsId = reader.ue();
			const pps = ppsById.get(oldPpsId);
			const ppsId = ppsIds.get(oldPpsId);
			const sps = pps && spsById.get(pps.spsId);
			if (!pps || ppsId === undefined || !sps) {
				throw new Error("A slice whose PPS isn't there");
			}
			return rewriteSlicePpsId({ unit, ppsId, sps, pps });
		};
		return {
			rewrite: (data) =>
				joinNalUnits({
					units: splitNalUnits({ data, lengthSize: config.lengthSize }).map(
						rewriteUnit,
					),
					lengthSize: outLength,
				}),
		};
	}

	private takeSpsId(): number {
		if (this.nextSpsId > MAX_SPS_ID) throw new Error("Too many SPSs to join");
		return this.nextSpsId++;
	}

	private takePpsId(): number {
		if (this.nextPpsId > MAX_PPS_ID) throw new Error("Too many PPSs to join");
		return this.nextPpsId++;
	}
}

function sameUnits({ a, b }: { a: Uint8Array[]; b: Uint8Array[] }): boolean {
	return (
		a.length === b.length &&
		a.every(
			(unit, i) =>
				unit.length === b[i].length &&
				unit.every((byte, j) => byte === b[i][j]),
		)
	);
}
