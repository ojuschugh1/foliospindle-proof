import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { utf8Encode } from "../src/encoding.ts";
import { sha256Hex } from "../src/hashing.ts";
import { forAll } from "./gen.ts";

const FIXTURE_NAMES = ["attachment.bin", "fixture-a.md", "fixture-b.md"];

const fixtureUrl = (name: string): URL => new URL(`../fixtures/${name}`, import.meta.url);

const parseSha256Sums = (text: string): Map<string, string> => {
	const sums = new Map<string, string>();
	for (const line of text.split("\n")) {
		const [hash, name] = line.split("  ");
		if (hash !== undefined && name !== undefined) {
			sums.set(name, hash);
		}
	}
	return sums;
};

test("foliospindle-proof Property 4: SHA-256 agrees with the reference implementation", async () => {
	await forAll(100, async (g) => {
		const bytes = g.bytes(g.int(0, 70000));
		assert.equal(await sha256Hex(bytes), createHash("sha256").update(bytes).digest("hex"));
	});
});

test("sha256Hex matches the NIST vector for abc", async () => {
	assert.equal(
		await sha256Hex(utf8Encode("abc")),
		"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
	);
});

test("sha256Hex matches the NIST vector for the 56-byte message", async () => {
	assert.equal(
		await sha256Hex(utf8Encode("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")),
		"248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
	);
});

test("sha256Hex matches SHA256SUMS for every committed fixture", async () => {
	const sums = parseSha256Sums(readFileSync(fixtureUrl("SHA256SUMS"), "utf8"));
	assert.equal(sums.size, FIXTURE_NAMES.length);
	for (const name of FIXTURE_NAMES) {
		assert.equal(await sha256Hex(readFileSync(fixtureUrl(name))), sums.get(name), name);
	}
});
