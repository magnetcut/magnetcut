// The app is a static export (the desktop shell serves files), so there's one
// editor page and the project goes in the query string, not the path.
export function getEditorUrl({ projectId }: { projectId: string }): string {
	return `/editor?id=${encodeURIComponent(projectId)}`;
}
