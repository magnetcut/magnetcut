import type { MediaAsset } from "@/media/types";
import {
	deserializeProject,
	serializeProject,
} from "@/services/storage/service";
import type {
	MediaAssetData,
	SerializedProject,
} from "@/services/storage/types";
import type { TProject } from "./types";

// A project as a file (.magnetcut, docs/AUTOMATION.md): the project as JSON,
// as it's stored, and its media by where they are on disk, so it opens again
// wherever they are. A medium that isn't a file on disk (copied into the
// browser's storage) can't be named, and is left out.

export const PROJECT_FILE_EXTENSION = "magnetcut";
const FORMAT = 1;

export type ProjectFileMedium = Omit<
	MediaAssetData,
	"size" | "lastModified"
> & {
	path: string;
};

export interface ProjectFile {
	magnetcut: typeof FORMAT;
	project: SerializedProject;
	media: ProjectFileMedium[];
}

/** The file for `project` and its media; the media it left out, by name. */
export function toProjectFile({
	project,
	assets,
}: {
	project: TProject;
	assets: MediaAsset[];
}): { text: string; leftOut: string[] } {
	const media: ProjectFileMedium[] = [];
	const leftOut: string[] = [];
	for (const asset of assets) {
		if (!asset.path) {
			leftOut.push(asset.name);
			continue;
		}
		media.push({
			id: asset.id,
			name: asset.name,
			type: asset.type,
			path: asset.path,
			width: asset.width,
			height: asset.height,
			duration: asset.duration,
			fps: asset.fps,
			hasAudio: asset.hasAudio,
		});
	}
	const file: ProjectFile = {
		magnetcut: FORMAT,
		project: serializeProject({ project }),
		media,
	};
	return { text: JSON.stringify(file, null, 1), leftOut };
}

function isSerializedProject(value: unknown): value is SerializedProject {
	return (
		typeof value === "object" &&
		value !== null &&
		"metadata" in value &&
		typeof value.metadata === "object" &&
		value.metadata !== null &&
		"scenes" in value &&
		Array.isArray(value.scenes)
	);
}

function isMedium(value: unknown): value is ProjectFileMedium {
	return (
		typeof value === "object" &&
		value !== null &&
		"id" in value &&
		typeof value.id === "string" &&
		"path" in value &&
		typeof value.path === "string" &&
		"type" in value &&
		typeof value.type === "string"
	);
}

/** A project file's project and media; throws, saying why, if it isn't one. */
export function parseProjectFile({ text }: { text: string }): {
	project: TProject;
	media: ProjectFileMedium[];
} {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error("It isn't a MagnetCut project: not JSON");
	}
	if (
		typeof value !== "object" ||
		value === null ||
		!("magnetcut" in value) ||
		!("project" in value)
	) {
		throw new Error("It isn't a MagnetCut project");
	}
	if (value.magnetcut !== FORMAT) {
		throw new Error(
			`It's a MagnetCut project of another version (${String(value.magnetcut)})`,
		);
	}
	if (!isSerializedProject(value.project)) {
		throw new Error("The project in it is damaged");
	}
	const media =
		"media" in value && Array.isArray(value.media)
			? value.media.filter(isMedium)
			: [];
	return { project: deserializeProject({ serialized: value.project }), media };
}
