import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LaneConfiguration } from "../src/durable.ts";
import { SqliteSessionRepo } from "../src/repo.ts";
import { attachRuntime } from "../src/runtime-port.ts";
import { StoredSession } from "../src/session.ts";
import { user } from "./fixtures.ts";

const configuration: LaneConfiguration = {
	model: { provider: "test", modelId: "model" },
	thinkingLevel: "off",
	activeToolNames: [],
};

describe("SQLite lane-owned next-run queue", () => {
	it("reopens an idle pending item and its cancellation", async () => {
		const directory = await mkdtemp(join(tmpdir(), "harness-next-run-"));
		try {
			const path = join(directory, "sessions.sqlite");
			const repo = new SqliteSessionRepo({ path });
			const session = await repo.create({});
			if (!(session instanceof StoredSession)) throw new Error("Expected StoredSession");
			await attachRuntime(session, configuration);
			const queued = await session.nextRun(user("durable"));
			await session.close();

			const freshRepo = new SqliteSessionRepo({ path });
			const reopened = await freshRepo.open(session.metadata);
			if (!(reopened instanceof StoredSession)) throw new Error("Expected StoredSession");
			const restored = await attachRuntime(reopened, configuration);
			expect(restored.pendingEntries.get(queued.entryId!)?.payload).toEqual(user("durable"));
			expect((await reopened.cancelQueued(queued.entryId!)).outcome).toBe("cancelled");
			await reopened.close();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("captures SQLite pending items before the caller and reopens the exact active branch with no pending register", async () => {
		const directory = await mkdtemp(join(tmpdir(), "harness-next-run-capture-"));
		try {
			const path = join(directory, "sessions.sqlite");
			const repo = new SqliteSessionRepo({ path });
			const session = await repo.create({});
			if (!(session instanceof StoredSession)) throw new Error("Expected StoredSession");
			const initial = await attachRuntime(session, configuration);
			const queued = await session.nextRun(user("queued"));
			const accepted = await session.acceptPrompt({
				messages: [user("caller")],
				expectedConfigurationSeq: initial.laneConfiguration.seq,
				expectedLaneStateSeq: initial.laneState.seq,
				expectedPendingNextRun: [],
				expectedLeafSeq: initial.mainLeaf.seq,
				expectedProvider: "test",
				expectedModelId: "model",
				identityAvailable: true,
			});
			if (accepted.status !== "committed") throw new Error("Prompt was not committed");
			const callerId = accepted.attachment.runOperation!.value.intent.promptEntryIds[0];
			expect(accepted.attachment.entries.get(queued.entryId!)?.parentId).toBeNull();
			expect(accepted.attachment.entries.get(callerId)?.parentId).toBe(queued.entryId);
			await session.close();

			const reopened = await new SqliteSessionRepo({ path }).open(session.metadata);
			if (!(reopened instanceof StoredSession)) throw new Error("Expected StoredSession");
			const restored = await attachRuntime(reopened, configuration);
			expect(restored.laneState.value.pendingNextRun).toEqual([]);
			expect(restored.pendingEntries.size).toBe(0);
			expect(restored.runState!.value.phase).toMatchObject({
				kind: "checkpoint",
				skipInboxOnce: true,
				triggerEntryId: callerId,
			});
			expect(await reopened.refreshRuntimeAttachment()).toBeDefined();
			await reopened.close();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
