"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import { DraggableItem } from "@/components/editor/panels/assets/draggable-item";
import { effectsRegistry, EFFECT_TARGET_ELEMENT_TYPES } from "@/effects";
import { effectPreviewService } from "@/services/renderer/effect-preview";
import { useEditor } from "@/editor/use-editor";
import { buildEffectElement } from "@/timeline/element-utils";
import type { EffectDefinition } from "@/effects/types";
import { Button } from "@/components/ui/button";
import { usePropertiesStore } from "@/components/editor/panels/properties/stores/properties-store";
import {
	HIDE_LOOKS,
	HIDE_SHAPES,
	HIDE_SHAPE_NAMES,
	buildHideRegionMask,
	type HideShape,
} from "@/hide/region";

export function EffectsView() {
	const effects = effectsRegistry.getAll().filter(({ category }) => !category);

	return (
		<PanelView title="Effects">
			<EffectsGrid effects={effects} />
		</PanelView>
	);
}

/** Colour, vignette and sharpening: on a clip, or on an effect track to
 * adjust all beneath it. */
export function AdjustmentView() {
	const adjustments = effectsRegistry
		.getAll()
		.filter(({ category }) => category === "adjustment");

	return (
		<PanelView title="Adjustment">
			<p className="text-muted-foreground mb-3 text-xs">
				Drop one on a clip to adjust it, or add it to the timeline to adjust
				everything beneath it. Its settings are in the properties panel.
			</p>
			<EffectsGrid effects={adjustments} />
			<HideSection />
		</PanelView>
	);
}

/** A face or a plate blurred, pixelated or covered: an adjustment layer whose
 * effect applies only within its mask (docs/HIDE.md). */
function HideSection() {
	const editor = useEditor();
	const setActiveTab = usePropertiesStore((state) => state.setActiveTab);
	const [shape, setShape] = useState<HideShape>("face");

	const add = ({ look }: { look: (typeof HIDE_LOOKS)[number] }) => {
		const canvasSize = editor.project.getActive().settings.canvasSize;
		const element = buildEffectElement({
			effectType: look.effectType,
			startTime: editor.playback.getCurrentTime(),
		});
		editor.timeline.insertElement({
			placement: { mode: "auto", trackType: "effect" },
			element: {
				...element,
				name: `${look.name} ${HIDE_SHAPE_NAMES[shape].toLowerCase()}`,
				params: { ...element.params, ...look.params },
				masks: [buildHideRegionMask({ shape, canvasSize })],
			},
		});
		// Selected as it's added: its mask's handles, to place it.
		setActiveTab({ elementType: "effect", tabId: "masks" });
	};

	return (
		<div className="mt-6 flex flex-col gap-2">
			<h3 className="text-sm font-medium">Hide a face or a plate</h3>
			<div className="flex gap-1">
				{HIDE_SHAPES.map((candidate) => (
					<Button
						key={candidate}
						size="sm"
						variant={candidate === shape ? "default" : "outline"}
						onClick={() => setShape(candidate)}
					>
						{HIDE_SHAPE_NAMES[candidate]}
					</Button>
				))}
			</div>
			<div className="grid grid-cols-3 gap-1">
				{HIDE_LOOKS.map((look) => (
					<Button
						key={look.effectType}
						size="sm"
						variant="secondary"
						onClick={() => add({ look })}
					>
						{look.name}
					</Button>
				))}
			</div>
			<p className="text-muted-foreground text-xs">
				Adds a region at the playhead, above the clips: move and size it in the
				preview. Check every frame before you share the film: a region that
				misses a frame shows what&apos;s under it.
			</p>
		</div>
	);
}

function EffectsGrid({ effects }: { effects: EffectDefinition[] }) {
	return (
		<div
			className="grid gap-2"
			style={{ gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))" }}
		>
			{effects.map((effect) => (
				<EffectItem key={effect.type} effect={effect} />
			))}
		</div>
	);
}

function EffectPreviewCanvas({ effect }: { effect: EffectDefinition }) {
	const canvasRef = useRef<HTMLCanvasElement>(null);

	useEffect(() => {
		const render = () => {
			if (canvasRef.current) {
				effectPreviewService.renderPreview({
					effectType: effect.type,
					params: effect.previewParams ?? {},
					targetCanvas: canvasRef.current,
				});
			}
		};

		render();
		return effectPreviewService.onPreviewImageReady({ callback: render });
	}, [effect]);

	return <canvas ref={canvasRef} className="size-full" />;
}

function EffectItem({ effect }: { effect: EffectDefinition }) {
	const editor = useEditor();

	const handleAddToTimeline = useCallback(() => {
		const currentTime = editor.playback.getCurrentTime();
		const element = buildEffectElement({
			effectType: effect.type,
			startTime: currentTime,
		});

		editor.timeline.insertElement({
			placement: { mode: "auto", trackType: "effect" },
			element,
		});
	}, [editor, effect.type]);

	const preview = <EffectPreviewCanvas effect={effect} />;

	return (
		<DraggableItem
			name={effect.name}
			preview={preview}
			dragData={{
				id: effect.type,
				name: effect.name,
				type: "effect",
				effectType: effect.type,
				targetElementTypes: EFFECT_TARGET_ELEMENT_TYPES,
			}}
			onAddToTimeline={handleAddToTimeline}
			aspectRatio={1}
			isRounded
			variant="card"
			containerClassName="w-full"
		/>
	);
}
