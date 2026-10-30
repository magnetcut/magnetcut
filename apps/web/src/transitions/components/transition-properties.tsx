"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import { Clock01Icon } from "@hugeicons/core-free-icons";
import { useEditor } from "@/editor/use-editor";
import { Button } from "@/components/ui/button";
import { NumberField } from "@/components/ui/number-field";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
	Section,
	SectionContent,
	SectionField,
	SectionFields,
	SectionHeader,
	SectionTitle,
} from "@/components/section";
import { usePropertyDraft } from "@/components/editor/panels/properties/hooks/use-property-draft";
import { PropertyParamField } from "@/components/editor/panels/properties/components/property-param-field";
import type {
	Transition,
	TransitionAlignment,
	TransitionRef,
} from "@/timeline";
import {
	TRANSITIONS,
	getTransitionDefinition,
	getTransitionParamFields,
	getTransitionWindow,
} from "@/transitions";
import { formatNumberForDisplay } from "@/utils/math";
import {
	type MediaTime,
	TICKS_PER_SECOND,
	mediaTimeFromSeconds,
	roundFrameTime,
} from "@/wasm";

const ALIGNMENTS: { value: TransitionAlignment; label: string }[] = [
	{ value: "end", label: "Before" },
	{ value: "center", label: "Centered" },
	{ value: "start", label: "After" },
];

function isAlignment(value: string): value is TransitionAlignment {
	return ALIGNMENTS.some((alignment) => alignment.value === value);
}

const toSeconds = ({ time }: { time: number }) =>
	formatNumberForDisplay({ value: time / TICKS_PER_SECOND, fractionDigits: 2 });

export function TransitionProperties({ trackId, transitionId }: TransitionRef) {
	const editor = useEditor();
	const fps = useEditor((e) => e.project.getActive()?.settings.fps);
	// As previewed: a scrub shows before it's committed.
	const track = useEditor((e) => {
		const tracks = e.timeline.getPreviewTracks();
		return tracks
			? [tracks.main, ...tracks.overlay].find(({ id }) => id === trackId)
			: undefined;
	});
	const transition =
		track?.type === "video"
			? track.transitions?.find(({ id }) => id === transitionId)
			: undefined;

	const parseDuration = (input: string): MediaTime | null => {
		const seconds = Number.parseFloat(input);
		if (!Number.isFinite(seconds) || seconds <= 0) return null;
		const time = mediaTimeFromSeconds({ seconds });
		return fps ? roundFrameTime({ time, fps }) : time;
	};
	const update = (changes: Partial<Omit<Transition, "id">>) =>
		editor.timeline.updateTransition({ trackId, transitionId, changes });
	const preview = (changes: Partial<Omit<Transition, "id">>) =>
		editor.timeline.previewTransition({ transitionId, changes });
	const commit = () => editor.timeline.commitPreview();

	const durationDraft = usePropertyDraft({
		displayValue: transition ? toSeconds({ time: transition.duration }) : "",
		parse: parseDuration,
		onPreview: (duration) => preview({ duration }),
		onCommit: commit,
	});

	if (track?.type !== "video" || !transition) return null;

	const from = track.elements.find(({ id }) => id === transition.fromElementId);
	const to = track.elements.find(({ id }) => id === transition.toElementId);
	const window =
		from && to ? getTransitionWindow({ transition, from, to }) : null;
	const definition = getTransitionDefinition({ type: transition.type });
	const paramFields = getTransitionParamFields({ definition });

	return (
		<Section sectionKey={`${transitionId}:transition`}>
			<SectionHeader>
				<SectionTitle>Transition</SectionTitle>
			</SectionHeader>
			<SectionContent>
				<SectionFields>
					<SectionField label="Type">
						<Select
							value={definition.id}
							onValueChange={(type) => update({ type, params: {} })}
						>
							<SelectTrigger className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{TRANSITIONS.map(({ id, name }) => (
									<SelectItem key={id} value={id}>
										{name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</SectionField>
					<SectionField label="Duration">
						<NumberField
							icon={<HugeiconsIcon icon={Clock01Icon} />}
							value={durationDraft.displayValue}
							suffix="s"
							scrubRanges={[{ from: 0, to: 10, pixelsPerUnit: 60 }]}
							scrubClamp={{ min: 0.05, max: 10 }}
							onFocus={durationDraft.onFocus}
							onChange={durationDraft.onChange}
							onBlur={durationDraft.onBlur}
							onScrub={durationDraft.scrubTo}
							onScrubEnd={durationDraft.commitScrub}
						/>
					</SectionField>
					{window?.clamped && (
						<p className="text-muted-foreground text-xs">
							Plays for {toSeconds({ time: window.end - window.start })} s: the
							clips have no more media past the cut.
						</p>
					)}
					{!window && (
						<p className="text-muted-foreground text-xs">
							{
								"Doesn't play: the clips have no media past the cut on this side. Trim them, or place it on the other side."
							}
						</p>
					)}
					{paramFields.map(({ param, initial, toInput, fromInput }) => (
						<PropertyParamField
							key={param.key}
							param={param}
							value={toInput(transition.params[param.key] ?? initial)}
							onPreview={(value) => {
								const next = fromInput(value);
								if (next === null) return;
								preview({
									params: { ...transition.params, [param.key]: next },
								});
							}}
							onCommit={commit}
						/>
					))}
					<SectionField label="Position">
						<ToggleGroup
							type="single"
							variant="outline"
							value={transition.alignment}
							onValueChange={(value) => {
								if (isAlignment(value)) update({ alignment: value });
							}}
						>
							{ALIGNMENTS.map(({ value, label }) => (
								<ToggleGroupItem key={value} value={value} className="px-3">
									{label}
								</ToggleGroupItem>
							))}
						</ToggleGroup>
					</SectionField>
					<div className="flex items-center justify-between">
						<span className="text-sm">Crossfade audio</span>
						<Switch
							checked={transition.crossfadeAudio}
							onCheckedChange={(crossfadeAudio) => update({ crossfadeAudio })}
						/>
					</div>
					<Button
						variant="outline"
						onClick={() => {
							editor.timeline.removeTransition({ trackId, transitionId });
							editor.selection.setSelectedTransition({ transition: null });
						}}
					>
						Remove transition
					</Button>
				</SectionFields>
			</SectionContent>
		</Section>
	);
}
