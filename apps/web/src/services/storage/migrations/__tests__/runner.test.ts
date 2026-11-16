import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { IndexedDBAdapter } from "@/services/storage/indexeddb-adapter";
import { StorageMigration, type StorageMigrationRunArgs } from "../base";
import { migrateProject, runStorageMigrations } from "../runner";
import type { MigrationResult, ProjectRecord } from "../transformers/types";

/** A migration up one version that marks what it did, and fails for one
 * project if told to. */
class StepMigration extends StorageMigration {
	from: number;
	to: number;
	private failsFor: string | null;

	constructor({
		from,
		failsFor = null,
	}: {
		from: number;
		failsFor?: string | null;
	}) {
		super();
		this.from = from;
		this.to = from + 1;
		this.failsFor = failsFor;
	}

	async run({
		projectId,
		project,
	}: StorageMigrationRunArgs): Promise<MigrationResult<ProjectRecord>> {
		if (projectId === this.failsFor) throw new Error("broken");
		return {
			project: { ...project, version: this.to, [`v${this.to}`]: true },
			skipped: false,
		};
	}
}

describe("a project brought up to date", () => {
	test("goes a version at a time, each step passed on", async () => {
		const steps: unknown[] = [];

		const migrated = await migrateProject({
			projectId: "a",
			project: { id: "a", version: 30 },
			migrations: [
				new StepMigration({ from: 31 }),
				new StepMigration({ from: 30 }),
			],
			onStep: async ({ project }) => {
				steps.push(project.version);
			},
		});

		expect(migrated).toEqual({ id: "a", version: 32, v31: true, v32: true });
		expect(steps).toEqual([31, 32]);
	});
});

describe("the storage migrations", () => {
	const stored = new Map<string, unknown>();
	const spies = [
		spyOn(IndexedDBAdapter.prototype, "getAll").mockImplementation(async () => [
			{ id: "a", version: 30 },
			{ id: "b", version: 30 },
		]),
		spyOn(IndexedDBAdapter.prototype, "set").mockImplementation(
			async ({ key, value }) => {
				stored.set(key, value);
			},
		),
		spyOn(console, "error").mockImplementation(() => {}),
	];
	afterAll(() => {
		for (const spy of spies) spy.mockRestore();
	});

	test("a migration that fails for one project leaves the others migrated", async () => {
		const result = await runStorageMigrations({
			migrations: [new StepMigration({ from: 30, failsFor: "a" })],
		});

		expect(result.migratedCount).toBe(1);
		expect([...stored.keys()]).toEqual(["b"]);
		expect(stored.get("b")).toEqual({ id: "b", version: 31, v31: true });
	});
});
