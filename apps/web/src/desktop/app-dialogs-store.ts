import type { Update } from "@tauri-apps/plugin-updater";
import { create } from "zustand";

export type AppDialog = "about" | "settings";

interface AppDialogsState {
	openDialog: AppDialog | null;
	/** A newer version to offer, found by the daily check or Check Now. */
	update: Update | null;
	isCheckingForUpdates: boolean;
	setOpenDialog: ({ dialog }: { dialog: AppDialog | null }) => void;
	setUpdate: ({ update }: { update: Update | null }) => void;
	setIsCheckingForUpdates: ({ isChecking }: { isChecking: boolean }) => void;
}

export const useAppDialogsStore = create<AppDialogsState>()((set) => ({
	openDialog: null,
	update: null,
	isCheckingForUpdates: false,
	setOpenDialog: ({ dialog }) => set({ openDialog: dialog }),
	setUpdate: ({ update }) => set({ update }),
	setIsCheckingForUpdates: ({ isChecking }) =>
		set({ isCheckingForUpdates: isChecking }),
}));
