"use client";

import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import { DraggableItem } from "@/components/editor/panels/assets/draggable-item";
import { useEditor } from "@/editor/use-editor";
import { TRANSITIONS, type TransitionDefinition } from "@/transitions";
import { addTransitionNearPlayhead } from "@/transitions/add-at-cut";

// The two clips a preview goes between.
const FROM_COLOR = "oklch(0.6 0.13 250)";
const TO_COLOR = "oklch(0.78 0.14 75)";

function previewBackground({
	definition,
}: {
	definition: TransitionDefinition;
}): string {
	const { color } = definition.params;
	if (definition.shader === "FadeColor" && Array.isArray(color)) {
		const [red, green, blue] = color.map((channel) => channel * 255);
		const dip = `rgb(${red} ${green} ${blue})`;
		return `linear-gradient(90deg, ${FROM_COLOR} 10%, ${dip} 50%, ${TO_COLOR} 90%)`;
	}
	return `linear-gradient(90deg, ${FROM_COLOR} 15%, ${TO_COLOR} 85%)`;
}

export function TransitionsView() {
	return (
		<PanelView title="Transitions">
			<div className="flex flex-col gap-3">
				<div
					className="grid gap-2"
					style={{
						gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))",
					}}
				>
					{TRANSITIONS.map((definition) => (
						<TransitionItem key={definition.id} definition={definition} />
					))}
				</div>
				<p className="text-muted-foreground text-xs">
					Drag one onto a cut between two clips, or press T for the cut nearest
					the playhead.
				</p>
			</div>
		</PanelView>
	);
}

function TransitionItem({ definition }: { definition: TransitionDefinition }) {
	const editor = useEditor();

	// The selected transition changes type; otherwise one goes at a cut.
	const handleAddToTimeline = () => {
		const selected = editor.selection.getSelectedTransition();
		if (selected) {
			editor.timeline.updateTransition({
				...selected,
				changes: { type: definition.id, params: {} },
			});
			return;
		}
		addTransitionNearPlayhead({ editor, type: definition.id });
	};

	return (
		<DraggableItem
			name={definition.name}
			preview={
				<div
					className="size-full"
					style={{ background: previewBackground({ definition }) }}
				/>
			}
			dragData={{
				id: definition.id,
				name: definition.name,
				type: "transition",
				transitionType: definition.id,
			}}
			onAddToTimeline={handleAddToTimeline}
			aspectRatio={16 / 9}
			isRounded
			variant="card"
			containerClassName="w-full"
		/>
	);
}
