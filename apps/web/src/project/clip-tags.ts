import { ALL_FORMATS, Input, type MetadataTags } from "mediabunny";
import { createMediaSource } from "@/media/disk-file";
import type { MediaAsset } from "@/media/types";
import { FILE_TAG_KEYS, normalizeFileTags, type FileTags } from "./file-tags";

// What the media library's clips say of themselves, offered in the Details
// panel for the project's own: an iPhone's clip says when and where it was
// filmed and on which camera (QuickTime's com.apple.quicktime keys); a
// downloaded or exported one, often a title and more.

/** The most suggestions a detail gets. */
const MAX_SUGGESTIONS = 3;

type TextKey = Exclude<(typeof FILE_TAG_KEYS)[number], "make" | "model">;

/** The details suggested as they are: all but the camera's maker and model,
 * suggested together (under `model`). */
const TEXT_KEYS = FILE_TAG_KEYS.filter(
	(key): key is TextKey => key !== "make" && key !== "model",
);

/** Those "Fill in from the clips" fills: not the place, which goes in only
 * when it's chosen, as anyone with the file can see it. */
const FILLED_KEYS = TEXT_KEYS.filter((key) => key !== "location");

// Where files keep the day they were made, in the time zone they were made
// in: QuickTime's metadata, iTunes' and QuickTime's ©day, Matroska's tags,
// ID3's recording time and a WAV's creation date.
const DATE_KEYS = [
	"com.apple.quicktime.creationdate",
	"©day",
	"date",
	"date_recorded",
	"date_released",
	"tdrc",
	"icrd",
];

/** A clip's details, from what mediabunny read of its file. */
export function fromMetadataTags({ tags }: { tags: MetadataTags }): FileTags {
	// By their keys in any case: Matroska's are upper case ("DATE").
	const raw = new Map(
		Object.entries(tags.raw ?? {}).map(([key, value]) => [
			key.toLowerCase(),
			value,
		]),
	);
	const text = (...keys: string[]) => {
		for (const key of keys) {
			const value = raw.get(key.toLowerCase());
			if (typeof value === "string" && value.trim()) return value.trim();
		}
		return undefined;
	};
	// The day as the file wrote it, where it was made: not the date read,
	// which is in UTC, nor a year alone.
	const day = text(...DATE_KEYS)?.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
	return normalizeFileTags({
		raw: {
			title: tags.title,
			artist: tags.artist,
			date: day,
			genre: tags.genre,
			description: tags.description,
			comment: tags.comment,
			location: text(
				"com.apple.quicktime.location.ISO6709",
				"©xyz",
				"location",
			),
			make: text("com.apple.quicktime.make", "©mak", "make"),
			model: text("com.apple.quicktime.model", "©mod", "model"),
		},
	});
}

// Each clip's, read once.
const read = new Map<string, Promise<FileTags>>();

/** A clip's details: none for a picture, or a file that can't be read.
 * Never fails. */
export function readClipTags({
	asset,
}: {
	asset: MediaAsset;
}): Promise<FileTags> {
	if (asset.type === "image") return Promise.resolve({});
	const known = read.get(asset.id);
	if (known) return known;
	const reading = (async () => {
		let input: Input | undefined;
		try {
			input = new Input({
				source: createMediaSource({ file: asset.file }),
				formats: ALL_FORMATS,
			});
			return fromMetadataTags({ tags: await input.getMetadataTags() });
		} catch {
			return {};
		} finally {
			input?.dispose();
		}
	})();
	read.set(asset.id, reading);
	return reading;
}

/** A value a detail may take, and the clip it's from. */
export interface TagSuggestion {
	value: string;
	/** For the camera: its maker, apart. */
	make?: string;
	clip: string;
}

/** What tells one suggestion's value from another's: the camera's maker too. */
export function getSuggestionKey({
	suggestion,
}: {
	suggestion: Pick<TagSuggestion, "value" | "make">;
}): string {
	return `${suggestion.make ?? ""}\n${suggestion.value}`;
}

export type TagSuggestions = Partial<
	Record<Exclude<keyof FileTags, "make">, TagSuggestion[]>
>;

/** For each detail, the values the clips have, a few: each once, the first
 * clip's first; the dates earliest first. The camera's under `model`, with
 * its maker. */
export function suggestFileTags({
	clips,
}: {
	clips: Array<{ name: string; tags: FileTags }>;
}): TagSuggestions {
	const suggestions: TagSuggestions = {};
	const add = ({
		key,
		suggestion,
	}: {
		key: keyof TagSuggestions;
		suggestion: TagSuggestion;
	}) => {
		const list = (suggestions[key] ??= []);
		const identity = getSuggestionKey({ suggestion });
		if (
			list.some((one) => getSuggestionKey({ suggestion: one }) === identity)
		) {
			return;
		}
		list.push(suggestion);
	};
	for (const { name, tags } of clips) {
		for (const key of TEXT_KEYS) {
			const value = tags[key];
			if (value) add({ key, suggestion: { value, clip: name } });
		}
		if (tags.model || tags.make) {
			add({
				key: "model",
				suggestion: { value: tags.model ?? "", make: tags.make, clip: name },
			});
		}
	}
	suggestions.date?.sort((a, b) => a.value.localeCompare(b.value));
	for (const key of [...TEXT_KEYS, "model"] as const) {
		suggestions[key] = suggestions[key]?.slice(0, MAX_SUGGESTIONS);
	}
	return suggestions;
}

/** The project's details with the clips' first suggestions in those that
 * are empty: not the place (`FILLED_KEYS`). */
export function fillFromClips({
	tags,
	suggestions,
}: {
	tags: FileTags;
	suggestions: TagSuggestions;
}): FileTags {
	const filled: FileTags = { ...tags };
	for (const key of FILLED_KEYS) {
		const first = suggestions[key]?.[0];
		if (!filled[key] && first) filled[key] = first.value;
	}
	const camera = suggestions.model?.[0];
	if (!filled.make && !filled.model && camera) {
		filled.make = camera.make;
		filled.model = camera.value || undefined;
	}
	return filled;
}
