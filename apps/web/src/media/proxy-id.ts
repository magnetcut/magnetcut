/**
 * What the preview's decoders know a video's proxy by: apart from the
 * original's, so the two are never mixed up.
 */
export function getProxyMediaId({ id }: { id: string }): string {
	return `${id}#proxy`;
}
