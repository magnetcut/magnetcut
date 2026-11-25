import { useEffect, useState } from "react";
import type { ExportFormat } from "@/export";
import { findEncodableCodecs } from "@/export/encodable";
import {
	getNativeCapabilities,
	type NativeCapabilities,
} from "@/export/native";
import type { ExportVideoCodec } from "@/export/settings";

// What the export panel's modes ask of this computer: what it encodes, and
// what the desktop app's own export does here.

/**
 * The codecs this computer encodes at a size: those the web view's encoders
 * take, and those the app's own export makes in this format (AV1 only in
 * MP4). ProRes counts whatever the format, as Simple's master file moves to
 * QuickTime for it. None until it's known.
 */
export function useEncodableCodecs({
	width,
	height,
	format,
}: {
	width: number;
	height: number;
	format: ExportFormat;
}): Set<ExportVideoCodec> | null {
	const [encodable, setEncodable] = useState<Set<ExportVideoCodec> | null>(
		null,
	);
	useEffect(() => {
		let isCurrent = true;
		void findEncodableCodecs({ width, height, format }).then((found) => {
			if (isCurrent) setEncodable(found);
		});
		return () => {
			isCurrent = false;
		};
	}, [width, height, format]);
	return encodable;
}

/** What the desktop app's native export can do here: null where there's
 * none, and until it's known. */
export function useNativeCapabilities(): NativeCapabilities | null {
	const [capabilities, setCapabilities] = useState<NativeCapabilities | null>(
		null,
	);
	useEffect(() => {
		let isCurrent = true;
		void getNativeCapabilities().then((found) => {
			if (isCurrent) setCapabilities(found);
		});
		return () => {
			isCurrent = false;
		};
	}, []);
	return capabilities;
}

/** The codecs of a set, as one value that's the same while they are: for an
 * effect's dependencies, where a new set of the same codecs is no change. */
export function getCodecsKey({
	codecs,
}: {
	codecs: Set<ExportVideoCodec> | null;
}): string | null {
	return codecs ? [...codecs].sort().join(",") : null;
}
