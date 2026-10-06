import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS, validateIndexerUrl } from "../src/settings.ts";

const ACCEPTED: [string, string][] = [
	["https://sia.storage", "https://sia.storage"],
	["https://example.org/path", "https://example.org/path"],
	["  https://sia.storage\n", "https://sia.storage"],
];

const REJECTED: [string, string][] = [
	["http://sia.storage", "only https URLs are accepted"],
	["sia.storage", "not an absolute URL"],
	["", "empty"],
	["   ", "empty"],
	["https://", "not an absolute URL"],
	["ftp://x", "only https URLs are accepted"],
];

test("validateIndexerUrl accepts https URLs and trims surrounding whitespace", () => {
	for (const [value, url] of ACCEPTED) {
		assert.deepEqual(validateIndexerUrl(value), { ok: true, url }, JSON.stringify(value));
	}
});

test("validateIndexerUrl rejects non-https and malformed values with a reason", () => {
	for (const [value, reason] of REJECTED) {
		const result = validateIndexerUrl(value);
		assert.equal(result.ok, false, JSON.stringify(value));
		assert.ok(result.reason.length > 0, JSON.stringify(value));
		assert.deepEqual(result, { ok: false, reason }, JSON.stringify(value));
	}
});

test("DEFAULT_SETTINGS carries the design values and a valid indexer URL", () => {
	assert.deepEqual(DEFAULT_SETTINGS, { indexerUrl: "https://sia.storage", receipt: null });
	assert.equal(validateIndexerUrl(DEFAULT_SETTINGS.indexerUrl).ok, true);
});
