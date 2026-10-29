// Updates, in the editions that update themselves. The feed is latest.json on
// the latest published GitHub release; an update installs only if it's signed
// with the key whose public half is in tauri.conf.json, so whoever takes over
// the feed can't get anything installed.

import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { toast } from "sonner";
import { useAppDialogsStore } from "./app-dialogs-store";
import { getAppInfo } from "./app-info";
import { useSettingsStore } from "./settings-store";

const DAY_MS = 24 * 60 * 60 * 1000;

export type DownloadProgress = { downloaded: number; total: number | null };

export function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function findUpdate(): Promise<Update | null> {
	const update = await check();
	useSettingsStore.getState().setLastUpdateCheck({ time: Date.now() });
	return update;
}

/** Check Now, from the menu, Settings or About: it says what it found. */
export async function checkForUpdatesNow(): Promise<void> {
	const dialogs = useAppDialogsStore.getState();
	if (dialogs.isCheckingForUpdates) return;
	dialogs.setIsCheckingForUpdates({ isChecking: true });
	try {
		const update = await findUpdate();
		if (update) {
			dialogs.setUpdate({ update });
			return;
		}
		const info = await getAppInfo();
		toast.success("MagnetCut is up to date", {
			description: info ? `Version ${info.version} is the newest.` : undefined,
		});
	} catch (error) {
		toast.error("Couldn't check for updates", {
			description: describeError(error),
		});
	} finally {
		dialogs.setIsCheckingForUpdates({ isChecking: false });
	}
}

/** The daily check: quiet, unless there's a version the user hasn't skipped. */
export async function checkForUpdatesIfDue(): Promise<void> {
	const info = await getAppInfo();
	if (!info?.updates) return;
	const { checksForUpdates, lastUpdateCheck } = useSettingsStore.getState();
	if (!checksForUpdates) return;
	// A check in the future means the clock was wrong: it doesn't count.
	const elapsed =
		lastUpdateCheck === null
			? Number.POSITIVE_INFINITY
			: Date.now() - lastUpdateCheck;
	if (elapsed >= 0 && elapsed < DAY_MS) return;
	const dialogs = useAppDialogsStore.getState();
	if (dialogs.isCheckingForUpdates || dialogs.update) return;
	try {
		const update = await findUpdate();
		if (
			update &&
			update.version !== useSettingsStore.getState().skippedVersion
		) {
			dialogs.setUpdate({ update });
		}
	} catch {
		// Offline, most likely: the next look, within the hour, tries again.
	}
}

/** Downloads the update, saves the open project, installs and restarts. */
export async function installUpdate({
	update,
	onProgress,
}: {
	update: Update;
	onProgress: (progress: DownloadProgress) => void;
}): Promise<void> {
	let downloaded = 0;
	let total: number | null = null;
	await update.download((event) => {
		if (event.event === "Started") total = event.data.contentLength ?? null;
		if (event.event === "Progress") downloaded += event.data.chunkLength;
		onProgress({ downloaded, total });
	});
	// On Windows the installer closes the app as it starts.
	const { EditorCore } = await import("@/core");
	await EditorCore.getInstance().save.flush();
	await update.install();
	await relaunch();
}
