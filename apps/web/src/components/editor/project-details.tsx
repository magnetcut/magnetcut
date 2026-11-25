import {
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
	type ReactNode,
} from "react";
import { MapPin, Tags, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { useEditor } from "@/editor/use-editor";
import type { MediaAsset } from "@/media/types";
import {
	fillFromClips,
	getSuggestionKey,
	readClipTags,
	suggestFileTags,
	type TagSuggestion,
	type TagSuggestions,
} from "@/project/clip-tags";
import {
	MAX_FILE_TAG_LENGTH,
	PLACE_WARNING,
	formatCamera,
	formatPlace,
	normalizeFileTags,
	type FileTags,
} from "@/project/file-tags";

// The project's details, beside its name: written into every file it's
// exported to (`@/project/file-tags`). Each field offers what the media
// library's clips say of themselves, and takes the user's own.

const DAY_FORMAT = new Intl.DateTimeFormat(undefined, {
	day: "numeric",
	month: "short",
	year: "numeric",
});

function formatDay({ day }: { day: string }): string {
	const date = new Date(`${day}T12:00:00`);
	return Number.isNaN(date.getTime()) ? day : DAY_FORMAT.format(date);
}

function isSame({ a, b }: { a: FileTags; b: FileTags }): boolean {
	return (
		JSON.stringify(normalizeFileTags({ raw: a })) ===
		JSON.stringify(normalizeFileTags({ raw: b }))
	);
}

export function ProjectDetailsButton() {
	const project = useEditor((e) => e.project.getActiveOrNull());
	const [open, setOpen] = useState(false);
	if (!project) return null;
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button
					variant="ghost"
					size="sm"
					className="text-muted-foreground hover:text-foreground h-8 gap-1.5"
				>
					<Tags className="size-4" aria-hidden />
					Details
				</Button>
			</PopoverTrigger>
			{/* Another project opened meanwhile has a panel of its own. */}
			{open && (
				<ProjectDetailsPanel
					key={project.metadata.id}
					projectId={project.metadata.id}
					saved={project.metadata.tags ?? {}}
					onDone={() => setOpen(false)}
				/>
			)}
		</Popover>
	);
}

/**
 * The details being written, saved into project `projectId` as a field is
 * left, at once for a suggestion picked, and as the panel closes: only while
 * it's the project open, never into another opened meanwhile.
 */
function useDetailsDraft({
	projectId,
	saved,
}: {
	projectId: string;
	saved: FileTags;
}) {
	const editor = useEditor();
	const [draft, setDraft] = useState<FileTags>(saved);
	const draftRef = useRef(saved);
	const save = () => {
		const project = editor.project.getActiveOrNull();
		if (project?.metadata.id !== projectId) return;
		if (isSame({ a: draftRef.current, b: project.metadata.tags ?? {} })) return;
		editor.project.setFileTags({ projectId, tags: draftRef.current });
	};
	useEffect(
		() => save,
		// eslint-disable-next-line react-hooks/exhaustive-deps -- on closing
		[],
	);
	const change = ({
		patch,
		now = false,
	}: {
		patch: Partial<FileTags>;
		now?: boolean;
	}) => {
		const next = { ...draftRef.current, ...patch };
		draftRef.current = next;
		setDraft(next);
		if (now) save();
	};
	return { draft, change, save };
}

/** What the media library's clips say of themselves, read again as clips
 * come and go. */
