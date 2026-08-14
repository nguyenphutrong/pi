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

	it("allows a custom lane leaf after the completed or failed run's final assistant", () => {
		const completed = { ...value(), leafId: id() };
		const failed: LaneLastResult = {
			operationId: id(),
			kind: "run",
			outcome: "failed",
			leafId: id(),
			finalAssistantEntryId: id(),
			error: { code: "provider_interrupted", message: "Provider outcome unknown after interruption" },
		};
		expect(decodeLaneLastResult(encodeLaneLastResult(completed))).toEqual(completed);
		expect(decodeLaneLastResult(encodeLaneLastResult(failed))).toEqual(failed);
	});

	it("round-trips the exact failed-run shape without runCompletion", () => {
		const finalAssistantEntryId = id();
		const candidate: LaneLastResult = {
			operationId: id(),
			kind: "run",
			outcome: "failed",
			leafId: finalAssistantEntryId,
			finalAssistantEntryId,
			error: { code: "provider_interrupted", message: "Provider outcome unknown after interruption" },
		};
		expect(decodeLaneLastResult(encodeLaneLastResult(candidate))).toEqual(candidate);
		for (const invalid of [
			{ ...candidate, runCompletion: "assistant" },
			{ ...candidate, error: { ...candidate.error, extra: true } },
			{ ...candidate, error: { code: 1, message: candidate.error.message } },
		])
			expect(() => decodeLaneLastResult(invalid)).toThrowError(expect.objectContaining({ code: "corruption" }));
	});

	it.each([false, true])("round-trips aborted with final assistant present: %s", (withFinalAssistant) => {
		const candidate: LaneLastResult = {
			operationId: id(),
			kind: "run",
			outcome: "aborted",
			leafId: id(),
			...(withFinalAssistant ? { finalAssistantEntryId: id() } : {}),
		};
		expect(decodeLaneLastResult(encodeLaneLastResult(candidate))).toEqual(candidate);
		if (withFinalAssistant) expect(candidate.leafId).not.toBe(candidate.finalAssistantEntryId);
	});

	it("rejects non-exact or invalid aborted results", () => {
		const candidate = {
			operationId: id(),
			kind: "run",
			outcome: "aborted",
			leafId: id(),
			finalAssistantEntryId: id(),
		} as const;
		for (const invalid of [
			{ ...candidate, extra: true },
			{ ...candidate, runCompletion: "assistant" },
			{ ...candidate, operationId: "bad" },
			{ ...candidate, leafId: "bad" },
			{ ...candidate, finalAssistantEntryId: "bad" },
		])
			expect(() => decodeLaneLastResult(invalid)).toThrowError(expect.objectContaining({ code: "corruption" }));
	});

	it.each([
		["extra field", (candidate: LaneLastResult) => ({ ...candidate, extra: true })],
		["missing field", ({ runCompletion: _, ...candidate }: LaneLastResult) => candidate],
		["invalid operation UUIDv7", (candidate: LaneLastResult) => ({ ...candidate, operationId: "not-a-uuid" })],
		["invalid leaf UUIDv7", (candidate: LaneLastResult) => ({ ...candidate, leafId: "not-a-uuid" })],
		["invalid final UUIDv7", (candidate: LaneLastResult) => ({ ...candidate, finalAssistantEntryId: "not-a-uuid" })],
	])("rejects %s", (_label, mutate) => {
		expect(() => decodeLaneLastResult(mutate(value()))).toThrowError(expect.objectContaining({ code: "corruption" }));
	});
});
