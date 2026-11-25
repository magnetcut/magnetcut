// A project's details, written into every file it's exported to: what
// players, Photos and the Finder show of it. Each is left out when it's
// empty. The editor's Details panel sets them, offering what the media
// library's clips say of themselves (`./clip-tags.ts`); the desktop app
// writes them into its exports and its MP4s (apps/desktop/src/render/
// settings.rs, FileTags, which checks them as this does), mediabunny into
// the others (`getOutputTags`, `@/export/output-format`).

export interface FileTags {
	title?: string;
	/** Who made it. */
	artist?: string;
	/** The day it was made, YYYY-MM-DD. */
	date?: string;
	genre?: string;
	/** The one detail on several lines. */
	description?: string;
	comment?: string;
	/** Where it was filmed, in ISO 6709 as cameras write it:
	 * "+48.8584+002.2945+035.000/". */
	location?: string;
	/** The camera's maker and model. */
	make?: string;
	model?: string;
}

/** The details, in the Details panel's order. */
export const FILE_TAG_KEYS = [
	"title",
	"artist",
	"date",
	"genre",
	"description",
	"comment",
	"location",
	"make",
	"model",
] as const satisfies ReadonlyArray<keyof FileTags>;

/** Said wherever the place is to be written: the Details panel, and the
 * export panel's summary. */
export const PLACE_WARNING =
	"Anyone with the file can see where it was filmed.";

/** The longest a detail is kept, in characters: a description of a few
 * paragraphs, well within the 64 KB a file's tag can hold. */
export const MAX_FILE_TAG_LENGTH = 2000;

/** A detail's text as it's kept: trimmed and at most `MAX_FILE_TAG_LENGTH`
 * long, without control characters, tabs as spaces; a description's line
 * breaks kept, as "\n", and the others' made spaces, as their fields are one
 * line. */
function cleanText({
	text,
	isMultiline,
}: {
	text: string;
	isMultiline: boolean;
}): string {
	const spaced = isMultiline
		? text.replace(/\r\n?/g, "\n").replace(/\t/g, " ")
		: text.replace(/[\r\n\t]/g, " ");
	const cleaned = spaced
		.replace(isMultiline ? /[^\P{Cc}\n]/gu : /\p{Cc}/gu, "")
		.trim();
	return Array.from(cleaned).slice(0, MAX_FILE_TAG_LENGTH).join("").trimEnd();
}

/** Whether `day`, YYYY-MM-DD, is a day of the calendar: 2026-02-30 isn't. */
export function isDay({ day }: { day: string }): boolean {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
	if (!match) return false;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const date = Number(match[3]);
	// Not Date.UTC, which takes a year under 100 for one in the 1900s.
	const time = new Date(0);
	time.setUTCFullYear(year, month - 1, date);
	return (
		time.getUTCFullYear() === year &&
		time.getUTCMonth() === month - 1 &&
		time.getUTCDate() === date
	);
}

/** The day at noon in UTC, as a date and time: the same day wherever it's
 * read, and read as a date where a day alone is misread (AVFoundation takes
 * a QuickTime file's "2026-11-13" for the year 12181). */
export function getDateTime({ day }: { day: string }): string {
	return `${day}T12:00:00Z`;
}

/** `raw`'s details that are text, cleaned (`cleanText`), and none that's
 * empty or isn't one: a date that's no day, a place that's nowhere. What a
 * project file holds is anyone's. */
export function normalizeFileTags({ raw }: { raw: unknown }): FileTags {
	if (typeof raw !== "object" || raw === null) return {};
	const tags: FileTags = {};
	for (const key of FILE_TAG_KEYS) {
		const value: unknown = Reflect.get(raw, key);
		if (typeof value !== "string") continue;
		const text = cleanText({ text: value, isMultiline: key === "description" });
		if (!text) continue;
		if (key === "date" && !isDay({ day: text })) continue;
		if (key === "location" && !parsePlace({ location: text })) continue;
		tags[key] = text;
	}
	return tags;
}

export function hasFileTags({ tags }: { tags: FileTags }): boolean {
	return FILE_TAG_KEYS.some((key) => !!tags[key]);
}

/** A place in ISO 6709, in decimal degrees as cameras write it: its latitude
 * and longitude, and its height in metres. */
export function parsePlace({
	location,
}: {
	location: string;
}): { latitude: number; longitude: number; height?: number } | null {
	const match = location
		.trim()
		.match(/^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)?\/?$/);
	if (!match) return null;
	const latitude = Number(match[1]);
	const longitude = Number(match[2]);
	if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
	return match[3] === undefined
		? { latitude, longitude }
		: { latitude, longitude, height: Number(match[3]) };
}

/** A place as people read it: "48.8584° N, 2.2945° E". */
export function formatPlace({ location }: { location: string }): string {
	const place = parsePlace({ location });
	if (!place) return location;
	const degrees = (value: number) => `${+Math.abs(value).toFixed(4)}°`;
	return `${degrees(place.latitude)} ${place.latitude < 0 ? "S" : "N"}, ${degrees(place.longitude)} ${place.longitude < 0 ? "W" : "E"}`;
}

/** The camera as one line: "Apple iPhone 17 Pro". */
export function formatCamera({
	make,
	model,
}: {
	make?: string;
	model?: string;
}): string {
	if (!make) return model ?? "";
	if (!model) return make;
	// "Canon Canon EOS R5" reads as "Canon EOS R5".
	return model.toLowerCase().startsWith(make.toLowerCase())
		? model
		: `${make} ${model}`;
}
