import type { Entry } from "@nguyenphutrong/pi-session-storage";
import { describe, expect, it } from "vitest";
import { decodeEntry, decodePendingEntry, encodePendingEntry, type PendingEntry } from "../src/codec.ts";
import { id, user } from "./fixtures.ts";

function pending(value: unknown): PendingEntry {
	return value as PendingEntry;
}

function stored(value: unknown): Entry {
	return value as Entry;
}

describe("mixed entry codecs", () => {
	it("round-trips the exact pending union and preserves absent custom payload versus null", () => {
		const message = user("hello");
		const cases: PendingEntry[] = [
			{ type: "message", payload: message },
			{ type: "custom", customType: "absent" },
			{ type: "custom", customType: "null", payload: null },
		];
		for (const candidate of cases) {
			const encoded = encodePendingEntry(candidate);
			const decoded = decodePendingEntry(encoded);
			expect(decoded).toEqual(candidate);
			expect(Object.hasOwn(decoded, "payload")).toBe(Object.hasOwn(candidate, "payload"));
			expect(Object.isFrozen(decoded)).toBe(true);
		}

		const mutable = { type: "custom" as const, customType: "nested", payload: { nested: { value: 1 } } };
		const encoded = encodePendingEntry(mutable);
		mutable.payload.nested.value = 2;
		const decoded = decodePendingEntry(encoded);
		if (decoded.type !== "custom" || typeof decoded.payload !== "object" || decoded.payload === null)
			throw new Error("custom payload missing");
		(decoded.payload as { nested: { value: number } }).nested.value = 3;
		expect(decodePendingEntry(encoded)).toEqual({
			type: "custom",
			customType: "nested",
			payload: { nested: { value: 1 } },
		});
	});

	it.each([
		["unknown field", { type: "custom", customType: "x", extra: true }],
		["wrong discriminant", { type: "unknown", customType: "x" }],
		["missing message payload", { type: "message" }],
		["malformed message", { type: "message", payload: { role: "user" } }],
		["custom non-JSON", { type: "custom", customType: "x", payload: { value: undefined } }],
	])("rejects malformed pending decode: %s", (_label, candidate) => {
		expect(() => decodePendingEntry(candidate)).toThrow(expect.objectContaining({ code: "corruption" }));
	});

	it.each([
		["unknown field", { type: "custom", customType: "x", extra: true }],
		["wrong discriminant", { type: "unknown", customType: "x" }],
		["missing message payload", { type: "message" }],
		[
			"custom cyclic",
			(() => {
				const value: Record<string, unknown> = {};
				value.self = value;
				return { type: "custom", customType: "x", payload: value };
			})(),
		],
	])("rejects malformed pending encode: %s", (_label, candidate) => {
		expect(() => encodePendingEntry(pending(candidate))).toThrow(expect.objectContaining({ code: "invalid_query" }));
	});

	it("decodes committed custom data detached and preserves absent versus null", () => {
		const base = { id: id(), parentId: null, seq: 1, timestamp: 2, type: "custom" as const, customType: "note" };
		const absent = decodeEntry(base);
		const explicitNull = decodeEntry({ ...base, id: id(), payload: null });
		expect(Object.hasOwn(absent, "data")).toBe(false);
		expect(Object.hasOwn(explicitNull, "data")).toBe(true);
		expect(explicitNull).toHaveProperty("data", null);
		const payload = { nested: { value: 1 } };
		const decoded = decodeEntry({ ...base, id: id(), payload });
		payload.nested.value = 2;
		if (decoded.type === "custom") (decoded.data as { nested: { value: number } }).nested.value = 3;
		expect(decodeEntry({ ...base, id: id(), payload: { nested: { value: 1 } } })).toMatchObject({
			data: { nested: { value: 1 } },
		});
	});

	it.each([
		["empty type", { customType: "" }],
		["NUL type", { customType: "bad\0type" }],
		["non-JSON payload", { customType: "x", payload: { bad: undefined } }],
	])("rejects malformed committed custom entry: %s", (_label, override) => {
		expect(() =>
			decodeEntry(stored({ id: id(), parentId: null, seq: 1, timestamp: 2, type: "custom", ...override })),
		).toThrow(expect.objectContaining({ code: "corruption" }));
	});
});
