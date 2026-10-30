import { create } from "zustand";
import { persist } from "zustand/middleware";
import { generateUUID } from "@/utils/id";
import {
	DEFAULT_EXPORT_CHOICES,
	sanitizeChoices,
	sanitizePresets,
	type ExportChoices,
	type ExportPreset,
} from "./choices";

interface ExportChoicesState {
	/** The export panel's choices, kept for the next export. */
	choices: ExportChoices;
	/** Presets of your own; the built-in ones are `BUILT_IN_PRESETS`. */
	presets: ExportPreset[];
	setChoices: ({ choices }: { choices: Partial<ExportChoices> }) => void;
	/** Saves the choices as a preset, replacing one of the same name. */
	savePreset: ({ name }: { name: string }) => void;
	removePreset: ({ id }: { id: string }) => void;
}

export const useExportChoicesStore = create<ExportChoicesState>()(
	persist(
		(set) => ({
			choices: DEFAULT_EXPORT_CHOICES,
			presets: [],
			setChoices: ({ choices }) =>
				set((state) => ({ choices: { ...state.choices, ...choices } })),
			savePreset: ({ name }) =>
				set((state) => {
					const existing = state.presets.find((preset) => preset.name === name);
					const preset = {
						id: existing?.id ?? generateUUID(),
						name,
						choices: state.choices,
					};
					return {
						presets: existing
							? state.presets.map((other) =>
									other.id === existing.id ? preset : other,
								)
							: [...state.presets, preset],
					};
				}),
			removePreset: ({ id }) =>
				set((state) => ({
					presets: state.presets.filter((preset) => preset.id !== id),
				})),
		}),
		{
			name: "magnetcut-export",
			partialize: ({ choices, presets }) => ({ choices, presets }),
			// Whatever was stored, by this version or another, is checked field by field.
			merge: (persisted, current) => ({
				...current,
				choices: sanitizeChoices({
					value: Reflect.get(Object(persisted), "choices"),
				}),
				presets: sanitizePresets({
					value: Reflect.get(Object(persisted), "presets"),
				}),
			}),
		},
	),
);
