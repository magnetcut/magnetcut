"use client";

import { useState } from "react";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import { DraggableItem } from "@/components/editor/panels/assets/draggable-item";
import { Input } from "@/components/ui/input";
import { useEditor } from "@/editor/use-editor";
import { TRANSITIONS, type TransitionDefinition } from "@/transitions";
import { addTransitionNearPlayhead } from "@/transitions/add-at-cut";
import { TransitionThumbnail } from "./transition-thumbnail";

export function TransitionsView() {
	const [query, setQuery] = useState("");
	const search = query.trim().toLowerCase();
	const transitions = TRANSITIONS.filter(({ name }) =>
		name.toLowerCase().includes(search),
	);

	return (
		<PanelView title="Transitions">
			<div className="flex flex-col gap-3">
				<Input
					size="sm"
					variant="default"
					placeholder="Search..."
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					showClearIcon
					onClear={() => setQuery("")}
					className="w-full"
					containerClassName="w-full"
				/>
				<div
					className="grid gap-2"
					style={{
						gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))",
					}}
				>
					{transitions.map((definition) => (
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
			preview={<TransitionThumbnail definition={definition} />}
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
