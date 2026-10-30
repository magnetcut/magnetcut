import { effectsRegistry } from "../registry";
import {
	colorAdjustmentDefinition,
	sharpenDefinition,
	vignetteDefinition,
} from "./adjustments";
import { blurEffectDefinition } from "./blur";

const defaultEffects = [
	blurEffectDefinition,
	colorAdjustmentDefinition,
	vignetteDefinition,
	sharpenDefinition,
];

export function registerDefaultEffects(): void {
	for (const definition of defaultEffects) {
		if (effectsRegistry.has(definition.type)) {
			continue;
		}
		effectsRegistry.register({
			key: definition.type,
			definition,
		});
	}
}
