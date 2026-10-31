import { invoke } from "@tauri-apps/api/core";
import type { EditorCore } from "@/core";
import { getAppInfo } from "@/desktop/app-info";
import { EXPORT_FORMAT_VALUES, type ExportFormat } from "@/export";
import { DEFAULT_EXPORT_CHOICES, getChosenOptions } from "@/export/choices";
import { findEncodableCodecs } from "@/export/encodable";
import { FRAME_RATE_PRESETS } from "@/export/settings";
import {
	applyWizardAnswers,
	DEFAULT_WIZARD_ANSWERS,
	DESTINATIONS,
	SOUND_CHOICES,
	type Destination,
	type SoundChoice,
} from "@/export/wizard";
import { frameRateToFloat } from "@/fps/utils";
import { DiskFile } from "@/media/disk-file";
import { processMediaAssets } from "@/media/processing";
import { getEditorUrl } from "@/project/editor-url";
import {
	PROJECT_FILE_EXTENSION,
	parseProjectFile,
	toProjectFile,
} from "@/project/file";
import { storageService } from "@/services/storage/service";
import { generateUUID } from "@/utils/id";
import { DEFAULT_NEW_ELEMENT_DURATION } from "@/timeline/creation";
import { buildElementFromMedia } from "@/timeline/element-utils";
import { mediaTime, mediaTimeFromSeconds, TICKS_PER_SECOND } from "@/wasm";
import { resolveId, shortIds } from "./ids";
import { look, MAX_SHEET } from "./look";
import { buildSummary, describe, type SummaryInput } from "./summary";
import { formatTime, parseTime } from "./time";

// What an agent can do in MagnetCut (docs/AUTOMATION.md), as MCP tools: each
// one's name, a short description (it's in every request an agent makes),
// the arguments it takes, and the work, done over the editor's managers.

export type ToolContent =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string };

export interface ToolResult {
	content: ToolContent[];
	isError?: boolean;
}

export interface ToolContext {
	editor: EditorCore;
	/** The call's number, which the app checks paths against. */
	call: number;
	agent: string;
	navigate: (url: string) => void;
	progress: (update: {
		progress: number;
		total?: number;
		message?: string;
	}) => void;
	isStopped: () => boolean;
}

export interface Tool {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	run: (call: {
		args: Record<string, unknown>;
		context: ToolContext;
	}) => Promise<ToolResult>;
}

/** A failure the agent reads and can act on. */
export class ToolError extends Error {}

const text = (value: string): ToolResult => ({
	content: [{ type: "text", text: value }],
});

