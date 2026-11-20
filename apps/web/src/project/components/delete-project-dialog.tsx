import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";

/** What the user types to delete. */
const CONFIRMATION = "DELETE";

/** Whether what was typed confirms the deletion: DELETE, in any case, with
 * spaces around it or not. */
export function confirmsDeletion({ typed }: { typed: string }): boolean {
	return typed.trim().toUpperCase() === CONFIRMATION;
}

export function DeleteProjectDialog({
	isOpen,
	onOpenChange,
	onConfirm,
	projectNames,
}: {
	isOpen: boolean;
	onOpenChange: (open: boolean) => void;
	onConfirm: () => void;
	projectNames: string[];
}) {
	return (
		<Dialog open={isOpen} onOpenChange={onOpenChange}>
			<DialogContent
				onOpenAutoFocus={(event) => {
					event.preventDefault();
					event.stopPropagation();
				}}
			>
				{/* Inside the content, which goes when the dialog closes: what
				    was typed goes with it. */}
				<DeleteProjectForm
					projectNames={projectNames}
					onCancel={() => onOpenChange(false)}
					onConfirm={onConfirm}
				/>
			</DialogContent>
		</Dialog>
	);
}

/** The dialog's contents: Delete only once DELETE is typed, and Enter then
 * deletes too. */
function DeleteProjectForm({
	projectNames,
	onCancel,
	onConfirm,
}: {
	projectNames: string[];
	onCancel: () => void;
	onConfirm: () => void;
}) {
	const [typed, setTyped] = useState("");
	const inputId = useId();
	const confirmed = confirmsDeletion({ typed });
	const count = projectNames.length;
	const singleName = count === 1 ? projectNames[0] : null;

	return (
		<form
			className="contents"
			onSubmit={(event) => {
				event.preventDefault();
				if (confirmed) onConfirm();
			}}
		>
			<DialogHeader>
				<DialogTitle>
					{singleName ? (
						<>
							{"Delete '"}
							<span className="inline-block max-w-[300px] truncate align-bottom">
								{singleName}
							</span>
							{"'?"}
						</>
					) : (
						`Delete ${count} projects?`
					)}
				</DialogTitle>
			</DialogHeader>
			<DialogBody>
				<Alert variant="destructive">
					<AlertTitle>Warning</AlertTitle>
					<AlertDescription>
						This will permanently delete{" "}
						{singleName ? `"${singleName}"` : `${count} projects`} and all
						associated files.
					</AlertDescription>
				</Alert>
				<div className="flex flex-col gap-3">
					<Label
						htmlFor={inputId}
						className="text-xs font-semibold text-slate-500"
					>
						{`Type "${CONFIRMATION}" to confirm`}
					</Label>
					<Input
						id={inputId}
						type="text"
						placeholder={CONFIRMATION}
						size="lg"
						variant="destructive"
						autoComplete="off"
						spellCheck={false}
						value={typed}
						onChange={(event) => setTyped(event.target.value)}
					/>
				</div>
			</DialogBody>
			<DialogFooter>
				<Button type="button" variant="outline" onClick={onCancel}>
					Cancel
				</Button>
				<Button type="submit" variant="destructive" disabled={!confirmed}>
					Delete project
				</Button>
			</DialogFooter>
		</form>
	);
}