function useClipSuggestions({
	assets,
}: {
	assets: MediaAsset[];
}): TagSuggestions {
	const [suggestions, setSuggestions] = useState<TagSuggestions>({});
	const assetKey = assets.map((asset) => asset.id).join(",");
	useEffect(() => {
		let isLive = true;
		Promise.all(
			assets.map(async (asset) => ({
				name: asset.name,
				tags: await readClipTags({ asset }),
			})),
		)
			.then((clips) => {
				if (isLive) setSuggestions(suggestFileTags({ clips }));
			})
			.catch((error: unknown) =>
				console.error("Couldn't read the clips' details:", error),
			);
		return () => {
			isLive = false;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps -- by the clips' ids
	}, [assetKey]);
	return suggestions;
}

function ProjectDetailsPanel({
	projectId,
	saved,
	onDone,
}: {
	projectId: string;
	saved: FileTags;
	onDone: () => void;
}) {
	const name = useEditor((e) => e.project.getActiveOrNull()?.metadata.name);
	const assets = useEditor((e) => e.media.getAssets());
	const { draft, change, save } = useDetailsDraft({ projectId, saved });
	const suggestions = useClipSuggestions({ assets });

	const titles = useMemo<TagSuggestion[]>(
		() => [
			...(name ? [{ value: name, clip: "" }] : []),
			...(suggestions.title ?? []).filter(({ value }) => value !== name),
		],
		[name, suggestions.title],
	);
	const filled = fillFromClips({ tags: draft, suggestions });
	const canFill = !isSame({ a: filled, b: draft });

	const textDetail = (key: "title" | "artist" | "genre" | "comment") => ({
		value: draft[key] ?? "",
		onChange: ({ value }: { value: string }) =>
			change({ patch: { [key]: value } }),
		onPick: ({ value }: { value: string }) =>
			change({ patch: { [key]: value }, now: true }),
		onBlur: save,
	});

	return (
		<PopoverContent
			align="start"
			className="bg-background flex max-h-(--radix-popover-content-available-height) w-[400px] flex-col overflow-y-auto p-0"
			// The panel itself, not its first field, whose text would be
			// selected as it opens.
			onOpenAutoFocus={(event) => {
				event.preventDefault();
				if (event.currentTarget instanceof HTMLElement) {
					event.currentTarget.focus();
				}
			}}
		>
			<div className="border-b px-4 py-3">
				<h3 className="text-sm font-medium">Details</h3>
				<p className="text-muted-foreground text-xs">
					Written into every file this project is exported to.
				</p>
			</div>

			<div className="flex flex-col gap-3.5 px-4 py-4">
				<TextDetail
					label="Title"
					{...textDetail("title")}
					suggestions={titles}
					hint={({ clip }) => (clip ? `From ${clip}` : "The project's name")}
				/>
				<TextDetail
					label="Made by"
					{...textDetail("artist")}
					suggestions={suggestions.artist}
				/>
				<Field label="Date">
					{(id) => (
						<>
							<Input
								id={id}
								type="date"
								className="w-44"
								value={draft.date ?? ""}
								onChange={(event) =>
									change({ patch: { date: event.target.value } })
								}
								onBlur={save}
							/>
							<Chips
								items={suggestions.date}
								current={draft.date}
								label={({ value }) => formatDay({ day: value })}
								hint={({ clip }) => `Filmed then: ${clip}`}
								onPick={({ value }) =>
									change({ patch: { date: value }, now: true })
								}
							/>
						</>
					)}
				</Field>
				<TextDetail
					label="Genre"
					{...textDetail("genre")}
					suggestions={suggestions.genre}
				/>
				<TextDetail
					label="Description"
					isMultiline
					value={draft.description ?? ""}
					onChange={({ value }) => change({ patch: { description: value } })}
					onPick={({ value }) =>
						change({ patch: { description: value }, now: true })
					}
					onBlur={save}
					suggestions={suggestions.description}
				/>
				<TextDetail
					label="Comment"
					{...textDetail("comment")}
					suggestions={suggestions.comment}
				/>
				<Field label="Camera">
					{(id) => (
						<>
							<Input
								id={id}
								placeholder="None"
								maxLength={MAX_FILE_TAG_LENGTH}
								value={formatCamera(draft)}
								onChange={(event) =>
									change({
										patch: {
											make: undefined,
											model: event.target.value,
										},
									})
								}
								onBlur={save}
							/>
							<Chips
								items={suggestions.model}
								label={(item) => formatCamera({ ...item, model: item.value })}
								matches={(item) =>
									formatCamera({ ...item, model: item.value }) ===
									formatCamera(draft)
								}
								onPick={(item) =>
									change({
										patch: { make: item.make, model: item.value || undefined },
										now: true,
									})
								}
							/>
						</>
					)}
				</Field>
				<Field label="Place">
					{draft.location ? (
						<>
							<div className="flex h-9 items-center gap-2 text-sm">
								<MapPin
									className="text-muted-foreground size-4 shrink-0"
									aria-hidden
								/>
								<span className="min-w-0 flex-1 truncate tabular-nums">
									{formatPlace({ location: draft.location })}
								</span>
								<Button
									variant="ghost"
									size="icon"
									aria-label="Leave the place out"
									onClick={() =>
										change({ patch: { location: undefined }, now: true })
									}
								>
									<X className="size-4" />
								</Button>
							</div>
							<p className="text-xs text-amber-700 dark:text-amber-300">
								{PLACE_WARNING}
							</p>
						</>
					) : (
						<>
							<p className="text-muted-foreground flex h-9 items-center text-sm">
								Not written
							</p>
							<Chips
								items={suggestions.location}
								label={({ value }) => formatPlace({ location: value })}
								onPick={({ value }) =>
									change({ patch: { location: value }, now: true })
								}
							/>
						</>
					)}
				</Field>
			</div>

			<div className="bg-muted/30 flex items-center justify-between gap-2 border-t px-4 py-3">
				<Button
					variant="outline"
					size="sm"
					disabled={!canFill}
					onClick={() => change({ patch: filled, now: true })}
				>
					Fill in from the clips
				</Button>
				<Button size="sm" onClick={onDone}>
					Done
				</Button>
			</div>
		</PopoverContent>
	);
}

/** A detail written as text, and what the clips offer for it. */
function TextDetail({
	label,
	value,
	isMultiline = false,
	suggestions,
	hint,
	onChange,
	onPick,
	onBlur,
}: {
	label: string;
	value: string;
	/** The description's: a few lines. */
	isMultiline?: boolean;
	suggestions?: TagSuggestion[];
	hint?: (item: TagSuggestion) => string;
	onChange: ({ value }: { value: string }) => void;
	onPick: ({ value }: { value: string }) => void;
	onBlur: () => void;
}) {
	return (
		<Field label={label}>
			{(id) => (
				<>
					{isMultiline ? (
						<Textarea
							id={id}
							rows={3}
							placeholder="None"
							maxLength={MAX_FILE_TAG_LENGTH}
							// As the inputs beside it.
							className="border-border bg-input dark:bg-input focus-visible:border-primary/50 focus-visible:ring-primary/20 focus-visible:ring-2"
							value={value}
							onChange={(event) => onChange({ value: event.target.value })}
							onBlur={onBlur}
						/>
					) : (
						<Input
							id={id}
							placeholder="None"
							maxLength={MAX_FILE_TAG_LENGTH}
							value={value}
							onChange={(event) => onChange({ value: event.target.value })}
							onBlur={onBlur}
						/>
					)}
					<Chips
						items={suggestions}
						current={value}
						hint={hint}
						onPick={onPick}
					/>
				</>
			)}
		</Field>
	);
}

/**
 * A detail: its name, then its field and what the clips offer for it. The
 * name labels the field `children` makes with the id it's given; or, for
 * what isn't a field (the place), the group.
 */
function Field({
	label,
	children,
}: {
	label: string;
	children: ReactNode | ((id: string) => ReactNode);
}) {
	const id = useId();
	const labelId = `${id}-label`;
	const hasField = typeof children === "function";
	return (
		<div
			role={hasField ? undefined : "group"}
			aria-labelledby={hasField ? undefined : labelId}
			className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-start gap-x-3"
		>
			<Label
				id={labelId}
				htmlFor={hasField ? id : undefined}
				className="text-muted-foreground flex h-9 items-center font-normal"
			>
				{label}
			</Label>
			<div className="flex min-w-0 flex-col gap-1.5">
				{hasField ? children(id) : children}
			</div>
		</div>
	);
}

/** The clips' values for a detail, each a click away: none that's the
 * detail's already. */
function Chips({
	items = [],
	current,
	label = ({ value }) => value,
	hint = ({ clip }) => `From ${clip}`,
	matches = ({ value }) => value === current,
	onPick,
}: {
	items?: TagSuggestion[];
	current?: string;
	label?: (item: TagSuggestion) => string;
	hint?: (item: TagSuggestion) => string;
	/** Whether it's the detail's already. */
	matches?: (item: TagSuggestion) => boolean;
	onPick: (item: TagSuggestion) => void;
}) {
	const shown = items.filter((item) => !matches(item) && label(item));
	if (shown.length === 0) return null;
	return (
		<div className="flex flex-wrap gap-1">
			{shown.map((item) => (
				<button
					key={getSuggestionKey({ suggestion: item })}
					type="button"
					title={hint(item)}
					onClick={() => onPick(item)}
					className="bg-muted text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-ring max-w-full truncate rounded-full px-2 py-0.5 text-xs transition-colors focus-visible:ring-1 focus-visible:outline-hidden"
				>
					{label(item)}
				</button>
			))}
		</div>
	);
}
