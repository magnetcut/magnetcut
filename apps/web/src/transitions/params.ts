import { type ShaderInfo, type ShaderParam, shaderInfo } from "magnetcut-wasm";
import type { ParamDefinition, ParamValue } from "@/params";
import type { TransitionParamValue } from "@/timeline";
import type { TransitionDefinition, TransitionParamControl } from "./catalog";

/** One of a transition's parameters in the inspector. */
export interface TransitionParamField {
	param: ParamDefinition;
	/** Its value when the transition doesn't set one: the type's, or the shader's. */
	initial: TransitionParamValue;
	/** What the inspector shows for a stored value. */
	toInput: (value: TransitionParamValue) => ParamValue;
	/** What to store for the inspector's value; null for one it can't be. */
	fromInput: (value: ParamValue) => TransitionParamValue | null;
}

const shaders = new Map<string, ShaderInfo | undefined>();

function getShaderInfo({ shader }: { shader: string }) {
	if (!shaders.has(shader)) shaders.set(shader, shaderInfo({ shader }));
	return shaders.get(shader);
}

/** `zoom_quickness` or `colorPhase` as "Zoom quickness" or "Color phase". */
function labelFromName({ name }: { name: string }) {
	const words = name
		.replace(/_/g, " ")
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.toLowerCase();
	return words.charAt(0).toUpperCase() + words.slice(1);
}

const optionKey = ({ value }: { value: TransitionParamValue }) =>
	Array.isArray(value) ? value.join(",") : String(value);

const toHexChannel = ({ channel }: { channel: number }) =>
	Math.round(Math.min(1, Math.max(0, channel)) * 255)
		.toString(16)
		.padStart(2, "0");

function colorToHex({ value }: { value: TransitionParamValue }) {
	if (!Array.isArray(value)) return "#000000";
	return `#${value
		.slice(0, 3)
		.map((channel) => toHexChannel({ channel }))
		.join("")}`;
}

function hexToColor({ hex, size }: { hex: string; size: number }) {
	const match = /^#?([0-9a-f]{6})/i.exec(hex);
	if (!match) return null;
	const rgb = [0, 2, 4].map(
		(offset) => Number.parseInt(match[1].slice(offset, offset + 2), 16) / 255,
	);
	return size === 4 ? [...rgb, 1] : rgb;
}

function toField({
	shaderParam,
	control,
	preset,
}: {
	shaderParam: ShaderParam;
	control: TransitionParamControl | undefined;
	preset: TransitionParamValue | undefined;
}): TransitionParamField | null {
	if (control?.hidden) return null;
	const key = shaderParam.name;
	const label = control?.label ?? labelFromName({ name: key });
	const initial = preset ?? shaderParam.default;

	if (control?.options) {
		const values = new Map(
			control.options.map(({ value }) => [optionKey({ value }), value]),
		);
		return {
			param: {
				key,
				label,
				type: "select",
				default: optionKey({ value: initial }),
				options: control.options.map(({ value, label: optionLabel }) => ({
					value: optionKey({ value }),
					label: optionLabel,
				})),
			},
			initial,
			toInput: (value) => optionKey({ value }),
			fromInput: (value) => values.get(String(value)) ?? null,
		};
	}

	switch (shaderParam.kind) {
		case "float":
		case "int": {
			const isInteger = shaderParam.kind === "int";
			return {
				param: {
					key,
					label,
					type: "number",
					default: typeof initial === "number" ? initial : 0,
					min: control?.min ?? shaderParam.min ?? 0,
					max: control?.max ?? shaderParam.max,
					step: control?.step ?? shaderParam.step ?? (isInteger ? 1 : 0.01),
				},
				initial,
				toInput: (value) => (typeof value === "number" ? value : 0),
				fromInput: (value) =>
					typeof value === "number"
						? isInteger
							? Math.round(value)
							: value
						: null,
			};
		}
		case "bool":
			return {
				param: { key, label, type: "boolean", default: initial === true },
				initial,
				toInput: (value) => value === true,
				fromInput: (value) => (typeof value === "boolean" ? value : null),
			};
		case "vec3":
		case "vec4": {
			if (!shaderParam.color) return null;
			const size = shaderParam.kind === "vec4" ? 4 : 3;
			return {
				param: {
					key,
					label,
					type: "color",
					default: colorToHex({ value: initial }),
				},
				initial,
				toInput: (value) => colorToHex({ value }),
				fromInput: (value) => hexToColor({ hex: String(value), size }),
			};
		}
		default:
			// Other vectors need choices from the catalogue to be offered.
			return null;
	}
}

/** The parameters the inspector offers for a transition type. */
export function getTransitionParamFields({
	definition,
}: {
	definition: TransitionDefinition;
}): TransitionParamField[] {
	const info = getShaderInfo({ shader: definition.shader });
	if (!info) return [];
	return info.params.flatMap((shaderParam) => {
		const field = toField({
			shaderParam,
			control: definition.controls?.[shaderParam.name],
			preset: definition.params[shaderParam.name],
		});
		return field ? [field] : [];
	});
}
