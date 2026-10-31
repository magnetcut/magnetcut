import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

export type AppInfo = {
	version: string;
	/** Whether this edition updates itself: not the App Store one. */
	updates: boolean;
};

let appInfo: Promise<AppInfo | null> | null = null;

/** The desktop app's version and edition; null in a browser. */
export function getAppInfo(): Promise<AppInfo | null> {
	appInfo ??= isTauri() ? invoke<AppInfo>("app_info") : Promise.resolve(null);
	return appInfo;
}

/** The program writing an exported file, as the file's metadata says it: MagnetCut and, in the
 * desktop app, its version. */
export async function getWritingApp(): Promise<string> {
	const info = await getAppInfo();
	return info ? `MagnetCut ${info.version}` : "MagnetCut";
}

export function useAppInfo(): AppInfo | null {
	const [info, setInfo] = useState<AppInfo | null>(null);
	useEffect(() => {
		let isCurrent = true;
		void getAppInfo().then((value) => {
			if (isCurrent) setInfo(value);
		});
		return () => {
			isCurrent = false;
		};
	}, []);
	return info;
}