function string({
	args,
	key,
}: {
	args: Record<string, unknown>;
	key: string;
}): string | undefined {
	const value = args[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function needProject({ editor }: { editor: EditorCore }) {
	const project = editor.project.getActiveOrNull();
	if (
		!project ||
		typeof location === "undefined" ||
		location.pathname !== "/editor"
	) {
		throw new ToolError(
			"No project is open: `project` with action open or new first",
		);
	}
	return project;
}

/** A short fingerprint of the timeline: it changes when anything on it does. */
export function revisionOf({ value }: { value: unknown }): string {
	const json = JSON.stringify(value, (key, item: unknown) =>
		key === "buffer" ? undefined : item,
	);
	let hash = 0x811c9dc5;
	for (let i = 0; i < json.length; i++) {
		hash ^= json.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0").slice(0, 6);
}

function summaryInput({ editor }: { editor: EditorCore }): SummaryInput {
	const project = needProject({ editor });
	const tracks = editor.scenes.getActiveScene().tracks;
	return {
		name: project.metadata.name,
		canvasSize: project.settings.canvasSize,
		fps: frameRateToFloat(project.settings.fps),
		duration: editor.timeline.getTotalDuration(),
		revision: revisionOf({ value: tracks }),
		assets: editor.media.getAssets(),
		tracks,
	};
}

/** Waits until the editor shows project `id`, loaded: its scenes, media and
 * fonts in. */
async function editorReady({
	editor,
	id,
}: {
	editor: EditorCore;
	id: string;
}): Promise<void> {
	for (let waited = 0; waited < 60_000; waited += 100) {
		if (
			location.pathname === "/editor" &&
			editor.project.getLoadedProjectId() === id &&
			editor.scenes.getActiveSceneOrNull() !== null
		) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new ToolError("The project didn't open in time");
}

const status: Tool = {
	name: "status",
	description: "What's open in MagnetCut, and the app's version and edition.",
	inputSchema: { type: "object", properties: {} },
	run: async ({ context: { editor } }) => {
		const info = await getAppInfo();
		const lines = [
			`MagnetCut ${info?.version ?? "?"}, ${info?.updates ? "website" : "App Store"} edition`,
		];
		const project = editor.project.getActiveOrNull();
		if (project && location.pathname === "/editor") {
			const short = shortIds({
				ids: editor.project.getSavedProjects().map((saved) => saved.id),
			});
			lines.push(
				`open: ${JSON.stringify(project.metadata.name)} (${short.get(project.metadata.id) ?? project.metadata.id}), rev ${revisionOf({ value: editor.scenes.getActiveScene().tracks })}`,
			);
		} else {
			lines.push("no project open");
		}
		const exporting = editor.project.getExportState();
		if (exporting.isExporting) {
			lines.push(`exporting, ${Math.round(exporting.progress * 100)}%`);
		}
		return text(lines.join("\n"));
	},
};

/** A .magnetcut file, made a project of its own (a new one, whatever its id
 * was), its media opened from where they are: its id, and the media that
 * couldn't be. */
async function openProjectFile({
	call,
	path,
}: {
	call: number;
	path: string;
}): Promise<{ id: string; missing: string[] }> {
	const contents = await invoke<string>("agent_read_project", {
		call,
		path,
	}).catch((error: unknown) => {
		throw new ToolError(String(error));
	});
	let opened: ReturnType<typeof parseProjectFile>;
	try {
		opened = parseProjectFile({ text: contents });
	} catch (error) {
		throw new ToolError(error instanceof Error ? error.message : String(error));
	}
	const id = generateUUID();
	const now = new Date();
	const project = {
		...opened.project,
		metadata: {
			...opened.project.metadata,
			id,
			thumbnail: undefined,
			createdAt: now,
			updatedAt: now,
		},
	};
	const missing: string[] = [];
	for (const medium of opened.media) {
		try {
			const info = await invoke<ConstructorParameters<typeof DiskFile>[0]>(
				"agent_open_media",
				{ call, path: medium.path },
			);
			const [asset] = await processMediaAssets({ files: [new DiskFile(info)] });
			if (!asset) throw new Error("not read");
			// Under its id in the file, which the clips name.
			await storageService.saveMediaAsset({
				projectId: id,
				mediaAsset: { ...asset, id: medium.id },
			});
		} catch (error) {
			missing.push(`missing ${medium.name} (${medium.path}): ${String(error)}`);
		}
	}
	await storageService.saveProject({ project });
	return { id, missing };
}

const project: Tool = {
	name: "project",
	description:
		"Projects: list them, open one (by id, or a .magnetcut file by its whole path), make a new one, or save the open one as a .magnetcut file. Opening answers with the summary.",
	inputSchema: {
		type: "object",
		properties: {
			action: { type: "string", enum: ["list", "open", "new", "save"] },
			id: { type: "string", description: "For open: its id from list" },
			path: {
				type: "string",
				description: "For open or save: a .magnetcut file's whole path",
			},
			replace: { type: "boolean", description: "For save: write over a file" },
			name: { type: "string", description: "For new" },
		},
		required: ["action"],
	},
	run: async ({ args, context: { editor, navigate, call } }) => {
		await editor.project.loadAllProjects();
		const saved = editor.project.getSavedProjects();
		const short = shortIds({ ids: saved.map((one) => one.id) });
		switch (args.action) {
			case "list":
				return text(
					saved.length === 0
						? "no projects"
						: saved
								.map(
									(one) =>
										`${short.get(one.id)} ${JSON.stringify(one.name)} ${formatTime({ ticks: one.duration })} changed ${new Date(one.updatedAt).toISOString().slice(0, 16).replace("T", " ")}`,
								)
								.join("\n"),
				);
			case "new": {
				const id = await editor.project.createNewProject({
					name: string({ args, key: "name" }) ?? "New project",
				});
				navigate(getEditorUrl({ projectId: id }));
				await editorReady({ editor, id });
				return text(buildSummary(summaryInput({ editor })));
			}
			case "save": {
				const current = needProject({ editor });
				const path = string({ args, key: "path" });
				if (!path?.endsWith(`.${PROJECT_FILE_EXTENSION}`)) {
					throw new ToolError(
						`save needs a path ending .${PROJECT_FILE_EXTENSION}`,
					);
				}
				await editor.project.saveCurrentProject();
				const { text: file, leftOut } = toProjectFile({
					project: current,
					assets: editor.media.getAssets(),
				});
				await invoke("agent_write_project", {
					call,
					path,
					text: file,
					replace: args.replace === true,
				}).catch((error: unknown) => {
					throw new ToolError(String(error));
				});
				return text(
					[
						`saved ${path}`,
						...leftOut.map(
							(name) =>
								`left out ${name}: not a file on disk, so it can't be named`,
						),
					].join("\n"),
				);
			}
			case "open": {
				const path = string({ args, key: "path" });
				if (path) {
					const opened = await openProjectFile({ call, path });
					navigate(getEditorUrl({ projectId: opened.id }));
					await editorReady({ editor, id: opened.id });
					return text(
						[buildSummary(summaryInput({ editor })), ...opened.missing].join(
							"\n",
						),
					);
				}
				const wanted = string({ args, key: "id" });
				const id = wanted
					? resolveId({ short: wanted, ids: saved.map((one) => one.id) })
					: null;
				if (!id) throw new ToolError(`No project ${wanted ?? ""}: see list`);
				navigate(getEditorUrl({ projectId: id }));
				await editorReady({ editor, id });
				return text(buildSummary(summaryInput({ editor })));
			}
			default:
				throw new ToolError("action is list, open, new or save");
		}
	},
};

const media: Tool = {
	name: "media",
	description:
		"The open project's media: list it, or import files by their whole paths (films, pictures, sounds), kept where they are.",
	inputSchema: {
		type: "object",
		properties: {
			action: { type: "string", enum: ["list", "import"] },
			paths: { type: "array", items: { type: "string" } },
			add: {
				type: "boolean",
				description:
					"Also put them on the timeline, one after another at its end",
			},
		},
		required: ["action"],
	},
	run: async ({ args, context: { editor, call, progress } }) => {
		const current = needProject({ editor });
		if (args.action === "import") {
			const paths = Array.isArray(args.paths)
				? args.paths.filter((path): path is string => typeof path === "string")
				: [];
			if (paths.length === 0) throw new ToolError("import needs paths");
			const failures: string[] = [];
			const files: DiskFile[] = [];
			for (const path of paths) {
				try {
					const info = await invoke<ConstructorParameters<typeof DiskFile>[0]>(
						"agent_open_media",
						{ call, path },
					);
					files.push(new DiskFile(info));
				} catch (error) {
					failures.push(String(error));
				}
			}
			const before = new Set(editor.media.getAssets().map((asset) => asset.id));
			const assets = await processMediaAssets({
				files,
				onProgress: ({ progress: done }) =>
					progress({ progress: done, total: 100 }),
			});
			for (const asset of assets) {
				await editor.media.addMediaAsset({
					projectId: current.metadata.id,
					asset,
				});
			}
			const all = editor.media.getAssets();
			const added = all.filter((asset) => !before.has(asset.id));
			// On the timeline too, if asked: one after another at its end, as
			// each asset's + button puts it.
			if (args.add === true) {
				for (const asset of added) {
					editor.timeline.insertElement({
						element: buildElementFromMedia({
							mediaId: asset.id,
							mediaType: asset.type,
							name: asset.name,
							duration:
								asset.duration != null
									? mediaTimeFromSeconds({ seconds: asset.duration })
									: DEFAULT_NEW_ELEMENT_DURATION,
							startTime: mediaTime({
								ticks: editor.timeline.getTotalDuration(),
							}),
						}),
						placement: { mode: "auto" },
					});
				}
			}
			const short = shortIds({ ids: all.map((asset) => asset.id) });
			return text(
				[
					...added.map(
						(asset) =>
							`+ ${short.get(asset.id)} ${asset.name}${asset.duration ? ` ${formatTime({ ticks: asset.duration * TICKS_PER_SECOND })}` : ""}`,
					),
					...failures.map((failure) => `! ${failure}`),
				].join("\n") || "nothing imported",
			);
		}
		if (args.action === "list") {
			const summary = buildSummary(summaryInput({ editor }));
			return text(summary.split("\n")[1] ?? "media none");
		}
		throw new ToolError("action is list or import");
	},
};

const summary: Tool = {
	name: "summary",
	description:
		"The open project in a few lines: media, and each track's clips with short ids and times (m:ss.s). Read this first.",
	inputSchema: { type: "object", properties: {} },
	run: async ({ context: { editor } }) =>
		text(buildSummary(summaryInput({ editor }))),
};

const describeTool: Tool = {
	name: "describe",
	description:
		"Everything about one thing in the summary: a clip or a medium by its short id, or a track by name (V1, T1, A1…; a subtitle track's lines).",
	inputSchema: {
		type: "object",
		properties: { id: { type: "string" } },
		required: ["id"],
	},
	run: async ({ args, context: { editor } }) => {
		const id = string({ args, key: "id" });
		const found = id ? describe({ id, input: summaryInput({ editor }) }) : null;
		if (!found) throw new ToolError(`Nothing is ${id ?? ""}: see summary`);
		return text(found);
	},
};

const lookTool: Tool = {
	name: "look",
	description: `See the picture: one frame at a time, or a sheet of up to ${MAX_SHEET} small frames with their times, at the times given or spread over a range (the whole timeline by default).`,
	inputSchema: {
		type: "object",
		properties: {
			at: {
				description: "A time, or times (seconds, m:ss.s or f<frame>)",
				oneOf: [{ type: ["string", "number"] }, { type: "array" }],
			},
			from: { type: ["string", "number"] },
			to: { type: ["string", "number"] },
			count: {
				type: "number",
				description: `Frames on the sheet, up to ${MAX_SHEET}`,
			},
			width: { type: "number", description: "Pixels across: 640 by default" },
		},
	},
	run: async ({ args, context: { editor } }) => {
		const current = needProject({ editor });
		const fps = frameRateToFloat(current.settings.fps);
		const end = editor.timeline.getTotalDuration();
		const time = ({ value, fallback }: { value: unknown; fallback: number }) =>
			value === undefined ? fallback : parseTime({ value, fps });
		let times: number[];
		if (args.at !== undefined) {
			const asked = Array.isArray(args.at) ? args.at : [args.at];
			times = asked
				.map((value) => time({ value, fallback: 0 }))
				.filter((t): t is number => t !== null);
			if (times.length !== asked.length)
				throw new ToolError("a time in at isn't one");
		} else {
			const from = time({ value: args.from, fallback: 0 });
			const to = time({ value: args.to, fallback: end });
			if (from === null || to === null || to < from) {
				throw new ToolError("from and to are times, from before to");
			}
			const count = Math.min(
				MAX_SHEET,
				Math.max(1, Math.round(Number(args.count ?? 12))),
			);
			// The middle of each stretch, so the first and last aren't on a cut.
			times = Array.from({ length: count }, (_, i) =>
				Math.round(from + ((i + 0.5) * (to - from)) / count),
			);
		}
		times = times
			.slice(0, MAX_SHEET)
			.map((t) => Math.min(t, Math.max(0, end - 1)));
		const width = Math.min(
			1920,
			Math.max(160, Math.round(Number(args.width ?? 640))),
		);
		const picture = await look({ editor, times, width });
		return {
			content: [
				{ type: "image", ...picture },
				{
					type: "text",
					text: `at ${times.map((t) => formatTime({ ticks: t })).join(", ")}`,
				},
			],
		};
	},
};

function formatOf({
	path,
	asked,
}: {
	path: string;
	asked?: string;
}): ExportFormat {
	const extension = (asked ?? path.split(".").pop() ?? "").toLowerCase();
	const format = EXPORT_FORMAT_VALUES.find((value) => value === extension);
	if (!format) {
		throw new ToolError(
			`The file's extension says the format: ${EXPORT_FORMAT_VALUES.join(", ")}`,
		);
	}
	return format;
}

const exportTool: Tool = {
	name: "export",
	description:
		"Export the open project to a file (its extension says the format). Say where it's going and the app picks the settings, as its Simple mode does.",
	inputSchema: {
		type: "object",
		properties: {
			path: { type: "string", description: "The whole path to write" },
			replace: {
				type: "boolean",
				description: "Write over a file that's there",
			},
			destination: {
				type: "string",
				enum: [...DESTINATIONS],
				description:
					"anything: plays everywhere; upload: for sites; small: the smallest; master: to keep or edit",
			},
			maxMegabytes: { type: "number" },
			shortSide: {
				type: "number",
				description: "e.g. 1080 or 720; the project's by default",
			},
			fps: {
				type: "string",
				enum: FRAME_RATE_PRESETS.map((preset) => preset.label),
			},
			sound: { type: "string", enum: [...SOUND_CHOICES] },
		},
		required: ["path"],
	},
	run: async ({ args, context: { editor, call, progress, isStopped } }) => {
		const current = needProject({ editor });
		const path = string({ args, key: "path" });
		if (!path) throw new ToolError("export needs a path");
		const format = formatOf({ path });
		await invoke("agent_export_to", {
			call,
			path,
			replace: args.replace === true,
		}).catch((error: unknown) => {
			throw new ToolError(String(error));
		});
		const destination = DESTINATIONS.find(
			(value) => value === args.destination,
		);
		const sound = SOUND_CHOICES.find((value) => value === args.sound);
		const { canvasSize } = current.settings;
		const choices = applyWizardAnswers({
			answers: {
				...DEFAULT_WIZARD_ANSWERS,
				destination: (destination ??
					DEFAULT_WIZARD_ANSWERS.destination) as Destination,
				maxMegabytes:
					typeof args.maxMegabytes === "number" ? args.maxMegabytes : null,
				shortSide: typeof args.shortSide === "number" ? args.shortSide : null,
				fpsLabel: typeof args.fps === "string" ? args.fps : null,
				sound: (sound ?? DEFAULT_WIZARD_ANSWERS.sound) as SoundChoice,
			},
			choices: { ...DEFAULT_EXPORT_CHOICES, format },
			encodable: await findEncodableCodecs({ ...canvasSize, format }),
			projectShortSide: Math.min(canvasSize.width, canvasSize.height),
			projectFps: frameRateToFloat(current.settings.fps),
		});
		const options = { ...getChosenOptions({ choices }), path };
		const stopWatching = editor.project.subscribe(() => {
			const state = editor.project.getExportState();
			if (state.isExporting) {
				progress({ progress: Math.round(state.progress * 100), total: 100 });
			}
			if (isStopped()) editor.project.cancelExport();
		});
		try {
			const result = await editor.project.export({ options });
			if (result.cancelled) throw new ToolError("The export was stopped");
			if (!result.success) {
				throw new ToolError(
					`The export failed: ${result.error ?? "no reason given"}`,
				);
			}
			return text(
				`exported ${result.path ?? path}: ${format}, ${choices.videoCodec}, ${formatTime({ ticks: editor.timeline.getTotalDuration() })}`,
			);
		} finally {
			stopWatching();
			editor.project.clearExportState();
		}
	},
};

export const TOOLS: Tool[] = [
	status,
	project,
	media,
	summary,
	describeTool,
	lookTool,
	exportTool,
];
