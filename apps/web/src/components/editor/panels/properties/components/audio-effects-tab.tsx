"use client";

import { Button } from "@/components/ui/button";
import { Section, SectionContent } from "@/components/section";
import { useEditor } from "@/editor/use-editor";
import {
	AUDIO_EFFECT_PRESETS,
	AUDIO_EFFECT_SECTIONS,
	applyAudioEffectPreset,
	readAudioEffects,
} from "@/media/audio-effects";
import { getEqResponse, listCurveFrequencies } from "@/media/eq-curve";
import type { ParamValues } from "@/params";
import type { AudioElement, VideoElement } from "@/timeline";
import { ElementParamsTab } from "./element-params-tab";

const VOLUME_PARAM_KEYS = ["volume", "muted"] as const;

/**
 * A clip's Audio tab: its volume, then its sound cleaned up and shaped
 * (docs/AUDIO-EFFECTS.md), with presets.
 */
export function AudioTab({
	element,
	trackId,
}: {
	element: AudioElement | VideoElement;
	trackId: string;
}) {
	const editor = useEditor();
	const isOn = readAudioEffects({ params: element.params }) !== null;

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
							? "Worked out on the clip's whole sound before it plays: a long clip takes a moment."
							: "Presets set everything below at once; Off turns it all off."}
					</p>
				</SectionContent>
			</Section>
			{AUDIO_EFFECT_SECTIONS.map((section) => (
				<div key={section.key}>
					<ElementParamsTab
						element={element}
						trackId={trackId}
						params={section.params}
						sectionKey={`audio-${section.key}`}
						title={section.title}
						hint={section.hint}
					/>
					{section.key === "eq" && element.params.eqEnabled === true && (
						<EqCurve params={element.params} />
					)}
				</div>
			))}
		</>
	);
}

const CURVE_WIDTH = 240;
const CURVE_HEIGHT = 72;
const CURVE_RANGE_DB = 24;
const CURVE_FREQUENCIES = listCurveFrequencies({ count: 96 });

/** The equaliser's response, 20 Hz to 20 kHz, ±24 dB. */
function EqCurve({ params }: { params: ParamValues }) {
	const response = getEqResponse({ params, frequencies: CURVE_FREQUENCIES });
	const toY = (db: number) => {
		const clamped = Math.max(-CURVE_RANGE_DB, Math.min(CURVE_RANGE_DB, db));
		return (
			CURVE_HEIGHT / 2 - (clamped / CURVE_RANGE_DB) * (CURVE_HEIGHT / 2 - 2)
		);
	};
	const points = response
		.map(
			(db, index) =>
				`${((index / (response.length - 1)) * CURVE_WIDTH).toFixed(1)},${toY(db).toFixed(1)}`,
		)
		.join(" ");
	return (
		<div className="border-b px-4 pb-4">
			<svg
				viewBox={`0 0 ${CURVE_WIDTH} ${CURVE_HEIGHT}`}
				className="bg-muted/40 h-18 w-full rounded-md border"
				preserveAspectRatio="none"
				role="img"
				aria-label="The equaliser's curve"
			>
				<line
					x1={0}
					x2={CURVE_WIDTH}
					y1={CURVE_HEIGHT / 2}
					y2={CURVE_HEIGHT / 2}
					className="stroke-border"
					strokeDasharray="3 3"
				/>
				<polyline
					points={points}
					fill="none"
					className="stroke-primary"
					strokeWidth={1.5}
					vectorEffect="non-scaling-stroke"
				/>
			</svg>
			<div className="text-muted-foreground mt-1 flex justify-between text-[0.65rem]">
				<span>20 Hz</span>
				<span>200</span>
				<span>2k</span>
				<span>20 kHz</span>
			</div>
		</div>
	);
}
