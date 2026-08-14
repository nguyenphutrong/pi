import {
	createFollowerId,
	createIdGenerator,
	type JsonValue,
	MemoryStorage,
	MemoryStorageState,
	type Storage,
	uuidV7Timestamp,
	type Write,
} from "@nguyenphutrong/pi-session-storage";
import { instrumentStorage } from "@nguyenphutrong/pi-session-storage/testing";
import { describe, expect, it, vi } from "vitest";
import { type LaneConfiguration, type RunState, selectQueueDrain } from "../src/durable.ts";
import { planAction } from "../src/planner.ts";
import { attachRuntime, claimRuntime, closeAttachedRuntime, placeRuntimeWrites } from "../src/runtime-port.ts";
import { StoredSession } from "../src/session.ts";
import { CURRENT_STORAGE_VERSION } from "../src/types.ts";
import { assistant, id, toolResult, user, ZERO_USAGE } from "./fixtures.ts";

const configuration: LaneConfiguration = {
	model: { provider: "test", modelId: "model" },
	thinkingLevel: "off",
	activeToolNames: [],
};

function jsonValue(value: unknown): JsonValue {
	return value as JsonValue;
}

function session(storage: Storage): StoredSession {
	return new StoredSession(
		{ id: id(), createdAt: 1, storageVersion: CURRENT_STORAGE_VERSION },
		storage,
		() => undefined,
	);
}

async function active(storage: Storage = new MemoryStorage()) {
	await storage.commit({
		writes: [
			{ kind: "register", op: "set", namespace: "lane.leaf", key: "main", value: null },
			{
				kind: "register",
				op: "set",
				namespace: "lane.state",
				key: "main",
				value: { currentOperationId: null, pendingNextRun: [] },
			},
		],
	});
	const runtimeSession = session(storage);
	const initial = await attachRuntime(runtimeSession, configuration);
	const accepted = await runtimeSession.acceptPrompt({
		messages: [user("prompt")],
		steeringMode: "all",
		followUpMode: "all",
		expectedConfigurationSeq: initial.laneConfiguration.seq,
		expectedLaneStateSeq: initial.laneState.seq,
		expectedPendingNextRun: [],
		expectedLeafSeq: initial.mainLeaf.seq,
		expectedProvider: "test",
		expectedModelId: "model",
		identityAvailable: true,
	});
	if (accepted.status !== "committed") throw new Error("prompt acceptance failed");
	return { runtimeSession, attachment: accepted.attachment, storage };
}

async function cappedFailure(storage: Storage) {
	const prepared = await active(storage);
	const checkpoint = prepared.attachment.runState!;
	const operationId = prepared.attachment.runOperation!.value.operationId;
	const triggerEntryId = checkpoint.value.phase.kind === "checkpoint" ? checkpoint.value.phase.triggerEntryId : "";
	const ready = await prepared.runtimeSession.startAssistantStep({
		operationId,
		triggerEntryId,
		expectedOperationStateSeq: checkpoint.seq,
		expectedLaneStateSeq: prepared.attachment.laneState.seq,
		expectedConfigurationSeq: prepared.attachment.laneConfiguration.seq,
		streamOptions: {},
		retryPolicy: { maxAttempts: 1, baseDelayMs: 0 },
	});
	const phase = ready.attachment.runState!.value.phase;
	if (phase.kind !== "assistant" || phase.generation.status !== "ready") throw new Error("assistant ready expected");
	const pending = await prepared.runtimeSession.prepareAssistantEffect({
		operationId,
		stepId: phase.generation.context.stepId,
		attempt: 1,
		expectedOperationStateSeq: ready.attachment.runState!.seq,
		expectedLaneStateSeq: ready.attachment.laneState.seq,
		expectedConfigurationSeq: ready.attachment.laneConfiguration.seq,
		expectedLeafSeq: ready.attachment.mainLeaf.seq,
		expectedLeafId: ready.attachment.mainLeaf.value,
		expectedProvider: "test",
		expectedModelId: "model",
		intendedOutputLimit: 1,
		contextWindow: 2,
	});
	if (!pending.committed) throw new Error("assistant effect preparation expected");
	const failed = await prepared.runtimeSession.recoverAssistantEffect({
		operationId,
		stepId: phase.generation.context.stepId,
		attempt: 1,
		responseEntryId: pending.responseEntryId,
		usageId: pending.usageId,
		expectedOperationStateSeq: pending.attachment.runState!.seq,
		expectedLaneStateSeq: pending.attachment.laneState.seq,
	});
	if (failed.status !== "committed" || failed.attachment.runState!.value.phase.kind !== "failure_drain")
		throw new Error("failure drain expected");
	return { ...prepared, attachment: failed.attachment, operationId, responseEntryId: pending.responseEntryId };
}

function planner(attachment: Awaited<ReturnType<typeof attachRuntime>>) {
	return planAction(attachment, { settingsRevision: 0, assistantEffectStatus: () => undefined })?.info;
}

async function installWrites(
	prepared: Awaited<ReturnType<typeof active>>,
	pending: Array<{ id: string; value: JsonValue }>,
): Promise<void> {
	const current = await prepared.runtimeSession.refreshRuntimeAttachment();
	const state = structuredClone(current.runState!.value);
	state.inbox.writes = pending.map(({ id: entryId }) => entryId);
	await prepared.storage.commit({
		writes: [
			...pending.map(({ id: key, value }) => ({
				kind: "register" as const,
				op: "set" as const,
				namespace: "pending.entry",
				key,
				value,
			})),
			{
				kind: "register",
				op: "set",
				namespace: "op.state",
				key: current.runOperation!.value.operationId,
				value: state as unknown as JsonValue,
			},
		],
	});
}

