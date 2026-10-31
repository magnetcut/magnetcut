// Short ids for agents to name things by (docs/AUTOMATION.md): the first five
// characters of a thing's own id, more where two share them. Nothing is
// stored, so they stay the same across calls and launches.

const SHORT = 5;

/** Each id's short form, among `ids`. */
export function shortIds({ ids }: { ids: string[] }): Map<string, string> {
	const shortened = new Map<string, string>();
	for (const id of ids) {
		let length = Math.min(SHORT, id.length);
		while (
			length < id.length &&
			ids.some((other) => other !== id && other.startsWith(id.slice(0, length)))
		) {
			length += 1;
		}
		shortened.set(id, id.slice(0, length));
	}
	return shortened;
}

/** The id `short` names among `ids`: the one it's the start of, if only one. */
export function resolveId({
	short,
	ids,
}: {
	short: string;
	ids: string[];
}): string | null {
	const matches = ids.filter((id) => id.startsWith(short));
	return matches.length === 1 ? matches[0] : null;
}
