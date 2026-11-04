"use client";

import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { AgentBridge } from "@/agent/bridge";
import { useAppDialogsStore } from "../app-dialogs-store";
import { openProjectFromDisk, saveProjectToDisk } from "../project-files";
import type { ProbeOptions } from "../probe-checks";
import { checkForUpdatesIfDue, checkForUpdatesNow } from "../updates";
import { AboutDialog } from "./about-dialog";
import { SettingsDialog } from "./settings-dialog";
import { UpdateDialog } from "./update-dialog";

/** The first check waits for the app to settle after it opens. */
const FIRST_CHECK_DELAY_MS = 10_000;
/** An app left open for days still checks daily: it looks every hour. */
const CHECK_DUE_INTERVAL_MS = 60 * 60 * 1000;

/** About, Settings, updates and agents: on every page, once, in the root layout. */
export function AppDialogs() {
	const openDialog = useAppDialogsStore((state) => state.openDialog);
	const setOpenDialog = useAppDialogsStore((state) => state.setOpenDialog);
	useNativeMenu();
	useDailyUpdateCheck();
	useProbeChecks();

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
			<AgentBridge />
		</>
	);
}

declare global {
	interface Window {
		/** For the web view probe (apps/desktop/src/probe.js). */
		__magnetcutProbe?: (options: ProbeOptions) => Promise<unknown>;
	}
}

/**
 * The editor's own code, run by the web view probe in each system's web view
 * (apps/desktop/src/probe.js): loaded only when the probe asks.
 */
function useProbeChecks() {
	useEffect(() => {
		if (!isTauri()) return;
		window.__magnetcutProbe = async (options) => {
			const { runProbeChecks } = await import("../probe-checks");
			return runProbeChecks(options);
		};
		return () => {
			delete window.__magnetcutProbe;
		};
	}, []);
}

/** The macOS menu's own items (apps/desktop/src/menu.rs). */
function useNativeMenu() {
	const router = useRouter();
	useEffect(() => {
		if (!isTauri()) return;
		const unlisten = listen<string>("menu", ({ payload }) => {
			if (payload === "about" || payload === "settings") {
				useAppDialogsStore.getState().setOpenDialog({ dialog: payload });
			}
			if (payload === "check-for-updates") void checkForUpdatesNow();
			if (payload === "open-project") {
				void openProjectFromDisk({ navigate: (url) => router.push(url) });
			}
			if (payload === "save-project") void saveProjectToDisk();
		});
		return () => {
			void unlisten.then((stop) => stop());
		};
	}, [router]);
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
