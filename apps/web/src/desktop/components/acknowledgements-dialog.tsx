import { useEffect, useState } from "react";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";

/** The third-party notices (public/acknowledgements.txt, from scripts/licenses.ts). */
export function AcknowledgementsDialog({
	isOpen,
	onOpenChange,
}: {
	isOpen: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const text = useAcknowledgements({ isOpen });

	return (
		<Dialog open={isOpen} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-3xl">
				<DialogHeader>
					<DialogTitle>Acknowledgements</DialogTitle>
					<DialogDescription>
						The open-source software MagnetCut is built from, and its licences.
					</DialogDescription>
				</DialogHeader>
				<DialogBody>
					<pre className="bg-muted/50 h-[60vh] overflow-auto rounded-md border p-4 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
						{text ?? "Loading…"}
					</pre>
				</DialogBody>
			</DialogContent>
		</Dialog>
	);
}

// Fetched the first time it's opened: it's large, and rarely read.
function useAcknowledgements({ isOpen }: { isOpen: boolean }) {
	const [text, setText] = useState<string | null>(null);
	useEffect(() => {
		if (!isOpen || text !== null) return;
		let isCurrent = true;
		void fetch("/acknowledgements.txt")
			.then((response) =>
				response.ok
					? response.text()
					: `Couldn't load the acknowledgements (${response.status}).`,
			)
			.catch(() => "Couldn't load the acknowledgements.")
			.then((loaded) => {
				if (isCurrent) setText(loaded);
			});
		return () => {
			isCurrent = false;
		};
	}, [isOpen, text]);
	return text;
}
