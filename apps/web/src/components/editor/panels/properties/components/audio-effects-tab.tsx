"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
	Section,
	SectionContent,
	SectionHeader,
	SectionTitle,
} from "@/components/section";
import { useEditor } from "@/editor/use-editor";
import {
	AUDIO_EFFECT_PRESETS,
	AUDIO_EFFECT_SECTIONS,
	applyAudioEffectPreset,
	readAudioEffects,
} from "@/media/audio-effects";
import type { NumberParamDefinition, ParamValues } from "@/params";
import type { ElementParamDefinition } from "@/params/registry";
import type { AudioElement, VideoElement } from "@/timeline";
import { FADE_MAX_SECONDS, FADE_SILENCE_DB } from "@/timeline/audio-fades";
import { TICKS_PER_SECOND } from "@/wasm";
import { cn } from "@/utils/ui";
import {
	CompressorGraph,
	EqEditor,
	SegmentedControl,
	SliderBar,
	formatDb,
	formatHz,
	formatMs,
	type Scale,
} from "./audio-controls";
import { ElementParamsTab } from "./element-params-tab";

const VOLUME_PARAM_KEYS = ["volume", "muted"] as const;
const COMPRESSOR_BESIDE_GRAPH = [
	"compressorThreshold",
	"compressorRatio",
	"compressorMakeup",
];

type AudioEffectSection = (typeof AUDIO_EFFECT_SECTIONS)[number];

/**
 * A clip's Audio tab: its volume, then its sound cleaned up and shaped
 * (docs/AUDIO-EFFECTS.md), with presets, the equaliser drawn and the
 * numbers bars.
 */
export function AudioTab({
	element,
	trackId,
}: {
	element: AudioElement | VideoElement;
	trackId: string;
}) {
	const editor = useEditor();
	const draft = useParamsDraft({ element, trackId });
	const isOn = readAudioEffects({ params: draft.values }) !== null;

	const applyPreset = (preset: (typeof AUDIO_EFFECT_PRESETS)[number]) => {
		editor.timeline.updateElements({
			updates: [
				{
					trackId,
					elementId: element.id,
					patch: {
						params: applyAudioEffectPreset({
							params: element.params,
							preset,
						}),
					},
				},
			],
		});
	};

	return (
		<>
			<ElementParamsTab
				element={element}
				trackId={trackId}
				paramKeys={VOLUME_PARAM_KEYS}
				sectionKey="audio"
			/>
			{/* A video clip's fades will fade its picture too (docs/FADES.md): with that. */}
			{element.type === "audio" && (
				<FadeSection element={element} draft={draft} />
			)}
			<Section sectionKey={`${element.id}:audio-presets`}>
				<SectionContent className="flex flex-col gap-2 pt-4">
					<div className="flex flex-wrap gap-1.5">
						{AUDIO_EFFECT_PRESETS.map((preset) => (
							<Button
								key={preset.key}
								variant="outline"
								size="sm"
								className="h-7 px-2 text-xs"
								onClick={() => applyPreset(preset)}
							>
								{preset.name}
							</Button>
						))}
					</div>
					<p className="text-muted-foreground text-xs">
						{isOn
							? "Worked out on the clip's whole sound when let go: a long clip takes a moment."
							: "Presets set everything below at once; Off turns it all off."}
					</p>
				</SectionContent>
			</Section>
			{AUDIO_EFFECT_SECTIONS.map((section) => (
				<EffectSection
					key={section.key}
					elementId={element.id}
					section={section}
					draft={draft}
				/>
			))}
		</>
	);
}

interface ParamsDraft {
	/** The clip's parameters, with what's being dragged. */
	values: ParamValues;
	change: (values: ParamValues) => void;
	/** Writes the draft as one undo step, if it changed anything. */
	commit: () => void;
}

/**
 * Changes held while a control is dragged and written when it's let go: the
 * effects run on the clip's whole sound, once per change written.
 */
