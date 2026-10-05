import assert from "node:assert/strict";
import { test } from "node:test";
import {
	decodeBase64,
	fromBase64Url,
	fromHex,
	toBase64,
	toBase64Url,
	toHex,
	utf8Decode,
	utf8Encode,
} from "../src/encoding.ts";
import { forAll } from "./gen.ts";

function expectBytes(actual: Uint8Array | null, expected: Uint8Array, label: string): void {
	assert.ok(actual !== null, `${label} decoded to null`);
	assert.deepEqual(actual, expected, `${label} did not round trip`);
}

test("foliospindle-proof Property 7: Encoding round trips", async () => {
	await forAll(200, (g) => {
		const b = g.bytes(g.bool() ? g.int(0, 8) : g.int(0, 256));
		const hex = toHex(b);
		expectBytes(fromBase64Url(toBase64Url(b, false)), b, `unpadded base64url of ${hex}`);
		expectBytes(fromBase64Url(toBase64Url(b, true)), b, `padded base64url of ${hex}`);
		expectBytes(decodeBase64(toBase64(b, true)), b, `padded base64 of ${hex}`);
		expectBytes(fromHex(hex), b, `lowercase hex ${hex}`);
		expectBytes(fromHex(hex.toUpperCase()), b, `uppercase hex ${hex}`);
	});
});

test("fromHex returns null on malformed input", () => {
	assert.equal(fromHex("zz"), null);
	assert.equal(fromHex("abc"), null);
	assert.equal(fromHex("0g"), null);
});

test("fromBase64Url returns null on malformed input", () => {
	assert.equal(fromBase64Url("A"), null);
	assert.equal(fromBase64Url("QQ="), null);
	assert.equal(fromBase64Url("+/8="), null);
	assert.equal(fromBase64Url("QUJ D"), null);
});

test("utf8Decode returns null on an invalid byte sequence", () => {
	const text = "h\u00e9llo \u65e5\u672c";
	assert.equal(utf8Decode(new Uint8Array([0xff])), null);
	assert.equal(utf8Decode(utf8Encode(text)), text);
});
