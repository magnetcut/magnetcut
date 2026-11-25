export function capitalizeFirstLetter({ string }: { string: string }) {
	return string.charAt(0).toUpperCase() + string.slice(1);
}

export function uppercase({ string }: { string: string }) {
	return string.toUpperCase();
}

/** Names in a list: "a", "a and b", "a, b and c". */
export function listNames({ names }: { names: string[] }): string {
	return names.length < 2
		? (names[0] ?? "")
		: `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