describe("operation-owned queues", () => {
	it("selectQueueDrain covers checkpoint, finish, failure rescue, skip, cancellation, modes, and immutable copies", () => {
		const base: RunState = {
			kind: "run",
			control: { status: "running" },
			settings: {
				compaction: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 },
				steeringMode: "all",
				followUpMode: "all",
				toolExecution: "sequential",
			},
			phase: {
				kind: "checkpoint",
				continuation: { kind: "need_assistant", overflowRecoveryUsed: false },
				triggerEntryId: id(),
			},
			inbox: { steer: [id(), id()], followUp: [id(), id()], writes: [] },
			latestAssistantEntryId: null,
		};
		for (const mode of ["all", "one-at-a-time"] as const) {
			const state = structuredClone(base);
			state.settings.steeringMode = mode;
			state.settings.followUpMode = mode;
			const steer = selectQueueDrain(state)!;
			expect(steer).toEqual({
				kind: "steer",
				entryIds: mode === "all" ? state.inbox.steer : state.inbox.steer.slice(0, 1),
			});
			expect(Object.isFrozen(steer)).toBe(true);
			expect(Object.isFrozen(steer.entryIds)).toBe(true);
			expect(steer.entryIds).not.toBe(state.inbox.steer);
			if (state.phase.kind !== "checkpoint") throw new Error("checkpoint expected");
			state.phase.continuation = { kind: "may_finish", includeFinalAssistant: true };
			state.inbox.steer = [];
			expect(selectQueueDrain(state)).toEqual({
				kind: "followUp",
				entryIds: mode === "all" ? state.inbox.followUp : state.inbox.followUp.slice(0, 1),
			});
			state.phase = {
				kind: "failure_drain",
				error: { code: "provider_interrupted", message: "failed" },
				provenance: { kind: "response", entryId: id() },
			};
			state.inbox.steer = [...base.inbox.steer];
			expect(selectQueueDrain(state)?.kind).toBe("steer");
			state.inbox.steer = [];
			expect(selectQueueDrain(state)?.kind).toBe("followUp");
		}
		const skipped = structuredClone(base);
		if (skipped.phase.kind !== "checkpoint") throw new Error("checkpoint expected");
		skipped.phase.skipInboxOnce = true;
		expect(selectQueueDrain(skipped)).toBeUndefined();
		skipped.phase.continuation = { kind: "may_finish", includeFinalAssistant: true };
		skipped.inbox.steer = [];
		expect(selectQueueDrain(skipped)).toBeUndefined();
		skipped.control = { status: "cancel_requested", requestedAt: 1, drainedSteer: [], drainedFollowUp: [] };
		expect(selectQueueDrain(skipped)).toBeUndefined();
	});

	it("keeps writes out of queue selection and plans their dedicated drain first", async () => {
		const prepared = await active();
		const writeId = id();
		await installWrites(prepared, [{ id: writeId, value: { type: "custom", customType: "deferred" } }]);
		const current = await prepared.runtimeSession.refreshRuntimeAttachment();
		expect(selectQueueDrain(current.runState!.value)).toBeUndefined();
		expect(planner(current)).toEqual({
			kind: "apply_deferred_writes",
			operationId: current.runOperation!.value.operationId,
			entryIds: [writeId],
		});
		await closeAttachedRuntime(prepared.runtimeSession);
	});

	describe("D-052 runtime write placement", () => {
		type ActiveBootstrap = {
			readonly operationId: string;
			readonly promptEntryId: string;
			readonly state: RunState;
		};

		type ActiveBootstrapResult = {
			readonly writes?: Write[];
			readonly leafId?: string;
		};

		async function claimedRuntime(
			storage = instrumentStorage(new MemoryStorage()),
			prepare?: (bootstrap: ActiveBootstrap) => ActiveBootstrapResult | undefined,
		) {
			const operationId = id();
			const promptEntryId = id();
			const state: RunState = {
				kind: "run",
				control: { status: "running" },
				settings: {
					compaction: { enabled: false, reserveTokens: 0, keepRecentTokens: 0 },
					steeringMode: "all",
					followUpMode: "all",
					toolExecution: "sequential",
				},
				phase: {
					kind: "checkpoint",
					continuation: { kind: "need_assistant", overflowRecoveryUsed: false },
					triggerEntryId: promptEntryId,
				},
				inbox: { steer: [], followUp: [], writes: [] },
				latestAssistantEntryId: null,
			};
			const prepared = prepare?.({ operationId, promptEntryId, state });
			await storage.commit({
				writes: [
					{
						kind: "entry",
						entry: { id: promptEntryId, parentId: null, type: "message", payload: jsonValue(user("prompt")) },
					},
					...(prepared?.writes ?? []),
					{
						kind: "register",
						op: "set",
						namespace: "lane.config",
						key: "main",
						value: jsonValue(configuration),
					},
					{
						kind: "register",
						op: "set",
						namespace: "lane.leaf",
						key: "main",
						value: prepared?.leafId ?? promptEntryId,
					},
					{
						kind: "register",
						op: "set",
						namespace: "op.meta",
						key: operationId,
						value: {
							operationId,
							lane: "main",
							sourceLeafId: null,
							startedAt: 1,
							intent: { kind: "run", promptEntryIds: [promptEntryId] },
						},
					},
					{
						kind: "register",
						op: "set",
						namespace: "op.state",
						key: operationId,
						value: jsonValue(state),
					},
					{
						kind: "register",
						op: "set",
						namespace: "lane.state",
						key: "main",
						value: { currentOperationId: operationId, pendingNextRun: [] },
					},
				],
			});
			const runtimeSession = session(storage);
			const owner = await claimRuntime(runtimeSession, configuration);
			return { runtimeSession, owner, attachment: owner.attachment, storage };
		}

		async function admitRuntimeWrite(owner: Awaited<ReturnType<typeof claimedRuntime>>["owner"], value: JsonValue) {
			if (value === null || typeof value !== "object" || Array.isArray(value))
				throw new Error("pending value expected");
			if (value.type === "message")
				return owner.appendMessage(value.payload as unknown as Parameters<typeof owner.appendMessage>[0]);
			if (value.type !== "custom" || typeof value.customType !== "string") throw new Error("pending value expected");
			return Object.hasOwn(value, "payload")
				? owner.appendCustomEntry(value.customType, value.payload)
				: owner.appendCustomEntry(value.customType);
		}

		async function placementFixture(
			values: JsonValue[],
			prepare?: (bootstrap: ActiveBootstrap) => ActiveBootstrapResult | undefined,
			storage = instrumentStorage(new MemoryStorage()),
		) {
			const prepared = await claimedRuntime(storage, prepare);
			const admissions = [];
			for (const value of values) admissions.push(await admitRuntimeWrite(prepared.owner, value));
			const pending = admissions.map(({ entryId: id }, index) => ({ id, value: values[index] }));
			const before = admissions.at(-1)?.attachment ?? prepared.attachment;
			storage.committedTransactions.length = 0;
			const transition = {
				operationId: before.runOperation!.value.operationId,
				expectedOperationStateSeq: before.runState!.seq,
				expectedLeafSeq: before.mainLeaf.seq,
				expectedLeafId: before.mainLeaf.value,
				entryIds: pending.map(({ id: entryId }) => entryId),
				classifications: pending.map(({ id: entryId }) => ({
					entryId,
					projection: "unprojected" as "projecting" | "unprojected",
				})),
			};
			return { prepared, pending, storage, before, transition };
		}

		it("places an exact proper prefix atomically and preserves the later write", async () => {
			const storage = instrumentStorage(new MemoryStorage());
			const prepared = await claimedRuntime(storage);
			const first = await prepared.owner.appendMessage(user("first"));
			const nullable = await prepared.owner.appendCustomEntry("null", null);
			const later = await prepared.owner.appendCustomEntry("later");
			const pending = [first, nullable, later].map(({ entryId: id }) => ({ id }));
			const before = later.attachment;
			storage.committedTransactions.length = 0;
			const reads = storage.attempts.length;
			const result = await placeRuntimeWrites(prepared.runtimeSession, {
				operationId: before.runOperation!.value.operationId,
				expectedOperationStateSeq: before.runState!.seq,
				expectedLeafSeq: before.mainLeaf.seq,
				expectedLeafId: before.mainLeaf.value,
				entryIds: pending.slice(0, 2).map(({ id: entryId }) => entryId),
				classifications: [
					{ entryId: pending[0].id, projection: "projecting" },
					{ entryId: pending[1].id, projection: "unprojected" },
				],
			});
			expect(result.status).toBe("placed");
			expect(storage.committedTransactions).toHaveLength(1);
			expect(storage.committedTransactions[0].writes).toEqual([
				expect.objectContaining({
					kind: "entry",
					entry: expect.objectContaining({ id: pending[0].id, parentId: before.mainLeaf.value }),
				}),
				expect.objectContaining({
					kind: "entry",
					entry: expect.objectContaining({ id: pending[1].id, parentId: pending[0].id }),
				}),
				{ kind: "register", op: "delete", namespace: "pending.entry", key: pending[0].id },
				{ kind: "register", op: "delete", namespace: "pending.entry", key: pending[1].id },
				{ kind: "register", op: "set", namespace: "lane.leaf", key: "main", value: pending[1].id },
				expect.objectContaining({
					kind: "register",
					op: "set",
					namespace: "op.state",
					key: before.runOperation!.value.operationId,
				}),
			]);
			expect(result.attachment.runState!.value.inbox.writes).toEqual([pending[2].id]);
			expect(result.attachment.pendingEntries.has(pending[0].id)).toBe(false);
			expect(result.attachment.pendingEntries.get(pending[2].id)).toEqual({ type: "custom", customType: "later" });
			expect(result.attachment.entries.get(pending[1].id)).toHaveProperty("data", null);
			expect(result.attachment.runState!.value.phase).toMatchObject({
				kind: "checkpoint",
				continuation: { kind: "need_assistant", overflowRecoveryUsed: false },
				triggerEntryId: pending[1].id,
				skipInboxOnce: true,
			});
			expect(storage.attempts).toHaveLength(reads + 1);
			await prepared.owner.close();
		});

		it("maps every returned entry, leaf, and state sequence to the single commit without postcommit reads", async () => {
			vi.spyOn(Date, "now").mockReturnValue(8675309);
			const fixture = await placementFixture([
				jsonValue({ type: "custom", customType: "absent" }),
				jsonValue({ type: "custom", customType: "null", payload: null }),
			]);
			const readNames = [
				"getEntries",
				"getUsageRows",
				"getRegister",
				"listRegisters",
				"scanBranchStructure",
			] as const;
			const spies = readNames.map((name) => vi.spyOn(fixture.storage, name));
			let readsAtCommit: number[] | undefined;
			const commit = fixture.storage.commit.bind(fixture.storage);
			fixture.storage.commit = (transaction) => {
				readsAtCommit = spies.map((spy) => spy.mock.calls.length);
				return commit(transaction);
			};
			const result = await placeRuntimeWrites(fixture.prepared.runtimeSession, fixture.transition);
			const firstSeq = result.attachment.entries.get(fixture.pending[0].id)!.seq;
			expect([...result.attachment.entries.values()].slice(-2)).toEqual([
				expect.objectContaining({ id: fixture.pending[0].id, seq: firstSeq, timestamp: 8675309 }),
				expect.objectContaining({ id: fixture.pending[1].id, seq: firstSeq + 1, timestamp: 8675309, data: null }),
			]);
			expect(result.attachment.entries.get(fixture.pending[0].id)).not.toHaveProperty("data");
			expect(result.attachment.mainLeaf.seq).toBe(firstSeq + 4);
			expect(result.attachment.runState!.seq).toBe(firstSeq + 5);
			expect(spies.map((spy) => spy.mock.calls.length)).toEqual(readsAtCommit);
			await fixture.prepared.owner.close();
			vi.restoreAllMocks();
		});

		it.each(["checkpoint", "failure_drain"] as const)(
			"reduces mixed projecting writes from running %s to the canonical checkpoint",
			async (kind) => {
				const fixture = await placementFixture(
					[
						jsonValue({ type: "custom", customType: "project" }),
						jsonValue({ type: "custom", customType: "plain" }),
					],
					({ state, promptEntryId }) => {
						if (kind === "failure_drain") {
							const responseEntryId = id();
							state.phase = {
								kind,
								error: { code: "provider_interrupted", message: "Provider outcome unknown after interruption" },
								provenance: { kind: "response", entryId: responseEntryId },
							};
							state.latestAssistantEntryId = responseEntryId;
							return {
								leafId: responseEntryId,
								writes: [
									{
										kind: "entry",
										entry: {
											id: responseEntryId,
											parentId: promptEntryId,
											type: "message",
											payload: jsonValue({
												...assistant("error"),
												content: [],
												api: "harness",
												errorMessage: "Provider outcome unknown after interruption",
											}),
										},
									},
								],
							};
						}
					},
				);
				fixture.transition.classifications = [
					{ entryId: fixture.pending[0].id, projection: "projecting" },
					{ entryId: fixture.pending[1].id, projection: "unprojected" },
				];
				const result = await placeRuntimeWrites(fixture.prepared.runtimeSession, fixture.transition);
				expect(result.attachment.runState!.value.phase).toEqual({
					kind: "checkpoint",
					continuation: { kind: "need_assistant", overflowRecoveryUsed: false },
					triggerEntryId: fixture.pending[1].id,
					skipInboxOnce: true,
				});
				await fixture.prepared.owner.close();
			},
		);

		it("preserves the complete running phase for all-unprojected custom writes", async () => {
			for (const kind of ["checkpoint", "failure_drain"] as const) {
				let expected!: RunState["phase"];
				const fixture = await placementFixture(
					[jsonValue({ type: "custom", customType: "plain" })],
					({ state, promptEntryId }) => {
						if (kind === "checkpoint") {
							if (state.phase.kind !== "checkpoint") throw new Error("checkpoint expected");
						} else {
							const responseEntryId = id();
							state.phase = {
								kind,
								error: { code: "provider_interrupted", message: "Provider outcome unknown after interruption" },
								provenance: { kind: "response", entryId: responseEntryId },
							};
							state.latestAssistantEntryId = responseEntryId;
							expected = structuredClone(state.phase);
							return {
								leafId: responseEntryId,
								writes: [
									{
										kind: "entry",
										entry: {
											id: responseEntryId,
											parentId: promptEntryId,
											type: "message",
											payload: jsonValue({
												...assistant("error"),
												content: [],
												api: "harness",
												errorMessage: "Provider outcome unknown after interruption",
											}),
										},
									},
								],
							};
						}
						expected = structuredClone(state.phase);
					},
				);
				const result = await placeRuntimeWrites(fixture.prepared.runtimeSession, fixture.transition);
				expect(result.attachment.runState!.value.phase).toEqual(expected);
				await fixture.prepared.owner.close();
			}
		});

		const phaseCases = [
			"checkpoint-skip",
			"failure_drain",
			"assistant-ready",
			"assistant-retry_wait",
			"assistant-effect_pending",
			"tools-completed",
			"tools-planned",
			"tools-effect_pending",
		] as const;

		function installPhase(name: (typeof phaseCases)[number], bootstrap: ActiveBootstrap): ActiveBootstrapResult {
			const { operationId, promptEntryId, state } = bootstrap;
			if (name === "checkpoint-skip") {
				if (state.phase.kind !== "checkpoint") throw new Error("checkpoint expected");
				state.phase.skipInboxOnce = true;
				return {};
			}
			if (name === "failure_drain") {
				const responseEntryId = id();
				state.phase = {
					kind: "failure_drain",
					error: { code: "provider_interrupted", message: "Provider outcome unknown after interruption" },
					provenance: { kind: "response", entryId: responseEntryId },
				};
				state.latestAssistantEntryId = responseEntryId;
				return {
					leafId: responseEntryId,
					writes: [
						{
							kind: "entry",
							entry: {
								id: responseEntryId,
								parentId: promptEntryId,
								type: "message",
								payload: jsonValue({
									...assistant("error"),
									content: [],
									api: "harness",
									errorMessage: "Provider outcome unknown after interruption",
								}),
							},
						},
					],
				};
			}
			const context = {
				stepId: id(),
				triggerEntryId: promptEntryId,
				configuration,
				streamOptions: {},
				retryPolicy: { maxAttempts: 3, baseDelayMs: 10 },
				overflowRecoveryUsed: false,
			};
			if (name.startsWith("assistant-")) {
				const status = name.slice("assistant-".length);
				state.phase = {
					kind: "assistant",
					generation:
						status === "ready"
							? { status, context, nextAttempt: 1 }
							: status === "retry_wait"
								? {
										status,
										context,
										nextAttempt: 2,
										notBefore: 100,
										errorMessage: "Provider outcome unknown after interruption",
									}
								: {
										status: "effect_pending",
										context,
										attempt: 1,
										responseEntryId: id(),
										usageId: id(),
										intendedOutputLimit: 1,
										contextWindow: 2,
									},
				};
				return {};
			}
			const assistantEntryId = createIdGenerator().next(uuidV7Timestamp(promptEntryId) + 1);
			const resultEntryId = createFollowerId(assistantEntryId);
			const turnId = id();
			const status = name.slice("tools-".length) as "completed" | "planned" | "effect_pending";
			state.phase = {
				kind: "tools",
				batch: {
					assistantEntryId,
					configuration,
					turnId,
					calls: [
						status === "completed"
							? { status, sourceIndex: 0, resultEntryId, terminate: false }
							: status === "effect_pending"
								? { status, sourceIndex: 0, resultEntryId, replay: "safe" }
								: { status, sourceIndex: 0, resultEntryId },
					],
				},
			};
			state.latestAssistantEntryId = assistantEntryId;
			const writes: Write[] = [
				{
					kind: "entry",
					entry: {
						id: assistantEntryId,
						parentId: promptEntryId,
						type: "message",
						payload: jsonValue({
							...assistant("toolUse"),
							content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
						}),
					},
				},
			];
			if (status === "completed")
				writes.push({
					kind: "entry",
					entry: {
						id: resultEntryId,
						parentId: assistantEntryId,
						type: "message",
						payload: jsonValue(toolResult()),
					},
				});
			if (status === "effect_pending")
				writes.push({
					kind: "register",
					op: "set",
					namespace: "op.tool_args",
					key: `${operationId}:${turnId}:0`,
					value: {},
				});
			return { writes, leafId: status === "completed" ? resultEntryId : assistantEntryId };
		}

		it.each([
			"checkpoint-skip",
			"failure_drain",
			"assistant-ready",
			"assistant-retry_wait",
			"tools-completed",
		] as const)("preserves exact cancelled %s phase and control", async (name) => {
			let expectedPhase!: RunState["phase"];
			let expectedControl!: RunState["control"];
			const fixture = await placementFixture([jsonValue({ type: "custom", customType: "project" })], (bootstrap) => {
				const prepared = installPhase(name, bootstrap);
				const { state } = bootstrap;
				state.control = { status: "cancel_requested", requestedAt: 7, drainedSteer: [], drainedFollowUp: [] };
				expectedPhase = structuredClone(state.phase);
				expectedControl = structuredClone(state.control);
				return prepared;
			});
			fixture.transition.classifications = [{ entryId: fixture.pending[0].id, projection: "projecting" }];
			const result = await placeRuntimeWrites(fixture.prepared.runtimeSession, fixture.transition);
			expect(result.status).toBe("placed");
			expect(result.attachment.runState!.value.phase).toEqual(expectedPhase);
			expect(result.attachment.runState!.value.control).toEqual(expectedControl);
			await fixture.prepared.owner.close();
		});

		it.each([
			["running checkpoint skip", "checkpoint-skip", false],
			["running assistant ready", "assistant-ready", false],
			["running assistant effect_pending", "assistant-effect_pending", false],
			["running tools planned", "tools-planned", false],
			["running tools effect_pending", "tools-effect_pending", false],
			["cancelled assistant effect_pending", "assistant-effect_pending", true],
			["cancelled tools planned", "tools-planned", true],
			["cancelled tools effect_pending", "tools-effect_pending", true],
		] as const)("returns obsolete write-free for ineligible %s", async (_label, name, cancelled) => {
			const fixture = await placementFixture([jsonValue({ type: "custom", customType: "plain" })], (bootstrap) => {
				const prepared = installPhase(name, bootstrap);
				if (cancelled)
					bootstrap.state.control = {
						status: "cancel_requested",
						requestedAt: 7,
						drainedSteer: [],
						drainedFollowUp: [],
					};
				return prepared;
			});
			fixture.storage.committedTransactions.length = 0;
			await expect(placeRuntimeWrites(fixture.prepared.runtimeSession, fixture.transition)).resolves.toMatchObject({
				status: "obsolete",
			});
			expect(fixture.storage.committedTransactions).toEqual([]);
			await fixture.prepared.owner.close();
		});

		it.each([
			[
				"transition extra field",
				(value: Record<string, unknown>) => {
					value.extra = true;
				},
			],
			["transition missing field", (value: Record<string, unknown>) => delete value.expectedLeafId],
			[
				"transition accessor field",
				(value: Record<string, unknown>) =>
					Object.defineProperty(value, "operationId", { enumerable: true, get: () => id() }),
			],
			[
				"transition non-data object",
				(value: Record<string, unknown>) => Object.setPrototypeOf(value, { inherited: true }),
			],
			[
				"operation invalid UUID",
				(value: Record<string, unknown>) => {
					value.operationId = "not-a-uuid";
				},
			],
			[
				"expected state sequence non-safe",
				(value: Record<string, unknown>) => {
					value.expectedOperationStateSeq = 2 ** 53;
				},
			],
			[
				"expected state sequence negative",
				(value: Record<string, unknown>) => {
					value.expectedOperationStateSeq = -1;
				},
			],
			[
				"expected state sequence zero",
				(value: Record<string, unknown>) => {
					value.expectedOperationStateSeq = 0;
				},
			],
			[
				"expected leaf sequence non-safe",
				(value: Record<string, unknown>) => {
					value.expectedLeafSeq = 2 ** 53;
				},
			],
			[
				"expected leaf sequence negative",
				(value: Record<string, unknown>) => {
					value.expectedLeafSeq = -1;
				},
			],
			[
				"expected leaf sequence zero",
				(value: Record<string, unknown>) => {
					value.expectedLeafSeq = 0;
				},
			],
			[
				"expected leaf invalid UUID",
				(value: Record<string, unknown>) => {
					value.expectedLeafId = "not-a-uuid";
				},
			],
			[
				"entry invalid UUID",
				(value: Record<string, unknown>) => {
					value.entryIds = ["not-a-uuid"];
					value.classifications = [{ entryId: "not-a-uuid", projection: "unprojected" }];
				},
			],
			[
				"entry sparse array",
				(value: Record<string, unknown>) => {
					value.entryIds = new Array(1);
				},
			],
			[
				"classification sparse array",
				(value: Record<string, unknown>) => {
					value.classifications = new Array(1);
				},
			],
			[
				"empty vectors",
				(value: Record<string, unknown>) => Object.assign(value, { entryIds: [], classifications: [] }),
			],
			[
				"duplicate entries",
				(value: Record<string, unknown>) => {
					const entryId = (value.entryIds as string[])[0];
					value.entryIds = [entryId, entryId];
					value.classifications = [
						{ entryId, projection: "unprojected" },
						{ entryId, projection: "unprojected" },
					];
				},
			],
			[
				"mismatched lengths",
				(value: Record<string, unknown>) => {
					value.classifications = [];
				},
			],
			[
				"mismatched classification entry",
				(value: Record<string, unknown>) => {
					value.classifications = [{ entryId: id(), projection: "unprojected" }];
				},
			],
			[
				"classification invalid UUID",
				(value: Record<string, unknown>) => {
					value.classifications = [{ entryId: "not-a-uuid", projection: "unprojected" }];
				},
			],
			[
				"classification extra field",
				(value: Record<string, unknown>) => {
					const entryId = (value.entryIds as string[])[0];
					value.classifications = [{ entryId, projection: "unprojected", extra: true }];
				},
			],
			[
				"classification missing field",
				(value: Record<string, unknown>) => {
					const entryId = (value.entryIds as string[])[0];
					value.classifications = [{ entryId }];
				},
			],
			[
				"classification accessor field",
				(value: Record<string, unknown>) => {
					const entryId = (value.entryIds as string[])[0];
					value.classifications = [
						Object.defineProperty({ entryId }, "projection", { enumerable: true, get: () => "unprojected" }),
					];
				},
			],
			[
				"classification non-data object",
				(value: Record<string, unknown>) => {
					const entryId = (value.entryIds as string[])[0];
					value.classifications = [
						Object.assign(Object.create({ inherited: true }), { entryId, projection: "unprojected" }),
					];
				},
			],
			[
				"invalid projection",
				(value: Record<string, unknown>) => {
					const entryId = (value.entryIds as string[])[0];
					value.classifications = [{ entryId, projection: "invalid" }];
				},
			],
		] as const)("rejects structurally invalid %s synchronously and write-free", async (_name, mutate) => {
			const fixture = await placementFixture([jsonValue({ type: "custom", customType: "x" })]);
			const transition: Record<string, unknown> = structuredClone(fixture.transition);
			mutate(transition);
			const reads = fixture.storage.attempts.length;
			const placement = placeRuntimeWrites(
				fixture.prepared.runtimeSession,
				transition as unknown as Parameters<typeof placeRuntimeWrites>[1],
			);
			expect(fixture.storage.attempts).toHaveLength(reads);
			await expect(placement).rejects.toMatchObject({ code: "invalid_query" });
			expect(fixture.storage.committedTransactions).toEqual([]);
			await fixture.prepared.owner.close();
		});

		it.each(["missing", "malformed", "entry", "usage"] as const)(
			"rejects matching-authority pending %s read corruption without a placement commit",
			async (kind) => {
				const delegate = new MemoryStorage();
				let armed = false;
				let faultEntryId: string | undefined;
				const faultingStorage = new Proxy(delegate, {
					get(target, property) {
						if (property === "getRegister")
							return async (namespace: string, key: string) => {
								const register = await target.getRegister(namespace, key);
								if (!armed || namespace !== "pending.entry" || key !== faultEntryId) return register;
								if (kind === "missing") return undefined;
								return kind === "malformed" && register ? { ...register, value: { type: "custom" } } : register;
							};
						if (property === "getEntries")
							return async (ids: string[]) => {
								const entries = new Map(await target.getEntries(ids));
								if (armed && kind === "entry" && faultEntryId && ids.includes(faultEntryId))
									entries.set(faultEntryId, {
										id: faultEntryId,
										parentId: null,
										seq: 1,
										timestamp: 1,
										type: "custom",
										customType: "x",
									});
								return entries;
							};
						if (property === "getUsageRows")
							return async (ids: string[]) => {
								const rows = new Map(await target.getUsageRows(ids));
								if (armed && kind === "usage" && faultEntryId && ids.includes(faultEntryId))
									rows.set(faultEntryId, {
										id: faultEntryId,
										seq: 1,
										adjustment: false,
										usage: ZERO_USAGE,
									});
								return rows;
							};
						const value: unknown = Reflect.get(target, property);
						return typeof value === "function" ? value.bind(target) : value;
					},
				}) as Storage;
				const storage = instrumentStorage(faultingStorage);
				const fixture = await placementFixture(
					[jsonValue({ type: "custom", customType: "x" })],
					undefined,
					storage,
				);
				faultEntryId = fixture.pending[0].id;
				armed = true;
				await expect(placeRuntimeWrites(fixture.prepared.runtimeSession, fixture.transition)).rejects.toMatchObject(
					{
						code: "corruption",
					},
				);
				expect(fixture.storage.committedTransactions).toEqual([]);
				await fixture.prepared.owner.close();
			},
		);

		it("returns obsolete write-free for stale state authority and rejects unprojected messages", async () => {
			const storage = instrumentStorage(new MemoryStorage());
			const prepared = await claimedRuntime(storage);
			const admission = await prepared.owner.appendMessage(user("x"));
			const entryId = admission.entryId;
			const before = admission.attachment;
			storage.committedTransactions.length = 0;
			const transition = {
				operationId: before.runOperation!.value.operationId,
				expectedOperationStateSeq: before.runState!.seq,
				expectedLeafSeq: before.mainLeaf.seq,
				expectedLeafId: before.mainLeaf.value,
				entryIds: [entryId],
				classifications: [{ entryId, projection: "projecting" as const }],
			};
			const obsolete = await placeRuntimeWrites(prepared.runtimeSession, {
				...transition,
				expectedOperationStateSeq: transition.expectedOperationStateSeq + 1,
			});
			expect(obsolete).toMatchObject({ status: "obsolete" });
			expect(obsolete).not.toHaveProperty("facts");
			await expect(
				placeRuntimeWrites(prepared.runtimeSession, {
					...transition,
					classifications: [{ entryId, projection: "unprojected" }],
				}),
			).rejects.toMatchObject({ code: "invalid_query" });
			expect(storage.committedTransactions).toHaveLength(0);
			await prepared.owner.close();
		});

		it.each([
			[
				"owner",
				(transition: Record<string, unknown>) => {
					transition.operationId = id();
				},
			],
			[
				"state sequence",
				(transition: Record<string, unknown>) => {
					transition.expectedOperationStateSeq = (transition.expectedOperationStateSeq as number) + 1;
				},
			],
			[
				"leaf sequence",
				(transition: Record<string, unknown>) => {
					transition.expectedLeafSeq = (transition.expectedLeafSeq as number) + 1;
				},
			],
			[
				"leaf value",
				(transition: Record<string, unknown>) => {
					transition.expectedLeafId = id();
				},
			],
			[
				"FIFO non-prefix",
				(transition: Record<string, unknown>) => {
					const other = id();
					transition.entryIds = [other];
					transition.classifications = [{ entryId: other, projection: "unprojected" }];
				},
			],
		] as const)("returns obsolete and writes nothing for stale %s", async (_name, mutate) => {
			const storage = instrumentStorage(new MemoryStorage());
			const prepared = await claimedRuntime(storage);
			const admission = await prepared.owner.appendCustomEntry("x");
			const entryId = admission.entryId;
			const before = admission.attachment;
			storage.committedTransactions.length = 0;
			const transition: Record<string, unknown> = {
				operationId: before.runOperation!.value.operationId,
				expectedOperationStateSeq: before.runState!.seq,
				expectedLeafSeq: before.mainLeaf.seq,
				expectedLeafId: before.mainLeaf.value,
				entryIds: [entryId],
				classifications: [{ entryId, projection: "unprojected" }],
			};
			mutate(transition);
			await expect(
				placeRuntimeWrites(
					prepared.runtimeSession,
					transition as unknown as Parameters<typeof placeRuntimeWrites>[1],
				),
			).resolves.toMatchObject({ status: "obsolete" });
			expect(storage.committedTransactions).toEqual([]);
			await prepared.owner.close();
		});

		it("orders placement and cancellation in both histories", async () => {
			for (const first of ["cancel", "place"] as const) {
				const fixture = await placementFixture([jsonValue({ type: "message", payload: user(first) })]);
				const entryId = fixture.pending[0].id;
				fixture.transition.classifications = [{ entryId, projection: "projecting" }];
				if (first === "cancel") {
					expect((await fixture.prepared.runtimeSession.cancelQueued(entryId)).outcome).toBe("cancelled");
					await expect(
						placeRuntimeWrites(fixture.prepared.runtimeSession, fixture.transition),
					).resolves.toMatchObject({
						status: "obsolete",
					});
				} else {
					expect((await placeRuntimeWrites(fixture.prepared.runtimeSession, fixture.transition)).status).toBe(
						"placed",
					);
					expect((await fixture.prepared.runtimeSession.cancelQueued(entryId)).outcome).toBe("already_consumed");
				}
				const current = await fixture.prepared.runtimeSession.refreshRuntimeAttachment();
				expect(current.pendingEntries.has(entryId)).toBe(false);
				expect(await fixture.storage.getRegister("pending.entry", entryId)).toBeUndefined();
				await fixture.prepared.owner.close();
			}
		});

		it("orders placement and abort in both histories", async () => {
			for (const first of ["abort", "place"] as const) {
				const fixture = await placementFixture([jsonValue({ type: "message", payload: user(first) })]);
				const entryId = fixture.pending[0].id;
				fixture.transition.classifications = [{ entryId, projection: "projecting" }];
				if (first === "abort") {
					expect((await fixture.prepared.runtimeSession.requestAbort(() => undefined)).status).toBe("committed");
					await expect(
						placeRuntimeWrites(fixture.prepared.runtimeSession, fixture.transition),
					).resolves.toMatchObject({
						status: "obsolete",
					});
					const current = await fixture.prepared.runtimeSession.refreshRuntimeAttachment();
					expect(current.runState!.value.inbox.writes).toEqual([entryId]);
					expect(current.pendingEntries.has(entryId)).toBe(true);
				} else {
					expect((await placeRuntimeWrites(fixture.prepared.runtimeSession, fixture.transition)).status).toBe(
						"placed",
					);
					await fixture.prepared.runtimeSession.requestAbort(() => undefined);
					const current = await fixture.prepared.runtimeSession.refreshRuntimeAttachment();
					expect(current.runState!.value.inbox.writes).toEqual([]);
					expect(current.entries.has(entryId)).toBe(true);
				}
				await fixture.prepared.owner.close();
			}
		});

		it("serializes placement with later active write admission", async () => {
			for (const first of ["admission", "place"] as const) {
				const { runtimeSession, owner, storage } = await claimedRuntime();
				const prefix = await owner.appendMessage(user("prefix"));
				const transition = {
					operationId: prefix.attachment.runOperation!.value.operationId,
					expectedOperationStateSeq: prefix.attachment.runState!.seq,
					expectedLeafSeq: prefix.attachment.mainLeaf.seq,
					expectedLeafId: prefix.attachment.mainLeaf.value,
					entryIds: [prefix.entryId],
					classifications: [{ entryId: prefix.entryId, projection: "projecting" as const }],
				};
				if (first === "admission") {
					const laterId = (await owner.appendCustomEntry("later")).entryId;
					await expect(placeRuntimeWrites(runtimeSession, transition)).resolves.toMatchObject({
						status: "obsolete",
					});
					const current = await runtimeSession.refreshRuntimeAttachment();
					const fresh = { ...transition, expectedOperationStateSeq: current.runState!.seq };
					expect((await placeRuntimeWrites(runtimeSession, fresh)).status).toBe("placed");
					const after = await runtimeSession.refreshRuntimeAttachment();
					expect(after.runState!.value.inbox.writes).toEqual([laterId]);
					expect(after.pendingEntries.has(laterId)).toBe(true);
					expect(await storage.getRegister("pending.entry", laterId)).toBeDefined();
				} else {
					expect((await placeRuntimeWrites(runtimeSession, transition)).status).toBe("placed");
					const laterId = (await owner.appendCustomEntry("later")).entryId;
					const after = await runtimeSession.refreshRuntimeAttachment();
					expect(after.entries.has(prefix.entryId)).toBe(true);
					expect(after.runState!.value.inbox.writes).toEqual([laterId]);
					expect(after.pendingEntries.has(laterId)).toBe(true);
					expect(await storage.getRegister("pending.entry", laterId)).toBeDefined();
				}
				await owner.close();
			}
		});

		it("lets an admitted placement finish before close and rejects placement after close", async () => {
			for (const first of ["place", "close"] as const) {
				const fixture = await placementFixture([jsonValue({ type: "custom", customType: first })]);
				if (first === "place") {
					let release!: () => void;
					let entered!: () => void;
					const blocked = new Promise<void>((resolve) => {
						release = resolve;
					});
					const admitted = new Promise<void>((resolve) => {
						entered = resolve;
					});
					const commit = fixture.storage.commit.bind(fixture.storage);
					fixture.storage.commit = async (transaction) => {
						entered();
						await blocked;
						return commit(transaction);
					};
					const placement = placeRuntimeWrites(fixture.prepared.runtimeSession, fixture.transition);
					await admitted;
					const closing = fixture.prepared.owner.close();
					release();
					expect((await placement).status).toBe("placed");
					await closing;
				} else {
					await fixture.prepared.owner.close();
					await expect(
						placeRuntimeWrites(fixture.prepared.runtimeSession, fixture.transition),
					).rejects.toMatchObject({
						code: "closed",
					});
					expect(fixture.storage.committedTransactions).toEqual([]);
				}
			}
		});

		it("keeps placement authority durable when its commit fails", async () => {
			const fixture = await placementFixture([jsonValue({ type: "custom", customType: "durable" })]);
			const entryId = fixture.pending[0].id;
			const cause = new Error("injected placement commit failure");
			fixture.storage.commit = vi.fn().mockRejectedValueOnce(cause);
			const failure = await placeRuntimeWrites(fixture.prepared.runtimeSession, fixture.transition).catch(
				(error: unknown) => error,
			);
			expect(failure).toMatchObject({ code: "storage", cause });
			const durable = await fixture.prepared.runtimeSession.refreshRuntimeAttachment();
			expect(durable.runState).toEqual(fixture.before.runState);
			expect(durable.mainLeaf).toEqual(fixture.before.mainLeaf);
			expect(durable.runState!.value.inbox.writes).toEqual([entryId]);
			expect(durable.pendingEntries.get(entryId)).toEqual({ type: "custom", customType: "durable" });
			expect(durable.entries.has(entryId)).toBe(false);
			await fixture.prepared.owner.close();
		});

		it("captures placement vectors synchronously before waiting on the mutation line", async () => {
			const storage = instrumentStorage(new MemoryStorage());
			const prepared = await claimedRuntime(storage);
			const first = await prepared.owner.appendCustomEntry("first");
			const second = await prepared.owner.appendCustomEntry("second");
			const ids = [first.entryId, second.entryId];
			const before = second.attachment;
			storage.committedTransactions.length = 0;
			let release!: () => void;
			let entered!: () => void;
			const blocked = new Promise<void>((resolve) => {
				release = resolve;
			});
			const admitted = new Promise<void>((resolve) => {
				entered = resolve;
			});
			const commit = storage.commit.bind(storage);
			let gate = true;
			storage.commit = async (transaction) => {
				if (gate) {
					gate = false;
					entered();
					await blocked;
				}
				return commit(transaction);
			};
			const prior = prepared.runtimeSession.nextRun(user("mutation-line gate"));
			await admitted;
			const entryIds = [ids[0]];
			const classifications = [{ entryId: ids[0], projection: "unprojected" as const }];
			const placement = placeRuntimeWrites(prepared.runtimeSession, {
				operationId: before.runOperation!.value.operationId,
				expectedOperationStateSeq: before.runState!.seq,
				expectedLeafSeq: before.mainLeaf.seq,
				expectedLeafId: before.mainLeaf.value,
				entryIds,
				classifications,
			});
			entryIds[0] = ids[1];
			classifications[0] = { entryId: ids[1], projection: "unprojected" };
			release();
			await prior;
			const result = await placement;
			expect(result).toMatchObject({ status: "placed", attachment: { mainLeaf: { value: ids[0] } } });
			await prepared.owner.close();
		});
	});

	it("cancels exactly one custom write with total state first and preserves FIFO survivors", async () => {
		const delegate = new MemoryStorage();
		const prepared = await active(delegate);
		const pending = [
			{ id: id(), value: jsonValue({ type: "message", payload: user("first") }) },
			{ id: id(), value: jsonValue({ type: "custom", customType: "cancel", payload: null }) },
			{ id: id(), value: jsonValue({ type: "custom", customType: "keep", payload: { nested: [1] } }) },
		];
		await installWrites(prepared, pending);
		const storage = instrumentStorage(delegate);
		const runtimeSession = session(storage);
		const before = await attachRuntime(runtimeSession, configuration);
		const expectedState = structuredClone(before.runState!.value);
		expectedState.inbox.writes = [pending[0].id, pending[2].id];
		const result = await runtimeSession.cancelQueued(pending[1].id);
		expect(result.outcome).toBe("cancelled");
		expect(storage.committedTransactions).toHaveLength(1);
		expect(storage.committedTransactions[0].writes).toEqual([
			{
				kind: "register",
				op: "set",
				namespace: "op.state",
				key: before.runOperation!.value.operationId,
				value: expectedState,
			},
			{ kind: "register", op: "delete", namespace: "pending.entry", key: pending[1].id },
		]);
		const restored = await runtimeSession.refreshRuntimeAttachment();
		expect(restored.runState!.value.inbox.writes).toEqual([pending[0].id, pending[2].id]);
		expect(restored.pendingEntries.get(pending[0].id)).toEqual({ type: "message", payload: user("first") });
		expect(restored.pendingEntries.get(pending[2].id)).toEqual({
			type: "custom",
			customType: "keep",
			payload: { nested: [1] },
		});
		await closeAttachedRuntime(runtimeSession);
		await closeAttachedRuntime(prepared.runtimeSession);
	});

	it("preserves writes exactly across abort, repeated abort, and drained cancellation", async () => {
		const delegate = new MemoryStorage();
		const prepared = await active(delegate);
		const pending = [
			{ id: id(), value: jsonValue({ type: "custom", customType: "absent" }) },
			{ id: id(), value: jsonValue({ type: "custom", customType: "null", payload: null }) },
		];
		await installWrites(prepared, pending);
		const drained = await prepared.runtimeSession.queueOperationInput("steer", user("drained"));
		const storage = instrumentStorage(delegate);
		const runtimeSession = session(storage);
		await attachRuntime(runtimeSession, configuration);
		const first = await runtimeSession.requestAbort(() => undefined);
		expect(first.status).toBe("committed");
		expect(storage.committedTransactions).toHaveLength(1);
		const stateWrite = storage.committedTransactions[0].writes[0];
		expect(stateWrite).toMatchObject({
			kind: "register",
			op: "set",
			value: expect.objectContaining({ inbox: { steer: [], followUp: [], writes: pending.map(({ id }) => id) } }),
		});
		expect(await runtimeSession.requestAbort(() => undefined)).toMatchObject({ status: "already_requested" });
		expect(storage.committedTransactions).toHaveLength(1);
		expect((await runtimeSession.cancelQueued(drained.entryId!)).outcome).toBe("not_found");
		expect(await delegate.getRegister("pending.entry", drained.entryId!)).toBeDefined();
		const restored = await runtimeSession.refreshRuntimeAttachment();
		expect(restored.runState!.value.inbox.writes).toEqual(pending.map(({ id }) => id));
		expect(restored.pendingEntries.get(pending[0].id)).not.toHaveProperty("payload");
		expect(restored.pendingEntries.get(pending[1].id)).toHaveProperty("payload", null);
		await closeAttachedRuntime(runtimeSession);
		await closeAttachedRuntime(prepared.runtimeSession);
	});

	it.each(["cancel-abort", "abort-cancel"] as const)(
		"serializes %s while preserving uncancelled writes",
		async (order) => {
			const prepared = await active();
			const pending = [
				{ id: id(), value: jsonValue({ type: "custom", customType: "cancel" }) },
				{ id: id(), value: jsonValue({ type: "custom", customType: "keep", payload: null }) },
			];
			await installWrites(prepared, pending);
			if (order === "cancel-abort") {
				expect((await prepared.runtimeSession.cancelQueued(pending[0].id)).outcome).toBe("cancelled");
				expect((await prepared.runtimeSession.requestAbort(() => undefined)).status).toBe("committed");
			} else {
				expect((await prepared.runtimeSession.requestAbort(() => undefined)).status).toBe("committed");
				expect((await prepared.runtimeSession.cancelQueued(pending[0].id)).outcome).toBe("cancelled");
			}
			const restored = await prepared.runtimeSession.refreshRuntimeAttachment();
			expect(restored.runState!.value.inbox.writes).toEqual([pending[1].id]);
			expect(restored.pendingEntries.get(pending[1].id)).toHaveProperty("payload", null);
			await closeAttachedRuntime(prepared.runtimeSession);
		},
	);

	it("serializes concurrent independent write cancellations without reordering survivors", async () => {
		const prepared = await active();
		const pending = [0, 1, 2, 3].map((index) => ({
			id: id(),
			value: jsonValue({ type: "custom", customType: `write-${index}`, payload: index }),
		}));
		await installWrites(prepared, pending);
		expect(
			(
				await Promise.all([
					prepared.runtimeSession.cancelQueued(pending[1].id),
					prepared.runtimeSession.cancelQueued(pending[3].id),
				])
			).map(({ outcome }) => outcome),
		).toEqual(["cancelled", "cancelled"]);
		const restored = await prepared.runtimeSession.refreshRuntimeAttachment();
		expect(restored.runState!.value.inbox.writes).toEqual([pending[0].id, pending[2].id]);
		expect(restored.pendingEntries.get(pending[0].id)).toHaveProperty("payload", 0);
		expect(restored.pendingEntries.get(pending[2].id)).toHaveProperty("payload", 2);
		await closeAttachedRuntime(prepared.runtimeSession);
	});

	it.each(["all", "one-at-a-time"] as const)(
		"rescues a canonical failure_drain with %s steer precedence and deterministic fresh reopens",
		async (mode) => {
			const durable = new MemoryStorageState();
			const failed = await cappedFailure(durable.createStorage());
			const steer = await failed.runtimeSession.queueOperationInput("steer", user("rescue"));
			const follow = await failed.runtimeSession.queueOperationInput("followUp", user("later"));
			const state = structuredClone((await failed.runtimeSession.refreshRuntimeAttachment()).runState!.value);
			state.settings.steeringMode = mode;
			await failed.storage.commit({
				writes: [
					{
						kind: "register",
						op: "set",
						namespace: "op.state",
						key: failed.operationId,
						value: state as unknown as JsonValue,
					},
				],
			});
			await closeAttachedRuntime(failed.runtimeSession);
			const reopened = session(durable.createStorage());
			const before = await attachRuntime(reopened, configuration);
			expect(planner(before)).toMatchObject({ kind: "consume_queue", queue: "steer", entryIds: [steer.entryId] });
			const consumed = await reopened.consumeOperationQueue({
				operationId: failed.operationId,
				kind: "steer",
				entryIds: [steer.entryId!],
				expectedOperationStateSeq: before.runState!.seq,
			});
			expect(consumed.attachment.entries.get(steer.entryId!)?.parentId).toBe(failed.responseEntryId);
			expect(consumed.attachment.runState!.value.phase).toMatchObject({ kind: "checkpoint", skipInboxOnce: true });
			expect(consumed.attachment.runState!.value.inbox.followUp).toEqual([follow.entryId]);
			await closeAttachedRuntime(reopened);
			const after = session(durable.createStorage());
			expect(planner(await attachRuntime(after, configuration))?.kind).toBe("start_assistant_step");
			await closeAttachedRuntime(after);
		},
	);

	it("rescues a canonical failure_drain with follow-up when steer is absent", async () => {
		const failed = await cappedFailure(new MemoryStorage());
		const follow = await failed.runtimeSession.queueOperationInput("followUp", user("rescue"));
		const before = await failed.runtimeSession.refreshRuntimeAttachment();
		expect(planner(before)).toMatchObject({ kind: "consume_queue", queue: "followUp", entryIds: [follow.entryId] });
		const consumed = await failed.runtimeSession.consumeOperationQueue({
			operationId: failed.operationId,
			kind: "followUp",
			entryIds: [follow.entryId!],
			expectedOperationStateSeq: before.runState!.seq,
		});
		expect(consumed.attachment.runState!.value.phase).toMatchObject({ kind: "checkpoint", skipInboxOnce: true });
		await closeAttachedRuntime(failed.runtimeSession);
	});

	it("one-at-a-time consume reopens through assistant-ready before the second steer is eligible", async () => {
		const durable = new MemoryStorageState();
		const prepared = await active(durable.createStorage());
		const ids = [
			(await prepared.runtimeSession.queueOperationInput("steer", user("first"))).entryId!,
			(await prepared.runtimeSession.queueOperationInput("steer", user("second"))).entryId!,
		];
		const current = await prepared.runtimeSession.refreshRuntimeAttachment();
		const value = structuredClone(current.runState!.value);
		value.settings.steeringMode = "one-at-a-time";
		await prepared.storage.commit({
			writes: [
				{
					kind: "register",
					op: "set",
					namespace: "op.state",
					key: current.runOperation!.value.operationId,
					value: value as unknown as JsonValue,
				},
			],
		});
		const before = await prepared.runtimeSession.refreshRuntimeAttachment();
		await prepared.runtimeSession.consumeOperationQueue({
			operationId: current.runOperation!.value.operationId,
			kind: "steer",
			entryIds: [ids[0]],
			expectedOperationStateSeq: before.runState!.seq,
		});
		await closeAttachedRuntime(prepared.runtimeSession);
		const reopened = session(durable.createStorage());
		const attached = await attachRuntime(reopened, configuration);
		expect(planner(attached)?.kind).toBe("start_assistant_step");
		const checkpoint = attached.runState!.value.phase;
		if (checkpoint.kind !== "checkpoint") throw new Error("checkpoint expected");
		const ready = await reopened.startAssistantStep({
			operationId: current.runOperation!.value.operationId,
			triggerEntryId: checkpoint.triggerEntryId,
			expectedOperationStateSeq: attached.runState!.seq,
			expectedLaneStateSeq: attached.laneState.seq,
			expectedConfigurationSeq: attached.laneConfiguration.seq,
			streamOptions: {},
			retryPolicy: { maxAttempts: 1, baseDelayMs: 0 },
		});
		expect(ready.attachment.runState!.value.phase).not.toHaveProperty("skipInboxOnce");
		expect(ready.attachment.runState!.value.inbox.steer).toEqual([ids[1]]);
		await closeAttachedRuntime(reopened);
		const twice = session(durable.createStorage());
		expect(planner(await attachRuntime(twice, configuration))?.kind).toBe("prepare_assistant_effect");
		await closeAttachedRuntime(twice);
	});

	it("orders cancelQueued and consume_queue on the mutation line in both histories", async () => {
		for (const first of ["cancel", "consume"] as const) {
			const storage = instrumentStorage(new MemoryStorage());
			const prepared = await active(storage);
			const queued = await prepared.runtimeSession.queueOperationInput("steer", user("queued"));
			const before = await prepared.runtimeSession.refreshRuntimeAttachment();
			const transition = {
				operationId: before.runOperation!.value.operationId,
				kind: "steer" as const,
				entryIds: [queued.entryId!],
				expectedOperationStateSeq: before.runState!.seq,
			};
			storage.committedTransactions.length = 0;
			if (first === "cancel") {
				expect((await prepared.runtimeSession.cancelQueued(queued.entryId!)).outcome).toBe("cancelled");
				expect((await prepared.runtimeSession.consumeOperationQueue(transition)).committed).toBe(false);
				expect(storage.committedTransactions).toHaveLength(1);
			} else {
				expect((await prepared.runtimeSession.consumeOperationQueue(transition)).committed).toBe(true);
				expect((await prepared.runtimeSession.cancelQueued(queued.entryId!)).outcome).toBe("already_consumed");
				expect(storage.committedTransactions).toHaveLength(1);
			}
			await closeAttachedRuntime(prepared.runtimeSession);
		}
	});

	it("orders operation queue admission and abort with no pending orphan", async () => {
		for (const first of ["admission", "abort"] as const) {
			const prepared = await active();
			if (first === "admission") {
				const queued = await prepared.runtimeSession.queueOperationInput("steer", user("queued"));
				const aborted = await prepared.runtimeSession.requestAbort(() => undefined);
				expect(aborted).toMatchObject({ status: "committed", drainedSteer: [user("queued")] });
				expect(aborted.attachment.runState!.value.control).toMatchObject({ drainedSteer: [queued.entryId] });
			} else {
				await prepared.runtimeSession.requestAbort(() => undefined);
				await expect(prepared.runtimeSession.queueOperationInput("steer", user("late"))).rejects.toMatchObject({
					code: "invalid_query",
				});
				expect((await prepared.runtimeSession.refreshRuntimeAttachment()).pendingEntries.size).toBe(0);
			}
			await closeAttachedRuntime(prepared.runtimeSession);
		}
	});

	it("orders nextRun and finish while preserving the accepted idle queue", async () => {
		for (const first of ["enqueue", "finish"] as const) {
			const prepared = await cappedFailure(new MemoryStorage());
			const before = await prepared.runtimeSession.refreshRuntimeAttachment();
			const queued = first === "enqueue" ? await prepared.runtimeSession.nextRun(user("next")) : undefined;
			const finish = await prepared.runtimeSession.finishRun({
				operationId: prepared.operationId,
				expectedOperationStateSeq: before.runState!.seq,
			});
			expect(finish.status).toBe("committed");
			const accepted = queued ?? (await prepared.runtimeSession.nextRun(user("next")));
			const current = await prepared.runtimeSession.refreshRuntimeAttachment();
			expect(current.laneState.value).toEqual({ currentOperationId: null, pendingNextRun: [accepted.entryId] });
			expect(current.pendingEntries.get(accepted.entryId!)?.payload).toEqual(user("next"));
			await closeAttachedRuntime(prepared.runtimeSession);
		}
	});

	it("rejects finish with residual writes without writing and preserves next-run", async () => {
		const delegate = new MemoryStorage();
		const prepared = await cappedFailure(delegate);
		const next = await prepared.runtimeSession.nextRun(user("next"));
		const writeId = id();
		await installWrites(prepared, [{ id: writeId, value: jsonValue({ type: "custom", customType: "residual" }) }]);
		const storage = instrumentStorage(delegate);
		const runtimeSession = session(storage);
		const current = await attachRuntime(runtimeSession, configuration);
		await expect(
			runtimeSession.finishRun({
				operationId: prepared.operationId,
				expectedOperationStateSeq: current.runState!.seq,
			}),
		).rejects.toMatchObject({ code: "corruption" });
		expect(storage.committedTransactions).toEqual([]);
		expect(await delegate.getRegister("pending.entry", writeId)).toBeDefined();
		expect(await delegate.getRegister("pending.entry", next.entryId!)).toBeDefined();
		expect((await delegate.getRegister("lane.state", "main"))?.value).toEqual({
			currentOperationId: prepared.operationId,
			pendingNextRun: [next.entryId],
		});
		await closeAttachedRuntime(runtimeSession);
		await closeAttachedRuntime(prepared.runtimeSession);
	});

	it("orders abort and finish at a valid terminal boundary", async () => {
		for (const first of ["abort", "finish"] as const) {
			const prepared = await cappedFailure(new MemoryStorage());
			const before = await prepared.runtimeSession.refreshRuntimeAttachment();
			if (first === "abort") {
				expect((await prepared.runtimeSession.requestAbort(() => undefined)).status).toBe("committed");
				const state = await prepared.runtimeSession.refreshRuntimeAttachment();
				const finished = await prepared.runtimeSession.finishRun({
					operationId: prepared.operationId,
					expectedOperationStateSeq: state.runState!.seq,
				});
				expect(finished).toMatchObject({ status: "committed", result: { kind: "aborted" } });
			} else {
				expect(
					(
						await prepared.runtimeSession.finishRun({
							operationId: prepared.operationId,
							expectedOperationStateSeq: before.runState!.seq,
						})
					).status,
				).toBe("committed");
				expect((await prepared.runtimeSession.requestAbort(() => undefined)).status).toBe("no_active");
			}
			const current = await prepared.runtimeSession.refreshRuntimeAttachment();
			expect(current.runState).toBeUndefined();
			expect(current.pendingEntries.size).toBe(0);
			await closeAttachedRuntime(prepared.runtimeSession);
		}
	});
	it("admits steer and follow-up with exact transactions and cancels only the selected queue item", async () => {
		const delegate = new MemoryStorage();
		const prepared = await active(delegate);
		const storage = instrumentStorage(delegate);
		const runtimeSession = session(storage);
		await attachRuntime(runtimeSession, configuration);
		const steer = await runtimeSession.queueOperationInput("steer", user("steer"));
		const followUp = await runtimeSession.queueOperationInput("followUp", user("follow"));
		expect(storage.committedTransactions[0].writes).toEqual([
			{
				kind: "register",
				op: "set",
				namespace: "pending.entry",
				key: steer.entryId,
				value: { type: "message", payload: user("steer") },
			},
			expect.objectContaining({
				kind: "register",
				op: "set",
				namespace: "op.state",
				key: prepared.attachment.runOperation!.value.operationId,
			}),
		]);
		expect(storage.committedTransactions[1].writes).toEqual([
			{
				kind: "register",
				op: "set",
				namespace: "pending.entry",
				key: followUp.entryId,
				value: { type: "message", payload: user("follow") },
			},
			expect.objectContaining({
				kind: "register",
				op: "set",
				namespace: "op.state",
				key: prepared.attachment.runOperation!.value.operationId,
			}),
		]);
		expect((await runtimeSession.cancelQueued(steer.entryId!)).outcome).toBe("cancelled");
		expect(storage.committedTransactions[2].writes).toEqual([
			expect.objectContaining({ kind: "register", op: "set", namespace: "op.state" }),
			{ kind: "register", op: "delete", namespace: "pending.entry", key: steer.entryId },
		]);
		const restored = await runtimeSession.refreshRuntimeAttachment();
		expect(restored.runState!.value.inbox).toEqual({ steer: [], followUp: [followUp.entryId], writes: [] });
		expect(restored.pendingEntries.has(steer.entryId!)).toBe(false);
		expect(restored.pendingEntries.get(followUp.entryId!)?.payload).toEqual(user("follow"));
		await closeAttachedRuntime(runtimeSession);
		await closeAttachedRuntime(prepared.runtimeSession);
	});

	it.each(["all", "one-at-a-time"] as const)(
		"places %s steering in FIFO parent order and leaves the exact remainder",
		async (mode) => {
			const prepared = await active();
			const ids = [];
			for (const text of ["a", "b", "c"])
				ids.push((await prepared.runtimeSession.queueOperationInput("steer", user(text))).entryId!);
			const current = await prepared.runtimeSession.refreshRuntimeAttachment();
			const operationId = current.runOperation!.value.operationId;
			const state = structuredClone(current.runState!.value);
			state.settings.steeringMode = mode;
			await prepared.storage.commit({
				writes: [
					{
						kind: "register",
						op: "set",
						namespace: "op.state",
						key: operationId,
						value: state as unknown as JsonValue,
					},
				],
			});
			const before = await prepared.runtimeSession.refreshRuntimeAttachment();
			const consume = mode === "all" ? ids : [ids[0]];
			const result = await prepared.runtimeSession.consumeOperationQueue({
				operationId,
				kind: "steer",
				entryIds: consume,
				expectedOperationStateSeq: before.runState!.seq,
			});
			expect(result.committed).toBe(true);
			for (const [index, entryId] of consume.entries())
				expect(result.attachment.entries.get(entryId)?.parentId).toBe(
					index === 0 ? current.mainLeaf.value : consume[index - 1],
				);
			expect(result.attachment.runState!.value.inbox.steer).toEqual(mode === "all" ? [] : ids.slice(1));
			expect(result.attachment.runState!.value.phase).toEqual({
				kind: "checkpoint",
				continuation: { kind: "need_assistant", overflowRecoveryUsed: false },
				triggerEntryId: consume.at(-1),
				skipInboxOnce: true,
			});
			for (const entryId of consume)
				expect(await prepared.storage.getRegister("pending.entry", entryId)).toBeUndefined();
			for (const entryId of ids.slice(consume.length))
				expect(await prepared.storage.getRegister("pending.entry", entryId)).toBeDefined();
			await closeAttachedRuntime(prepared.runtimeSession);
		},
	);

	it.each(["all", "one-at-a-time"] as const)(
		"commits the exact %s consume transaction and returned sequence mapping",
		async (mode) => {
			const delegate = new MemoryStorage();
			const prepared = await active(delegate);
			const storage = instrumentStorage(delegate);
			const runtimeSession = session(storage);
			await attachRuntime(runtimeSession, configuration);
			const ids = [
				(await runtimeSession.queueOperationInput("steer", user("first"))).entryId!,
				(await runtimeSession.queueOperationInput("steer", user("second"))).entryId!,
			];
			const before = await runtimeSession.refreshRuntimeAttachment();
			const operationId = before.runOperation!.value.operationId;
			const state = structuredClone(before.runState!.value);
			state.settings.steeringMode = mode;
			await delegate.commit({
				writes: [
					{
						kind: "register",
						op: "set",
						namespace: "op.state",
						key: operationId,
						value: state as unknown as JsonValue,
					},
				],
			});
			const current = await runtimeSession.refreshRuntimeAttachment();
			storage.committedTransactions.length = 0;
			const consumed = mode === "all" ? ids : ids.slice(0, 1);
			const result = await runtimeSession.consumeOperationQueue({
				operationId,
				kind: "steer",
				entryIds: consumed,
				expectedOperationStateSeq: current.runState!.seq,
			});
			expect(result.facts?.map((fact) => (fact.kind === "entry" ? fact.entry.id : fact.kind))).toEqual(consumed);
			const transaction = storage.committedTransactions[0];
			let parentId = current.mainLeaf.value;
			const expectedEntries = consumed.map((entryId, index) => {
				const write = {
					kind: "entry" as const,
					entry: {
						id: entryId,
						parentId,
						type: "message" as const,
						payload: user(index === 0 ? "first" : "second"),
					},
				};
				parentId = entryId;
				return write;
			});
			expect(transaction.writes).toEqual([
				...expectedEntries,
				...consumed.map((key) => ({ kind: "register", op: "delete", namespace: "pending.entry", key })),
				{ kind: "register", op: "set", namespace: "lane.leaf", key: "main", value: consumed.at(-1) },
				expect.objectContaining({ kind: "register", op: "set", namespace: "op.state", key: operationId }),
			]);
			const firstSeq = result.attachment.entries.get(consumed[0])!.seq;
			for (const [index, entryId] of consumed.entries())
				expect(result.attachment.entries.get(entryId)?.seq).toBe(firstSeq + index);
			expect(result.attachment.mainLeaf).toEqual({
				seq: firstSeq + consumed.length * 2,
				value: consumed.at(-1),
			});
			expect(result.attachment.runState!.seq).toBe(firstSeq + consumed.length * 2 + 1);
			expect(result.attachment.runState!.value.inbox.steer).toEqual(mode === "all" ? [] : [ids[1]]);
			await closeAttachedRuntime(runtimeSession);
			await closeAttachedRuntime(prepared.runtimeSession);
		},
	);

	it("planner prioritizes steer, skips it once for generation, and admits follow-up only at may_finish", async () => {
		const prepared = await active();
		const steer = await prepared.runtimeSession.queueOperationInput("steer", user("s"));
		const follow = await prepared.runtimeSession.queueOperationInput("followUp", user("f"));
		const current = await prepared.runtimeSession.refreshRuntimeAttachment();
		expect(planner(current)).toEqual({
			kind: "consume_queue",
			operationId: current.runOperation!.value.operationId,
			queue: "steer",
			entryIds: [steer.entryId],
		});
		const state = structuredClone(current.runState!.value);
		if (state.phase.kind !== "checkpoint") throw new Error("checkpoint expected");
		state.phase.skipInboxOnce = true;
		const modified = { ...current, runState: { ...current.runState!, value: state } };
		expect(planner(modified)?.kind).toBe("start_assistant_step");
		state.phase = {
			kind: "checkpoint",
			continuation: { kind: "may_finish", includeFinalAssistant: true },
			triggerEntryId: state.phase.triggerEntryId,
		};
		state.inbox.steer = [];
		expect(planner(modified)).toEqual({
			kind: "consume_queue",
			operationId: current.runOperation!.value.operationId,
			queue: "followUp",
			entryIds: [follow.entryId],
		});
		state.control = { status: "cancel_requested", requestedAt: 1, drainedSteer: [], drainedFollowUp: [] };
		expect(planner(modified)?.kind).toBe("finish_aborted_run");
		await closeAttachedRuntime(prepared.runtimeSession);
	});

	it.each([
		["follow-up before may_finish", "followUp", "follow-checkpoint", "all", [0]],
		["wrong queue kind", "followUp", "need", "all", [0]],
		["steer while skipInboxOnce", "steer", "skip", "all", [0, 1]],
		["more than one item in one-at-a-time mode", "steer", "need", "one-at-a-time", [0, 1]],
		["non-FIFO order", "steer", "need", "all", [1, 0]],
		["cancelled run", "steer", "cancelled", "all", [0, 1]],
	] as const)("makes a direct invalid queue transition write-free: %s", async (_name, kind, phase, mode, indices) => {
		const delegate = new MemoryStorage();
		const prepared = await active(delegate);
		const steerIds = [
			(await prepared.runtimeSession.queueOperationInput("steer", user("first"))).entryId!,
			(await prepared.runtimeSession.queueOperationInput("steer", user("second"))).entryId!,
		];
		const followId = (await prepared.runtimeSession.queueOperationInput("followUp", user("follow"))).entryId!;
		const before = await prepared.runtimeSession.refreshRuntimeAttachment();
		const operationId = before.runOperation!.value.operationId;
		const state = structuredClone(before.runState!.value);
		state.settings.steeringMode = mode;
		if (phase === "follow-checkpoint") state.inbox.steer = [];
		if (phase === "skip" && state.phase.kind === "checkpoint") state.phase.skipInboxOnce = true;
		if (phase === "cancelled")
			state.control = { status: "cancel_requested", requestedAt: 1, drainedSteer: [], drainedFollowUp: [] };
		await delegate.commit({
			writes: [
				{
					kind: "register",
					op: "set",
					namespace: "op.state",
					key: operationId,
					value: state as unknown as JsonValue,
				},
				...(phase === "follow-checkpoint"
					? steerIds.map((key) => ({
							kind: "register" as const,
							op: "delete" as const,
							namespace: "pending.entry",
							key,
						}))
					: []),
			],
		});
		const storage = instrumentStorage(delegate);
		const runtimeSession = session(storage);
		const current = await attachRuntime(runtimeSession, configuration);
		const available = kind === "steer" ? steerIds : [followId];
		const result = await runtimeSession.consumeOperationQueue({
			operationId,
			kind,
			entryIds: indices.map((index) => available[index]!),
			expectedOperationStateSeq: current.runState!.seq,
		});
		expect(result).toMatchObject({ committed: false, attachment: { runState: { seq: current.runState!.seq } } });
		expect(result).not.toHaveProperty("facts");
		expect(storage.committedTransactions).toHaveLength(0);
		expect((await delegate.getRegister("op.state", operationId))?.seq).toBe(current.runState!.seq);
		await closeAttachedRuntime(runtimeSession);
		await closeAttachedRuntime(prepared.runtimeSession);
	});

	it("commits the exact selector-backed plan", async () => {
		const prepared = await active();
		await prepared.runtimeSession.queueOperationInput("steer", user("first"));
		await prepared.runtimeSession.queueOperationInput("steer", user("second"));
		const current = await prepared.runtimeSession.refreshRuntimeAttachment();
		const action = planner(current);
		if (action?.kind !== "consume_queue") throw new Error("consume plan expected");
		const result = await prepared.runtimeSession.consumeOperationQueue({
			operationId: action.operationId,
			kind: action.queue,
			entryIds: action.entryIds,
			expectedOperationStateSeq: current.runState!.seq,
		});
		expect(result.committed).toBe(true);
		expect(result.attachment.runState!.value.inbox.steer).toEqual([]);
		await closeAttachedRuntime(prepared.runtimeSession);
	});

	it("first abort drains exact payloads in one state write, repeat is write-free, and drained cancellation is not_found", async () => {
		vi.spyOn(Date, "now").mockReturnValue(1234);
		const delegate = new MemoryStorage();
		const prepared = await active(delegate);
		const storage = instrumentStorage(delegate);
		const runtimeSession = session(storage);
		await attachRuntime(runtimeSession, configuration);
		const steer = await runtimeSession.queueOperationInput("steer", user("s"));
		const follow = await runtimeSession.queueOperationInput("followUp", user("f"));
		storage.committedTransactions.length = 0;
		const first = await runtimeSession.requestAbort(() => undefined);
		expect(first).toMatchObject({ status: "committed", drainedSteer: [user("s")], drainedFollowUp: [user("f")] });
		expect(storage.committedTransactions).toHaveLength(1);
		expect(storage.committedTransactions[0].writes).toEqual([
			expect.objectContaining({
				kind: "register",
				op: "set",
				namespace: "op.state",
				value: expect.objectContaining({
					control: {
						status: "cancel_requested",
						requestedAt: 1234,
						drainedSteer: [steer.entryId],
						drainedFollowUp: [follow.entryId],
					},
					inbox: { steer: [], followUp: [], writes: [] },
				}),
			}),
		]);
		const repeated = await runtimeSession.requestAbort(() => undefined);
		expect(repeated).toMatchObject({
			status: "already_requested",
			drainedSteer: [user("s")],
			drainedFollowUp: [user("f")],
		});
		expect(storage.committedTransactions).toHaveLength(1);
		expect((await runtimeSession.cancelQueued(steer.entryId!)).outcome).toBe("not_found");
		expect(await delegate.getRegister("pending.entry", steer.entryId!)).toBeDefined();
		await closeAttachedRuntime(runtimeSession);
		await closeAttachedRuntime(prepared.runtimeSession);
		vi.restoreAllMocks();
	});

	it("reopens active and drained queues and terminal cleanup deletes only operation ownership", async () => {
		const state = new MemoryStorageState();
		const first = await active(state.createStorage());
		const steer = await first.runtimeSession.queueOperationInput("steer", user("s"));
		const follow = await first.runtimeSession.queueOperationInput("followUp", user("f"));
		const next = await first.runtimeSession.nextRun(user("next"));
		await first.runtimeSession.requestAbort(() => undefined);
		const operationId = first.attachment.runOperation!.value.operationId;
		await closeAttachedRuntime(first.runtimeSession);
		const reopened = session(state.createStorage());
		const attachment = await attachRuntime(reopened, configuration);
		expect(attachment.runState!.value.control).toMatchObject({
			drainedSteer: [steer.entryId],
			drainedFollowUp: [follow.entryId],
		});
		expect([...attachment.pendingEntries.keys()]).toEqual([next.entryId, steer.entryId, follow.entryId]);
		const result = await reopened.finishRun({ operationId, expectedOperationStateSeq: attachment.runState!.seq });
		expect(result.status).toBe("committed");
		const persisted = state.createStorage();
		for (const entryId of [steer.entryId!, follow.entryId!])
			expect(await persisted.getRegister("pending.entry", entryId)).toBeUndefined();
		expect(await persisted.getRegister("pending.entry", next.entryId!)).toBeDefined();
		expect((await persisted.getRegister("lane.state", "main"))?.value).toEqual({
			currentOperationId: null,
			pendingNextRun: [next.entryId],
		});
		await persisted.close();
		await closeAttachedRuntime(reopened);
	});

	it.each(["active", "drained", "write"] as const)(
		"rejects a generated next-run id colliding with an %s operation queue without writing",
		async (kind) => {
			const delegate = new MemoryStorage();
			const prepared = await active(delegate);
			const queued =
				kind === "write"
					? { entryId: id() }
					: await prepared.runtimeSession.queueOperationInput("steer", user("reserved"));
			if (kind === "write")
				await installWrites(prepared, [
					{ id: queued.entryId!, value: jsonValue({ type: "custom", customType: "reserved" }) },
				]);
			if (kind === "drained") await prepared.runtimeSession.requestAbort(() => undefined);
			const storage = instrumentStorage(delegate);
			const runtimeSession = session(storage);
			await attachRuntime(runtimeSession, configuration);
			vi.spyOn(runtimeSession.idGenerator, "next").mockReturnValueOnce(queued.entryId!);
			await expect(runtimeSession.nextRun(user("collision"))).rejects.toMatchObject({ code: "storage" });
			expect(storage.committedTransactions).toEqual([]);
			await closeAttachedRuntime(runtimeSession);
			await closeAttachedRuntime(prepared.runtimeSession);
		},
	);

	it("rejects cross-list, cross-lane, missing, malformed, and materialized references on reopen", async () => {
		const cases = ["cross-list", "cross-lane", "missing", "malformed", "materialized"] as const;
		for (const kind of cases) {
			const durable = new MemoryStorageState();
			const prepared = await active(durable.createStorage());
			const queued = await prepared.runtimeSession.queueOperationInput("steer", user("q"));
			const attachment = await prepared.runtimeSession.refreshRuntimeAttachment();
			const operationId = attachment.runOperation!.value.operationId;
			const value = structuredClone(attachment.runState!.value) as RunState;
			const writes: Write[] = [];
			if (kind === "cross-list") value.inbox.followUp = [queued.entryId!];
			if (kind === "cross-lane") {
				const lane = structuredClone(attachment.laneState.value);
				lane.pendingNextRun = [queued.entryId!];
				writes.push({
					kind: "register",
					op: "set",
					namespace: "lane.state",
					key: "main",
					value: lane as unknown as JsonValue,
				});
			}
			if (kind === "missing")
				writes.push({ kind: "register", op: "delete", namespace: "pending.entry", key: queued.entryId! });
			if (kind === "malformed")
				writes.push({
					kind: "register",
					op: "set",
					namespace: "pending.entry",
					key: queued.entryId!,
					value: { type: "message" },
				});
			if (kind === "materialized")
				writes.push({
					kind: "entry",
					entry: {
						id: queued.entryId!,
						parentId: null,
						type: "message",
						payload: user("q") as unknown as JsonValue,
					},
				});
			writes.unshift({
				kind: "register",
				op: "set",
				namespace: "op.state",
				key: operationId,
				value: value as unknown as JsonValue,
			});
			await prepared.storage.commit({ writes });
			await closeAttachedRuntime(prepared.runtimeSession);
			const reopened = session(durable.createStorage());
			await expect(attachRuntime(reopened, configuration)).rejects.toMatchObject({ code: "corruption" });
			await reopened.close();
		}
	});

	it.each(["active-steer", "active-followUp", "drained-steer", "drained-followUp", "bad-id"] as const)(
		"rejects duplicate or malformed operation queue ownership: %s",
		async (kind) => {
			const durable = new MemoryStorageState();
			const prepared = await active(durable.createStorage());
			const queued = await prepared.runtimeSession.queueOperationInput(
				kind.includes("followUp") ? "followUp" : "steer",
				user("q"),
			);
			if (kind.startsWith("drained")) await prepared.runtimeSession.requestAbort(() => undefined);
			const attachment = await prepared.runtimeSession.refreshRuntimeAttachment();
			const value = structuredClone(attachment.runState!.value);
			if (kind === "active-steer") value.inbox.steer.push(queued.entryId!);
			if (kind === "active-followUp") value.inbox.followUp.push(queued.entryId!);
			if (kind === "drained-steer" && value.control.status === "cancel_requested")
				value.control.drainedSteer.push(queued.entryId!);
			if (kind === "drained-followUp" && value.control.status === "cancel_requested")
				value.control.drainedFollowUp.push(queued.entryId!);
			if (kind === "bad-id") value.inbox.steer = ["not-a-uuid"];
			await prepared.storage.commit({
				writes: [
					{
						kind: "register",
						op: "set",
						namespace: "op.state",
						key: attachment.runOperation!.value.operationId,
						value: value as unknown as JsonValue,
					},
				],
			});
			await closeAttachedRuntime(prepared.runtimeSession);
			const reopened = session(durable.createStorage());
			await expect(attachRuntime(reopened, configuration)).rejects.toMatchObject({ code: "corruption" });
			await reopened.close();
		},
	);
});
