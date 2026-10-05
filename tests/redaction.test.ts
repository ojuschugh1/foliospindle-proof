import assert from "node:assert/strict";
import { test } from "node:test";
import { toHex } from "../src/encoding.ts";
import { createRedactor, encodingsOf } from "../src/redaction.ts";
import { forAll, type Gen } from "./gen.ts";

const HOST_ALPHABET = "0123456789abcdefABCDEFghijklmnopqrstuvwxyzGHIJKLMNOPQRSTUVWXYZ+/-_= .,;:!?\"'()[]{}\n\t";
const REPLACEMENT = "[redacted]";
const SEED_A = Uint8Array.from({ length: 32 }, (_, i) => i);
const SEED_B = Uint8Array.from({ length: 32 }, (_, i) => 255 - i);

const flipCase = (g: Gen, text: string): string => {
	let out = "";
	for (const ch of text) {
		out += g.bool() ? ch.toUpperCase() : ch.toLowerCase();
	}
	return out;
};

const insertAt = (host: string, insertion: string, at: number): string =>
	host.slice(0, at) + insertion + host.slice(at);

function expectClean(text: string, seed: Uint8Array, label: string): void {
	for (const enc of encodingsOf(seed)) {
		assert.equal(text.includes(enc), false, `${label} contains ${enc}: ${text}`);
	}
	assert.equal(text.toLowerCase().includes(toHex(seed)), false, `${label} contains the hex case-insensitively: ${text}`);
}

test("foliospindle-proof Property 2: Redaction removes every seed encoding", async () => {
	await forAll(200, (g) => {
		const seed = g.bytes(32);
		const hex = toHex(seed);
		const encodings = encodingsOf(seed);
		const redactor = createRedactor();
		redactor.add(seed);
		const host = g.string(HOST_ALPHABET, g.int(0, 200));
		expectClean(host, seed, "host");
		assert.equal(redactor.redact(host), host, "host without an encoding changed");
		let t = host;
		for (let i = g.int(1, 3); i > 0; i -= 1) {
			const variant = g.pick(encodings);
			const inserted = variant.toLowerCase() === hex ? flipCase(g, variant) : variant;
			t = insertAt(t, inserted, g.int(0, t.length));
		}
		const r = redactor.redact(t);
		expectClean(r, seed, "redacted text");
		assert.equal(redactor.redact(r), r, `second application changed ${r}`);
		assert.ok(r.includes(REPLACEMENT), `no replacement in ${r}`);
	});
});

test("encodingsOf returns the six encodings of a 32-byte seed", () => {
	assert.deepEqual(
		encodingsOf(SEED_A).map((enc) => enc.length),
		[64, 64, 44, 43, 44, 43],
	);
});

test("back-to-back hex copies become repeated replacements", () => {
	const redactor = createRedactor();
	redactor.add(SEED_A);
	const hex = toHex(SEED_A);
	assert.equal(redactor.redact(hex + hex + hex.toUpperCase()), REPLACEMENT.repeat(3));
});

test("a second added seed is redacted in every encoding", () => {
	const redactor = createRedactor();
	redactor.add(SEED_A);
	redactor.add(SEED_B);
	for (const enc of [...encodingsOf(SEED_A), ...encodingsOf(SEED_B)]) {
		assert.equal(redactor.redact(`before ${enc} after`), `before ${REPLACEMENT} after`);
	}
});

test("a redactor without seeds returns its input unchanged", () => {
	const text = encodingsOf(SEED_A).join(" ");
	assert.equal(createRedactor().redact(text), text);
});
