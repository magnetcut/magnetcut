import { useState, useRef } from "react";
import { toast } from "sonner";
import { useEditor } from "@/editor/use-editor";
import {
	canReadDiskFiles,
	findDroppedDiskFiles,
	type MediaFile,
	pickDiskFiles,
} from "./disk-file";

interface UseFileUploadOptions {
	accept?: string;
	multiple?: boolean;
	onFilesSelected?: (files: MediaFile[]) => void;
}

export function useFileUpload({
	accept,
	multiple,
	onFilesSelected,
}: UseFileUploadOptions = {}) {
	const editor = useEditor();
	const [isDragOver, setIsDragOver] = useState(false);
	const dragCounterRef = useRef(0);
	const inputRef = useRef<HTMLInputElement>(null);

	function containsFiles(dataTransfer: DataTransfer): boolean {
		return (
			!editor.timeline.dragSource.isActive() &&
			dataTransfer.types.includes("Files")
		);
	}

	function openFilePicker() {
		// The desktop app's own dialog, which says where the files are: they
		// stay there.
		if (canReadDiskFiles()) {
			pickDiskFiles()
				.then((files) => {
					const picked = multiple ? files : files.slice(0, 1);
					if (picked.length > 0) onFilesSelected?.(picked);
				})
				.catch((error: unknown) => {
					console.error("Open dialog failed:", error);
					toast.error("Couldn't open the files");
				});
			return;
		}
		if (!inputRef.current) return;

		inputRef.current.accept = accept || "*";
		inputRef.current.multiple = multiple || false;
		inputRef.current.click();
	}

	function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
		const files = Array.from(event.target.files ?? []);
		if (files.length > 0 && onFilesSelected) {
			onFilesSelected(files);
		}

		if (event.target) {
			event.target.value = "";
		}
	}

	function handleDragEnter(e: React.DragEvent) {
		e.preventDefault();

		if (!containsFiles(e.dataTransfer)) return;

		dragCounterRef.current += 1;
		setIsDragOver(true);
	}

	function handleDragOver(e: React.DragEvent) {
		e.preventDefault();

		if (!containsFiles(e.dataTransfer)) return;
	}

	function handleDragLeave(e: React.DragEvent) {
		e.preventDefault();

		if (!containsFiles(e.dataTransfer)) return;

		dragCounterRef.current -= 1;
		if (dragCounterRef.current === 0) {
			setIsDragOver(false);
		}
	}

	function handleDrop(e: React.DragEvent) {
		e.preventDefault();
		setIsDragOver(false);
		dragCounterRef.current = 0;

		if (onFilesSelected && containsFiles(e.dataTransfer)) {
			const dropped = Array.from(e.dataTransfer.files);
			const files = (multiple ?? false) ? dropped : dropped.slice(0, 1);
			if (files.length === 0) return;
			void findDroppedDiskFiles({ files }).then(onFilesSelected);
		}
	}

	return {
		isDragOver,
		openFilePicker,
		fileInputProps: {
			ref: inputRef,
			type: "file",
			style: { display: "none" },
			onChange: handleFileChange,
		},
		dragProps: {
			onDragEnter: handleDragEnter,
			onDragOver: handleDragOver,
			onDragLeave: handleDragLeave,
			onDrop: handleDrop,
		},
	};
}
