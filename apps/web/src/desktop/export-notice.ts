// An export's end, said when the window isn't in front: a notification
// (Notification Center on macOS, a toast on Windows, the desktop's own on
// Linux: apps/desktop/src/notice.rs), and the Dock icon bounces once, or the
// taskbar button flashes. Not for a cancelled export: the user did that
// themselves.

import { invoke, isTauri } from "@tauri-apps/api/core";
import { UserAttentionType, getCurrentWindow } from "@tauri-apps/api/window";
import type { ExportResult } from "@/export";
import { formatDuration } from "@/export/progress";

// The longest error a notification shows: the panel has the rest.
const MAX_ERROR_LENGTH = 160;

/** What the notification says: none for a cancelled export. */
export function describeExportEnd({
	result,
	name,
	seconds,
}: {
	result: ExportResult;
	/** The project's, for an export that didn't go to a file. */
	name: string;
	/** How long it took. */
	seconds: number;
}): { title: string; body: string } | null {
	if (result.cancelled) return null;
	if (!result.success) {
		const error = result.error ?? "";
		return {
			title: "Export failed",
			body: error
				? `${name}: ${error.length > MAX_ERROR_LENGTH ? `${error.slice(0, MAX_ERROR_LENGTH - 1)}…` : error}`
				: name,
		};
	}
	const file = result.path?.split(/[\\/]/).pop() || name;
	return {
		title: "Export finished",
		body: `${file}, made in ${formatDuration({ seconds })}`,
	};
}

/** Says the export ended, unless the window's in front, where the panel
 * says it. */
export async function announceExportEnd({
	result,
	name,
	seconds,
}: {
	result: ExportResult;
	name: string;
	seconds: number;
}): Promise<void> {
	const notice = describeExportEnd({ result, name, seconds });
	if (!notice || !isTauri()) return;
	const window = getCurrentWindow();
	if (await window.isFocused()) return;
	await window.requestUserAttention(UserAttentionType.Informational);
	// macOS asks the first time whether the app may; the others always may.
	await invoke("show_notice", notice);
}