function useParamsDraft({
	element,
	trackId,
}: {
	element: AudioElement | VideoElement;
	trackId: string;
}): ParamsDraft {
	const editor = useEditor();
	type Draft = { elementId: string; values: ParamValues };
	const [draft, setDraft] = useState<Draft | null>(null);
	const latest = useRef<Draft | null>(null);
	const pending = (value: Draft | null) =>
		value?.elementId === element.id ? value.values : {};

	return {
		values: { ...element.params, ...pending(draft) },
		change: (values) => {
			const next = {
				elementId: element.id,
				values: { ...pending(latest.current), ...values },
			};
			latest.current = next;
			setDraft(next);
		},
		commit: () => {
			const values = pending(latest.current);
			latest.current = null;
			setDraft(null);
			const isChanged = Object.entries(values).some(
				([key, value]) => element.params[key] !== value,
			);
			if (!isChanged) return;
			editor.timeline.updateElements({
				updates: [
					{
						trackId,
						elementId: element.id,
						patch: { params: { ...element.params, ...values } },
					},
				],
			});
		},
	};
}

const FADE_SIDES = [
	{
		length: "fadeIn",
		level: "fadeInLevel",
		name: "Fade in",
		levelName: "From",
	},
	{
		length: "fadeOut",
		level: "fadeOutLevel",
		name: "Fade out",
		levelName: "To",
	},
] as const;

/**
 * The clip's fades (timeline/audio-fades.ts), as its points on the timeline
 * set them: each one's length, and once it has one, the level it starts from
 * or ends at.
 */
function FadeSection({
	element,
	draft,
}: {
	element: AudioElement | VideoElement;
	draft: ParamsDraft;
}) {
	const { values, change, commit } = draft;
	const duration = element.duration / TICKS_PER_SECOND;
	const read = ({ key, fallback }: { key: string; fallback: number }) => {
		const value = values[key];
		return typeof value === "number" ? value : fallback;
	};
	return (
		<Section sectionKey={`${element.id}:audio-fades`}>
			<SectionHeader>
				<SectionTitle>Fades</SectionTitle>
			</SectionHeader>
			<SectionContent className="flex flex-col gap-1.5">
				{FADE_SIDES.map((side) => {
					const length = read({ key: side.length, fallback: 0 });
					return (
						<div key={side.length} className="flex flex-col gap-1.5">
							<SliderBar
								label={side.name}
								value={length}
								min={0}
								max={Math.max(0.01, Math.min(FADE_MAX_SECONDS, duration))}
								step={0.01}
								defaultValue={0}
								format={(value) =>
									value === 0 ? "None" : `${value.toFixed(2)} s`
								}
								onChange={(value) => change({ [side.length]: value })}
								onCommit={commit}
							/>
							{length > 0 && (
								<SliderBar
									label={side.levelName}
									value={read({ key: side.level, fallback: FADE_SILENCE_DB })}
									min={FADE_SILENCE_DB}
									max={0}
									step={0.5}
									defaultValue={FADE_SILENCE_DB}
									format={(value) =>
										value <= FADE_SILENCE_DB ? "Silence" : formatDb({ value })
									}
									onChange={(value) => change({ [side.level]: value })}
									onCommit={commit}
								/>
							)}
						</div>
					);
				})}
				<p className="text-muted-foreground mt-1 text-xs">
					On an audio clip, the points at its ends set these too: drag one along
					the volume line, or down.
				</p>
			</SectionContent>
		</Section>
	);
}

function EffectSection({
	elementId,
	section,
	draft,
}: {
	elementId: string;
	section: AudioEffectSection;
	draft: ParamsDraft;
}) {
	const { values, commit } = draft;
	const toggle = section.params.find((param) => param.type === "boolean");
	const isEnabled = toggle ? values[toggle.key] === true : true;
	const controls = section.params.filter((param) => param !== toggle);
	// A control changed while its effect is off turns it on.
	const change = (next: ParamValues) =>
		draft.change(toggle && !isEnabled ? { ...next, [toggle.key]: true } : next);
	// The equaliser is drawn when off too, its points there to be dragged.
	const isShown = isEnabled || section.key === "eq";

	return (
		<Section sectionKey={`${elementId}:audio-${section.key}`}>
			<SectionHeader
				trailing={
					toggle && (
						<Switch
							checked={isEnabled}
							aria-label={section.title}
							onCheckedChange={(checked) => {
								draft.change({ [toggle.key]: checked });
								commit();
							}}
						/>
					)
				}
			>
				<SectionTitle>{section.title}</SectionTitle>
			</SectionHeader>
			{isShown && (
				<SectionContent
					className={cn(
						"flex flex-col gap-1.5",
						!isEnabled && "opacity-60 transition-opacity hover:opacity-100",
					)}
				>
					{section.key === "eq" ? (
						<EqEditor params={values} onChange={change} onCommit={commit} />
					) : section.key === "compressor" ? (
						<CompressorControls
							controls={controls}
							values={values}
							onChange={change}
							onCommit={commit}
						/>
					) : (
						controls.map((param) => (
							<ParamControl
								key={param.key}
								param={param}
								values={values}
								onChange={change}
								onCommit={commit}
							/>
						))
					)}
					{section.hint && (
						<p className="text-muted-foreground mt-1 text-xs">{section.hint}</p>
					)}
				</SectionContent>
			)}
		</Section>
	);
}

