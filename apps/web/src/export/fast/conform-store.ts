import { create } from "zustand";

/** The main track's files that keep Fast mode from joining them, and the dialog that converts them. */
interface ConformState {
	/** Each such file's media id, with how it differs from the rest. */
	odd: ReadonlyMap<string, string>;
	isDialogOpen: boolean;
	setOdd: (odd: ReadonlyMap<string, string>) => void;
	openDialog: () => void;
	closeDialog: () => void;
}

const NONE: ReadonlyMap<string, string> = new Map();

export const useConformStore = create<ConformState>()((set) => ({
	odd: NONE,
	isDialogOpen: false,
	setOdd: (odd) => set({ odd: odd.size === 0 ? NONE : odd }),
	openDialog: () => set({ isDialogOpen: true }),
	closeDialog: () => set({ isDialogOpen: false }),
}));
