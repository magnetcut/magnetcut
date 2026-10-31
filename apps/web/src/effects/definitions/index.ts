import { effectsRegistry } from "../registry";
import {
	colorAdjustmentDefinition,
	sharpenDefinition,
	vignetteDefinition,
} from "./adjustments";
import { blurEffectDefinition } from "./blur";
import { coverDefinition, pixelateDefinition } from "./hide";

const defaultEffects = [
	blurEffectDefinition,
	colorAdjustmentDefinition,
	vignetteDefinition,
	sharpenDefinition,
	pixelateDefinition,
	coverDefinition,
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
