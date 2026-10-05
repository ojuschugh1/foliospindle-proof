import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { utf8Decode } from "../src/encoding.ts";
import {
	ATTACHMENT_FIXTURE,
	FIXTURE_NAMES,
	type FixtureName,
	MARKDOWN_FIXTURES,
	committedHashes,
	fixtureBytes,
	formatSha256Sums,
	parseSha256Sums,
} from "../src/fixtures.ts";
import { sha256Hex } from "../src/hashing.ts";

const HASH_A = "0a".repeat(32);
const HASH_B = "1b".repeat(32);

const MALFORMED: [string, string][] = [
	[`${"0a".repeat(31)}0  fixture-a.md\n`, "line 1"],
	[`${HASH_A.toUpperCase()}  fixture-a.md\n`, "line 1"],
	[`${HASH_A} fixture-a.md\n`, "line 1"],
	[`${HASH_A}  fixture a.md\n`, "line 1"],
	[`${HASH_A}  fixture-a.md\n${HASH_B}  fixture-a.md\n`, "line 2"],
	[`${HASH_A}  fixture-a.md\n\n${HASH_B}  fixture-b.md\n`, "line 2"],
];

const fixtureUrl = (name: string): URL => new URL(`../fixtures/${name}`, import.meta.url);

const SHA256SUMS_TEXT = readFileSync(fixtureUrl("SHA256SUMS"), "utf8");

const diskBytes = (name: FixtureName): Buffer => readFileSync(fixtureUrl(name));

const diskHash = (name: FixtureName): string => createHash("sha256").update(diskBytes(name)).digest("hex");

const hasNonAscii = (text: string): boolean => [...text].some((ch) => (ch.codePointAt(0) ?? 0) >= 0x80);

function parsedSha256Sums(): Record<string, string> {
	const parsed = parseSha256Sums(SHA256SUMS_TEXT);
	if (!parsed.ok) {
		assert.fail(`SHA256SUMS rejected at ${parsed.path} (${parsed.reason})`);
	}
	return parsed.value;
}

function failurePath(text: string): string {
	const result = parseSha256Sums(text);
	assert.equal(result.ok, false, text);
	return result.path;
}

function decoded(name: FixtureName): string {
	const text = utf8Decode(fixtureBytes(name));
	if (text === null) {
		assert.fail(`${name} is not valid UTF-8`);
	}
	return text;
}

test("the committed SHA256SUMS parses and formats back to the same text", () => {
	assert.equal(formatSha256Sums(parsedSha256Sums()), SHA256SUMS_TEXT);
});

test("parseSha256Sums names the first malformed line", () => {
	for (const [text, path] of MALFORMED) {
		assert.equal(failurePath(text), path);
	}
});

test("an empty SHA256SUMS has no entries", () => {
	assert.equal(formatSha256Sums({}), "");
	assert.deepEqual(parseSha256Sums(""), { ok: true, value: {} });
});

test("committedHashes equals SHA256SUMS read from disk", () => {
	const parsed = parsedSha256Sums();
	assert.deepEqual(Object.keys(parsed).sort(), [...FIXTURE_NAMES].sort());
	assert.deepEqual(committedHashes(), parsed);
});

test("fixtureBytes returns the bytes of the file on disk and caches them", () => {
	for (const name of FIXTURE_NAMES) {
		assert.equal(Buffer.compare(fixtureBytes(name), diskBytes(name)), 0, name);
		assert.equal(fixtureBytes(name), fixtureBytes(name), name);
	}
});

test("sha256Hex of every fixture equals the committed hash and the hash of the file on disk", async () => {
	const hashes = committedHashes();
	for (const name of FIXTURE_NAMES) {
		const hash = await sha256Hex(fixtureBytes(name));
		assert.equal(hash, hashes[name], name);
		assert.equal(hash, diskHash(name), name);
	}
});

test("the Markdown fixtures are 1,024 to 65,536 bytes each and differ in size", () => {
	const sizes = MARKDOWN_FIXTURES.map((name) => fixtureBytes(name).length);
	for (const size of sizes) {
		assert.ok(size >= 1024 && size <= 65536, `${size} bytes`);
	}
	assert.equal(new Set(sizes).size, sizes.length);
});

test("the attachment fixture is 131,072 to 1,048,576 bytes", () => {
	const size = fixtureBytes(ATTACHMENT_FIXTURE).length;
	assert.ok(size >= 131072 && size <= 1048576, `${size} bytes`);
});

test("fixture-b.md contains a code point at or above U+0080 and fixture-a.md does not", () => {
	assert.equal(hasNonAscii(decoded("fixture-b.md")), true);
	assert.equal(hasNonAscii(decoded("fixture-a.md")), false);
});

test("MARKDOWN_FIXTURES and ATTACHMENT_FIXTURE name the committed fixtures", () => {
	assert.deepEqual(MARKDOWN_FIXTURES, ["fixture-a.md", "fixture-b.md"]);
	assert.equal(ATTACHMENT_FIXTURE, "attachment.bin");
});