function CompressorControls({
	controls,
	values,
	onChange,
	onCommit,
}: {
	controls: ElementParamDefinition[];
	values: ParamValues;
	onChange: (values: ParamValues) => void;
	onCommit: () => void;
}) {
	const read = (key: string) => {
		const param = controls.find((control) => control.key === key);
		const value = values[key] ?? param?.default;
		return typeof value === "number" ? value : 0;
	};
	const control = (param: ElementParamDefinition) => (
		<ParamControl
			key={param.key}
			param={param}
			values={values}
			onChange={onChange}
			onCommit={onCommit}
		/>
	);
	return (
		<>
			<div className="flex gap-2">
				<div className="size-24 shrink-0">
					<CompressorGraph
						threshold={read("compressorThreshold")}
						ratio={read("compressorRatio")}
						makeup={read("compressorMakeup")}
					/>
				</div>
				<div className="flex min-w-0 flex-1 flex-col justify-between">
					{controls
						.filter((param) => COMPRESSOR_BESIDE_GRAPH.includes(param.key))
						.map(control)}
				</div>
			</div>
			{controls
				.filter((param) => !COMPRESSOR_BESIDE_GRAPH.includes(param.key))
				.map(control)}
		</>
	);
}

function ParamControl({
	param,
	values,
	onChange,
	onCommit,
}: {
	param: ElementParamDefinition;
	values: ParamValues;
	onChange: (values: ParamValues) => void;
	onCommit: () => void;
}) {
	const value = values[param.key] ?? param.default;
	if (param.type === "select") {
		return (
			<SegmentedControl
				label={param.label}
				value={String(value)}
				options={param.options.map((option) => ({
					value: option.value,
					label: option.label.replace(/\s*\(.*\)$/, ""),
					title: option.label,
				}))}
				onChange={(next) => {
					onChange({ [param.key]: next });
					onCommit();
				}}
			/>
		);
	}
	if (param.type !== "number") return null;
	const { label, format, scale } = describeNumber({ param });
	return (
		<SliderBar
			label={label}
			value={typeof value === "number" ? value : param.default}
			min={param.min}
			max={param.max ?? param.min}
			step={param.step}
			defaultValue={param.default}
			scale={scale}
			format={format}
			onChange={(next) => onChange({ [param.key]: next })}
			onCommit={onCommit}
		/>
	);
}

/**
 * A number's name, its value as written and its bar's scale, from its
 * definition: the unit from the label's brackets, and a log scale for a
 * range that spans more than twentyfold.
 */
function describeNumber({ param }: { param: NumberParamDefinition }): {
	label: string;
	format: (value: number) => string;
	scale: Scale;
} {
	const [, name = param.label, unit = ""] =
		/^(.*?)\s*\((.+)\)$/.exec(param.label) ?? [];
	const max = param.max ?? param.min;
	const scale: Scale =
		param.min > 0 && max / param.min >= 20 ? "log" : "linear";
	const format =
		param.unit === "percent"
			? (value: number) => `${Math.round(value * 100)}%`
			: unit.startsWith("dB")
				? (value: number) => formatDb({ value })
				: unit.startsWith("Hz")
					? (value: number) => (value === 0 ? "Off" : formatHz({ value }))
					: unit.startsWith("ms")
						? (value: number) => formatMs({ value })
						: param.key === "compressorRatio"
							? (value: number) => `${value.toFixed(1)}:1`
							: (value: number) => String(value);
	return { label: name, format, scale };
}
