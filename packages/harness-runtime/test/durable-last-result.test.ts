import { describe, expect, it } from "vitest";
import { decodeLaneLastResult, encodeLaneLastResult, type LaneLastResult } from "../src/durable.ts";
import { id } from "./fixtures.ts";

describe("LaneLastResult codec", () => {
	const value = (): LaneLastResult => {
		const finalAssistantEntryId = id();
		return {
			operationId: id(),
			kind: "run",
			outcome: "completed",
			leafId: finalAssistantEntryId,
			finalAssistantEntryId,
			runCompletion: "assistant",
		};
	};

	it("round-trips the exact completed-run shape and detaches encoding", () => {
		const candidate = value();
		const encoded = encodeLaneLastResult(candidate);
		expect(encoded).toEqual(candidate);
		expect(encoded).not.toBe(candidate);
		candidate.operationId = id();
		expect(decodeLaneLastResult(encoded).operationId).not.toBe(candidate.operationId);
	});

	it.each([
		["extra field", (candidate: LaneLastResult) => ({ ...candidate, extra: true })],
		["missing field", ({ runCompletion: _, ...candidate }: LaneLastResult) => candidate],
		["invalid operation UUIDv7", (candidate: LaneLastResult) => ({ ...candidate, operationId: "not-a-uuid" })],
		["invalid leaf UUIDv7", (candidate: LaneLastResult) => ({ ...candidate, leafId: "not-a-uuid" })],
		["invalid final UUIDv7", (candidate: LaneLastResult) => ({ ...candidate, finalAssistantEntryId: "not-a-uuid" })],
		["unequal leaf and final assistant", (candidate: LaneLastResult) => ({ ...candidate, leafId: id() })],
	])("rejects %s", (_label, mutate) => {
		expect(() => decodeLaneLastResult(mutate(value()))).toThrowError(expect.objectContaining({ code: "corruption" }));
	});
});
