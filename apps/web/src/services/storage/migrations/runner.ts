import {
	IndexedDBAdapter,
	deleteDatabase,
} from "@/services/storage/indexeddb-adapter";
import type { StorageMigration } from "./base";
import type { ProjectRecord } from "./transformers/types";
import { getProjectId, isRecord } from "./transformers/utils";

export interface StorageMigrationResult {
	migratedCount: number;
}

export interface MigrationProgress {
	isMigrating: boolean;
	fromVersion: number | null;
	toVersion: number | null;
	projectName: string | null;
}

let hasCleanedUpMetaDb = false;

const MIN_MIGRATION_DISPLAY_MS = 1000;

export async function runStorageMigrations({
	migrations,
	onProgress,
}: {
	migrations: StorageMigration[];
	onProgress?: (progress: MigrationProgress) => void;
}): Promise<StorageMigrationResult> {
	// One-time cleanup: delete the old global version database
	if (!hasCleanedUpMetaDb) {
		try {
			await deleteDatabase({ dbName: "video-editor-meta" });
		} catch {
			// Ignore errors - DB might not exist
		}
		hasCleanedUpMetaDb = true;
	}

	const projectsAdapter = new IndexedDBAdapter<ProjectRecord>({
		dbName: "video-editor-projects",
		storeName: "projects",
		version: 1,
	});

	const projects = await projectsAdapter.getAll();

	const orderedMigrations = [...migrations].sort((a, b) => a.from - b.from);
	let migratedCount = 0;
	let migrationStartTime: number | null = null;

	for (const project of projects) {
		if (typeof project !== "object" || project === null) {
			continue;
		}

		const projectRecord = project as ProjectRecord;
		const projectId = getProjectId({ project: projectRecord });
		if (!projectId) {
			continue;
		}

		const currentVersion = getProjectVersion({ project: projectRecord });
		const targetVersion = orderedMigrations.at(-1)?.to ?? currentVersion;

		if (currentVersion >= targetVersion) {
			continue;
		}

		// Track when we first showed the migration dialog
		if (migrationStartTime === null) {
			migrationStartTime = Date.now();
		}

		const projectName = getProjectName({ project: projectRecord });
		onProgress?.({
			isMigrating: true,
			fromVersion: currentVersion,
			toVersion: targetVersion,
			projectName,
		});

		// A migration that fails leaves that project where it got to: the
		// others are still migrated, and still open.
		try {
			await migrateProject({
				projectId,
				project: projectRecord,
				migrations: orderedMigrations,
				onStep: async ({ project: migrated }) => {
					await projectsAdapter.set({ key: projectId, value: migrated });
					migratedCount++;
				},
			});
		} catch (error) {
			console.error(`Failed to migrate project ${projectId}:`, error);
		}
	}

	// Ensure dialog is visible for minimum time so users can see it
	if (migrationStartTime !== null) {
		const elapsed = Date.now() - migrationStartTime;
		if (elapsed < MIN_MIGRATION_DISPLAY_MS) {
			await new Promise((resolve) =>
				setTimeout(resolve, MIN_MIGRATION_DISPLAY_MS - elapsed),
			);
		}
	}

	onProgress?.({
		isMigrating: false,
		fromVersion: null,
		toVersion: null,
		projectName: null,
	});

	return { migratedCount };
}

/**
 * `project` brought up to the latest version, a migration at a time, each
 * step passed to `onStep`: for what's stored, and for a project file.
 */
export async function migrateProject({
	projectId,
	project,
	migrations,
	onStep,
}: {
	projectId: string;
	project: ProjectRecord;
	migrations: StorageMigration[];
	onStep?: ({ project }: { project: ProjectRecord }) => Promise<void>;
}): Promise<ProjectRecord> {
	const orderedMigrations = [...migrations].sort((a, b) => a.from - b.from);
	let projectRecord = project;
	let currentVersion = getProjectVersion({ project });

	for (const migration of orderedMigrations) {
		if (migration.from !== currentVersion) {
			continue;
		}

		const result = await migration.run({
			projectId,
			project: projectRecord,
		});

		if (result.skipped) {
			break;
		}

		await onStep?.({ project: result.project });
		currentVersion = migration.to;
		projectRecord = result.project;
	}

	return projectRecord;
}

function getProjectVersion({ project }: { project: ProjectRecord }): number {
	const versionValue = project.version;

	// v2 and up - has explicit version field
	if (typeof versionValue === "number") {
		return versionValue;
	}

	// v1 - has scenes array
	const scenesValue = project.scenes;
	if (Array.isArray(scenesValue) && scenesValue.length > 0) {
		return 1;
	}

	// v0 - no scenes
	return 0;
}

function getProjectName({
	project,
}: {
	project: ProjectRecord;
}): string | null {
	const metadata = project.metadata;
	if (isRecord(metadata) && typeof metadata.name === "string") {
		return metadata.name;
	}

	// v0 had name directly on project
	if (typeof project.name === "string") {
		return project.name;
	}

	return null;
}
