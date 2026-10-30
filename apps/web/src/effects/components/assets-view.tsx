"use client";

import { useEffect, useRef, useCallback } from "react";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import { DraggableItem } from "@/components/editor/panels/assets/draggable-item";
import { effectsRegistry, EFFECT_TARGET_ELEMENT_TYPES } from "@/effects";
import { effectPreviewService } from "@/services/renderer/effect-preview";
import { useEditor } from "@/editor/use-editor";
import { buildEffectElement } from "@/timeline/element-utils";
import type { EffectDefinition } from "@/effects/types";

export function EffectsView() {
	const effects = effectsRegistry
		.getAll()
		.filter(({ category }) => category !== "adjustment");

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
		</PanelView>
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
