import { create } from "zustand";
import { persist } from "zustand/middleware";

interface SettingsState {
	/** The daily check for a new version (Settings). */
	checksForUpdates: boolean;
	/** When the last check succeeded, in ms since the epoch. */
	lastUpdateCheck: number | null;
	/** A version the daily check doesn't offer again; Check Now still does. */
	skippedVersion: string | null;
	setChecksForUpdates: ({ enabled }: { enabled: boolean }) => void;
	setLastUpdateCheck: ({ time }: { time: number }) => void;
	setSkippedVersion: ({ version }: { version: string | null }) => void;
}

export const useSettingsStore = create<SettingsState>()(
	persist(
		(set) => ({
			checksForUpdates: true,
			lastUpdateCheck: null,
			skippedVersion: null,
			setChecksForUpdates: ({ enabled }) => set({ checksForUpdates: enabled }),
			setLastUpdateCheck: ({ time }) => set({ lastUpdateCheck: time }),
			setSkippedVersion: ({ version }) => set({ skippedVersion: version }),
		}),
		{ name: "magnetcut-settings" },
	),
);
