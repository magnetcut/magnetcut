import { describe, expect, test } from "bun:test";
import { shaderInfo } from "magnetcut-wasm";
import {
	TRANSITIONS,
	getTransitionDefinition,
	getTransitionParamFields,
} from "@/transitions";

const fields = ({ type }: { type: string }) =>
	getTransitionParamFields({
		definition: getTransitionDefinition({ type }),
	});

const field = ({ type, key }: { type: string; key: string }) => {
	const found = fields({ type }).find(({ param }) => param.key === key);
	if (!found) throw new Error(`${type} has no ${key}`);
	return found;
};

describe("a transition's parameters in the inspector", () => {
	test("every type's shader is in the collection", () => {
		for (const { shader } of TRANSITIONS) {
			expect(shaderInfo({ shader })?.name).toBe(shader);
		}
		expect(fields({ type: "cross-dissolve" })).toEqual([]);
	});

	test("a number with the type's value and the shader's range", () => {
		const hold = field({ type: "dip-to-black", key: "colorPhase" });
		expect(hold.param).toMatchObject({
			type: "number",
			label: "Hold",
			default: 0.5,
			min: 0,
			max: 1,
		});
		expect(hold.fromInput(0.25)).toBe(0.25);
		expect(hold.fromInput("x")).toBeNull();
	});

	test("what the type sets isn't offered", () => {
		const keys = fields({ type: "dip-to-white" }).map(({ param }) => param.key);
		expect(keys).toEqual(["colorPhase"]);
		expect(fields({ type: "shrink" }).map(({ param }) => param.key)).toEqual([
			"type",
		]);
	});

	test("choices for a vector, by their values", () => {
		const direction = field({ type: "soft-wipe", key: "direction" });
		expect(direction.param.type).toBe("select");
		expect(direction.toInput([1, -1])).toBe("1,-1");
		expect(direction.fromInput("0,1")).toEqual([0, 1]);
		expect(direction.fromInput("2,2")).toBeNull();
	});

	test("choices for an integer", () => {
		const place = field({ type: "grow", key: "type" });
		expect(place.param).toMatchObject({ type: "select", default: "8" });
		expect(place.fromInput("3")).toBe(3);
	});

	test("a flag", () => {
		const opening = field({ type: "iris", key: "opening" });
		expect(opening.param).toMatchObject({ type: "boolean", default: true });
		expect(opening.fromInput(false)).toBe(false);
	});

	test("a label from the shader's name when the catalogue gives none", () => {
		const softness = field({ type: "iris", key: "smoothness" });
		expect(softness.param.label).toBe("Softness");
		expect(field({ type: "zoom", key: "zoom_quickness" }).param.label).toBe(
			"Zoom part",
		);
	});

	test("a color, as hex", () => {
		const [color] = getTransitionParamFields({
			definition: { id: "dip", name: "Dip", shader: "FadeColor", params: {} },
		});
		expect(color.param).toMatchObject({ type: "color", default: "#000000" });
		expect(color.toInput([1, 0.5, 0, 1])).toBe("#ff8000");
		expect(color.fromInput("#ff0000")).toEqual([1, 0, 0, 1]);
	});
});
