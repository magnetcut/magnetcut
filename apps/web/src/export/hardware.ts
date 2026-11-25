import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { ExportFormat } from "./index";
import type { NativeCapabilities } from "./native";
import { FORMAT_CODECS, type ExportVideoCodec } from "./settings";

// The codecs this computer encodes in hardware (a media engine or a GPU),
// which are fast, and the setting that keeps exports to them: on by default,
// as a film encoded in software (AV1 on any Mac) takes hours at 4K. While it's
// on, a codec encoded in software counts as one this computer can't make: the
// Simple mode picks another, Advanced offers it greyed out. Like the priority
// (priority.ts), it's about this computer, not the file.

/**
 * The codecs encoded in hardware here, in `format`: null where that isn't
 * known, as in a format the desktop app's own export doesn't make (WebM,
 * Matroska), which the web view's encoders make, whichever they are.
 */
export function getHardwareCodecs({
	native,
	format,
}: {
	native: NativeCapabilities | null;
	format: ExportFormat;
}): Set<ExportVideoCodec> | null {
	if (!native?.formats.includes(format)) return null;
	return new Set(native.hardwareCodecs);
}

/** Whether exports can keep to hardware: it's known what's encoded in
 * hardware, and something is. */
export function canKeepToHardware(
	hardware: Set<ExportVideoCodec> | null,
): hardware is Set<ExportVideoCodec> {
	return !!hardware && hardware.size > 0;
}

/** The codecs to offer: the encodable ones, less those encoded in software
 * when exports keep to hardware. */
export function keepToHardware({
	encodable,
	hardware,
	hardwareOnly,
}: {
	encodable: Set<ExportVideoCodec> | null;
	hardware: Set<ExportVideoCodec> | null;
	hardwareOnly: boolean;
}): Set<ExportVideoCodec> | null {
	if (!encodable || !hardwareOnly || !canKeepToHardware(hardware)) {
		return encodable;
	}
	return new Set([...encodable].filter((codec) => hardware.has(codec)));
}

/** `format`'s codecs this computer encodes, but in software: those keeping
 * to hardware leaves out. None where that isn't known. */
export function getSoftwareCodecs({
	format,
	encodable,
	hardware,
}: {
	format: ExportFormat;
	/** All the codecs this computer encodes, in hardware or not. */
	encodable: Set<ExportVideoCodec> | null;
	hardware: Set<ExportVideoCodec> | null;
}): ExportVideoCodec[] {
	if (!encodable || !canKeepToHardware(hardware)) return [];
	return FORMAT_CODECS[format].video.filter(
		(codec) => encodable.has(codec) && !hardware.has(codec),
	);
}

/** The first of `format`'s codecs encoded in hardware here: for one that
 * keeping to hardware leaves out. None where that isn't known. */
export function firstHardwareCodec({
	format,
	encodable,
	hardware,
}: {
	format: ExportFormat;
	/** All the codecs this computer encodes: none while it's not known. */
	encodable: Set<ExportVideoCodec> | null;
	hardware: Set<ExportVideoCodec> | null;
}): ExportVideoCodec | null {
	if (!canKeepToHardware(hardware)) return null;
	return (
		FORMAT_CODECS[format].video.find(
			(codec) => hardware.has(codec) && (encodable?.has(codec) ?? true),
		) ?? null
	);
}

/**
 * How a codec is to be had here: "available", encoded, in hardware or where
 * that isn't known; "software", encoded in software, and slow; "left-out",
 * encoded in software while exports keep to hardware; "unavailable", not
 * encoded here at that size. While what's encoded isn't known, available.
 */
export type CodecAvailability =
	| "available"
	| "software"
	| "left-out"
	| "unavailable";

export function getCodecAvailability({
	codec,
	encodable,
	hardware,
	hardwareOnly,
}: {
	codec: ExportVideoCodec;
	/** All the codecs this computer encodes, in hardware or not. */
	encodable: Set<ExportVideoCodec> | null;
	hardware: Set<ExportVideoCodec> | null;
	hardwareOnly: boolean;
}): CodecAvailability {
	// Not known yet, as `keepToHardware` has it: offered.
	if (!encodable) return "available";
	if (!encodable.has(codec)) return "unavailable";
	if (!hardware || hardware.has(codec)) return "available";
	return hardwareOnly && canKeepToHardware(hardware) ? "left-out" : "software";
}

/** Whether a codec can be chosen: one that's encoded and not left out. */
export function isOffered({
	availability,
}: {
	availability: CodecAvailability;
}): boolean {
	return availability === "available" || availability === "software";
}

/** How the video is encoded here: by the hardware, fast, or in software. */
export type EncoderSpeed = "hardware" | "software";

/** How `codec` is encoded here: none where that isn't known
 * (`getHardwareCodecs`). */
export function getEncoderSpeed({
	codec,
	hardware,
}: {
	codec: ExportVideoCodec;
	hardware: Set<ExportVideoCodec> | null;
}): EncoderSpeed | null {
	if (!hardware) return null;
	return hardware.has(codec) ? "hardware" : "software";
}

interface HardwareOnlyState {
	hardwareOnly: boolean;
	setHardwareOnly: ({ hardwareOnly }: { hardwareOnly: boolean }) => void;
}

export const useHardwareOnlyStore = create<HardwareOnlyState>()(
	persist(
		(set) => ({
			hardwareOnly: true,
			setHardwareOnly: ({ hardwareOnly }) => set({ hardwareOnly }),
		}),
		{
			name: "magnetcut-export-hardware-only",
			storage: createJSONStorage(() => localStorage),
			partialize: ({ hardwareOnly }) => ({ hardwareOnly }),
			// Whatever was stored, by this version or another, is checked.
			merge: (persisted, current) => {
				const hardwareOnly = Reflect.get(Object(persisted), "hardwareOnly");
				return {
					...current,
					hardwareOnly:
						typeof hardwareOnly === "boolean"
							? hardwareOnly
							: current.hardwareOnly,
				};
			},
		},
	),
);
