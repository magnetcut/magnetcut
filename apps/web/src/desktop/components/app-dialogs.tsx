"use client";

import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
import { useAppDialogsStore } from "../app-dialogs-store";
import { checkForUpdatesIfDue, checkForUpdatesNow } from "../updates";
import { AboutDialog } from "./about-dialog";
import { SettingsDialog } from "./settings-dialog";
import { UpdateDialog } from "./update-dialog";

/** The first check waits for the app to settle after it opens. */
const FIRST_CHECK_DELAY_MS = 10_000;
/** An app left open for days still checks daily: it looks every hour. */
const CHECK_DUE_INTERVAL_MS = 60 * 60 * 1000;

/** About, Settings and updates: on every page, once, in the root layout. */
export function AppDialogs() {
	const openDialog = useAppDialogsStore((state) => state.openDialog);
	const setOpenDialog = useAppDialogsStore((state) => state.setOpenDialog);
	useNativeMenu();
	useDailyUpdateCheck();

	return (
		<>
			<AboutDialog
				isOpen={openDialog === "about"}
				onOpenChange={(open) =>
					setOpenDialog({ dialog: open ? "about" : null })
				}
			/>
			<SettingsDialog
				isOpen={openDialog === "settings"}
				onOpenChange={(open) =>
					setOpenDialog({ dialog: open ? "settings" : null })
				}
			/>
			<UpdateDialog />
		</>
	);
}

/** The macOS menu's own items (apps/desktop/src/menu.rs). */
function useNativeMenu() {
	useEffect(() => {
		if (!isTauri()) return;
		const unlisten = listen<string>("menu", ({ payload }) => {
			if (payload === "about" || payload === "settings") {
				useAppDialogsStore.getState().setOpenDialog({ dialog: payload });
			}
			if (payload === "check-for-updates") void checkForUpdatesNow();
		});
		return () => {
			void unlisten.then((stop) => stop());
		};
	}, []);
}

function useDailyUpdateCheck() {
	useEffect(() => {
		const first = setTimeout(
			() => void checkForUpdatesIfDue(),
			FIRST_CHECK_DELAY_MS,
		);
		const due = setInterval(
			() => void checkForUpdatesIfDue(),
			CHECK_DUE_INTERVAL_MS,
		);
		return () => {
			clearTimeout(first);
			clearInterval(due);
		};
	}, []);
}
