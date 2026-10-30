import { getPersistedKeybindingsState } from "../persisted-state";

/** The new transition shortcut, where "t" isn't taken. */
export function v7ToV8({ state }: { state: unknown }): unknown {
	const v7 = getPersistedKeybindingsState({ state });
	if (!v7) return state;
	const keybindings = { ...v7.keybindings };

	if (keybindings.t === undefined) {
		keybindings.t = "add-transition";
	}

	return { ...v7, keybindings };
}
