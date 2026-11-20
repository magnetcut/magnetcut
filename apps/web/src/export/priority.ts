import { invoke, isTauri } from "@tauri-apps/api/core";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

// How much of the computer the desktop app's export takes
// (apps/desktop/src/render/priority.rs): one for every export, kept for the
// next, and changed while one runs, which takes it at its next frame. Not part
// of the export's choices or presets: it's about this computer, not the file.

export const EXPORT_PRIORITIES = ["normal", "low", "background"] as const;

export type ExportPriority = (typeof EXPORT_PRIORITIES)[number];

export const EXPORT_PRIORITY_LABELS: Record<ExportPriority, string> = {
	normal: "Normal",
	low: "Low",
	background: "Background",
};

export const EXPORT_PRIORITY_DESCRIPTIONS: Record<ExportPriority, string> = {
	normal: "As fast as it can.",
	low: "Gives way to whatever else the computer is doing.",
	background: "Only with time to spare: much slower.",
};

export function isExportPriority(value: unknown): value is ExportPriority {
	return EXPORT_PRIORITIES.some((priority) => priority === value);
}

interface ExportPriorityState {
	priority: ExportPriority;
	setPriority: ({ priority }: { priority: ExportPriority }) => void;
}

export const useExportPriorityStore = create<ExportPriorityState>()(
	persist(
		(set) => ({
			priority: "normal",
			setPriority: ({ priority }) => {
				set({ priority });
				// For the exports being made; one started later is given it.
				if (isTauri()) {
					invoke("native_export_priority", { priority }).catch(
						(error: unknown) => {
							console.error("Couldn't change the export's priority:", error);
						},
					);
				}
			},
		}),
		{
			name: "magnetcut-export-priority",
			// localStorage itself, as by default, but where there's none (bun's
			// tests) it's missing, not undefined: kept in memory then.
			storage: createJSONStorage(() => localStorage),
			partialize: ({ priority }) => ({ priority }),
			// Whatever was stored, by this version or another, is checked.
			merge: (persisted, current) => {
				const priority = Reflect.get(Object(persisted), "priority");
				return {
					...current,
					priority: isExportPriority(priority) ? priority : current.priority,
				};
			},
		},
	),
);
