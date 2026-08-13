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

describe("SQLite operation-owned queues", () => {
	it("reopens admission, one-at-a-time consumption, abort retention, and terminal cleanup without losing next-run", async () => {
		const directory = await mkdtemp(join(tmpdir(), "harness-operation-queues-"));
		try {
			const path = join(directory, "sessions.sqlite");
			const created = await new SqliteSessionRepo({ path }).create({});
			if (!(created instanceof StoredSession)) throw new Error("Expected StoredSession");
			const initial = await attachRuntime(created, configuration);
			const accepted = await created.acceptPrompt({
				messages: [user("prompt")],
				steeringMode: "one-at-a-time",
				followUpMode: "one-at-a-time",
				expectedConfigurationSeq: initial.laneConfiguration.seq,
				expectedLaneStateSeq: initial.laneState.seq,
				expectedPendingNextRun: [],
				expectedLeafSeq: initial.mainLeaf.seq,
				expectedProvider: "test",
				expectedModelId: "model",
				identityAvailable: true,
			});
			if (accepted.status !== "committed") throw new Error("Prompt was not committed");
			const operationId = accepted.attachment.runOperation!.value.operationId;
			const first = await created.queueOperationInput("steer", user("first"));
			const second = await created.queueOperationInput("steer", user("second"));
			const follow = await created.queueOperationInput("followUp", user("follow"));
			const next = await created.nextRun(user("next"));
			await created.close();

			const consuming = await new SqliteSessionRepo({ path }).open(created.metadata);
			if (!(consuming instanceof StoredSession)) throw new Error("Expected StoredSession");
			const restored = await attachRuntime(consuming, configuration);
			expect(restored.runState!.value.inbox).toMatchObject({
				steer: [first.entryId, second.entryId],
				followUp: [follow.entryId],
			});
			const consumed = await consuming.consumeOperationQueue({
				operationId,
				kind: "steer",
				entryIds: [first.entryId!],
				expectedOperationStateSeq: restored.runState!.seq,
			});
			expect(consumed.committed).toBe(true);
			expect(consumed.attachment.mainLeaf.value).toBe(first.entryId);
			expect(consumed.attachment.runState!.value.inbox.steer).toEqual([second.entryId]);
			const aborted = await consuming.requestAbort(() => undefined);
			expect(aborted).toMatchObject({
				status: "committed",
				drainedSteer: [user("second")],
				drainedFollowUp: [user("follow")],
			});
			await consuming.close();

			const finishing = await new SqliteSessionRepo({ path }).open(created.metadata);
			if (!(finishing instanceof StoredSession)) throw new Error("Expected StoredSession");
			const beforeFinish = await attachRuntime(finishing, configuration);
			expect(beforeFinish.pendingEntries.has(second.entryId!)).toBe(true);
			expect(beforeFinish.pendingEntries.has(follow.entryId!)).toBe(true);
			expect(beforeFinish.pendingEntries.has(next.entryId!)).toBe(true);
			expect(
				await finishing.finishRun({
					operationId,
					expectedOperationStateSeq: beforeFinish.runState!.seq,
				}),
			).toMatchObject({ status: "committed" });
			await finishing.close();

			const terminal = await new SqliteSessionRepo({ path }).open(created.metadata);
			if (!(terminal instanceof StoredSession)) throw new Error("Expected StoredSession");
			const final = await attachRuntime(terminal, configuration);
			expect(final.laneState.value).toEqual({ currentOperationId: null, pendingNextRun: [next.entryId] });
			expect(final.pendingEntries.has(next.entryId!)).toBe(true);
			expect(final.pendingEntries.has(second.entryId!)).toBe(false);
			expect(final.pendingEntries.has(follow.entryId!)).toBe(false);
			expect(final.mainLeaf.value).toBe(first.entryId);
			await terminal.close();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
