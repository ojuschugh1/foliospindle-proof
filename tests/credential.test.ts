import assert from "node:assert/strict";
import { test } from "node:test";
import { SECRET_ID, clearSeed, readSeed, storeSeed } from "../src/credential.ts";
import { toBase64Url } from "../src/encoding.ts";
import { FakeSecretStore, TEST_SEED } from "./fakes.ts";

const OTHER_SEED = Uint8Array.from({ length: 32 }, (_, i) => 255 - i);
const SHORT_SEED = TEST_SEED.subarray(0, 31);
const LONG_SEED = Uint8Array.from({ length: 33 }, (_, i) => i);

function storeWith(value: string): FakeSecretStore {
	const store = new FakeSecretStore();
	store.setSecret(SECRET_ID, value);
	return store;
}

test("SECRET_ID contains the plugin id", () => {
	assert.ok(SECRET_ID.includes("foliospindle-proof"));
});

test("storeSeed then readSeed returns the same bytes", () => {
	const store = new FakeSecretStore();
	storeSeed(store, TEST_SEED);
	assert.equal(store.values.get(SECRET_ID), toBase64Url(TEST_SEED, false));
	assert.deepEqual(readSeed(store), TEST_SEED);
});

test("storeSeed twice keeps only the second seed", () => {
	const store = new FakeSecretStore();
	storeSeed(store, TEST_SEED);
	storeSeed(store, OTHER_SEED);
	assert.deepEqual(readSeed(store), OTHER_SEED);
	assert.deepEqual(store.listSecrets(), [SECRET_ID]);
});

test("readSeed is null for a missing id and writes nothing", () => {
	const store = new FakeSecretStore();
	assert.equal(readSeed(store), null);
	assert.deepEqual(store.calls, [`get:${SECRET_ID}`]);
});

test("readSeed is null for an empty value", () => {
	assert.equal(readSeed(storeWith("")), null);
});

test("readSeed is null for a value that is not base64url", () => {
	assert.equal(readSeed(storeWith("!!!")), null);
});

test("readSeed is null for a 31-byte and a 33-byte seed", () => {
	assert.equal(readSeed(storeWith(toBase64Url(SHORT_SEED, false))), null);
	assert.equal(readSeed(storeWith(toBase64Url(LONG_SEED, false))), null);
});

test("clearSeed with a stored seed reports true and leaves the empty string", () => {
	const store = new FakeSecretStore();
	storeSeed(store, TEST_SEED);
	assert.equal(clearSeed(store), true);
	assert.equal(store.values.get(SECRET_ID), "");
	assert.deepEqual(store.listSecrets(), [SECRET_ID]);
	assert.equal(readSeed(store), null);
});

test("clearSeed on an empty store reports false and leaves the empty string", () => {
	const store = new FakeSecretStore();
	assert.equal(clearSeed(store), false);
	assert.equal(store.values.get(SECRET_ID), "");
	assert.equal(readSeed(store), null);
});
