import assert from "node:assert/strict";
import { test } from "node:test";
import type { PlatformClass } from "../src/context.ts";
import {
	RECEIPT_FORMAT_VERSION,
	RECEIPT_OBJECT_NAMES,
	type Receipt,
	type ReceiptObjectName,
	formatReceipt,
	isCrossInstallation,
	parseReceipt,
} from "../src/receipt.ts";
import { forAll, type Gen } from "./gen.ts";

type Json = Record<string, unknown>;
type Mutation = (root: Json, objects: Json[]) => void;

const HEX_LOWER = "0123456789abcdef";
const HEX_MIXED = "0123456789abcdefABCDEF";
const PLATFORM_CLASSES: readonly PlatformClass[] = ["macos", "ios", "android", "desktop-other", "unknown"];

const VALID: Receipt = {
	formatVersion: 1,
	sdkVersion: "0.1.1",
	platformLabel: "macos",
	uploadedAt: "2026-10-12T14:23:07.123Z",
	objects: [
		{ name: "fixture-a.md", bytes: 6144, sha256: "0a".repeat(32), objectId: "0F1e".repeat(4), uploadMs: 1200 },
		{ name: "fixture-b.md", bytes: 12288, sha256: "1b".repeat(32), objectId: "abcdef", uploadMs: 1800 },
		{ name: "attachment.bin", bytes: 262144, sha256: "2c".repeat(32), objectId: "ABCDEF0123", uploadMs: 2500 },
		{ name: "probe", bytes: 32, sha256: "3d".repeat(32), objectId: "7", uploadMs: 400 },
	],
};

const entry = (objects: Json[], index: number): Json => objects[index] as Json;

const MUTATIONS: [string, Mutation][] = [
	["formatVersion", (root) => { root.formatVersion = 2; }],
	["sdkVersion", (root) => { root.sdkVersion = ""; }],
	["platformLabel", (root) => { root.platformLabel = "linux"; }],
	["uploadedAt", (root) => { root.uploadedAt = "2026-10-12"; }],
	["objects", (root, objects) => { objects.pop(); }],
	["objects[1].name", (root, objects) => { entry(objects, 1).name = entry(objects, 0).name; }],
	["objects[0].bytes", (root, objects) => { entry(objects, 0).bytes = -1; }],
	["objects[0].sha256", (root, objects) => { entry(objects, 0).sha256 = "0A".repeat(32); }],
	["objects[0].objectId", (root, objects) => { entry(objects, 0).objectId = "xyz"; }],
	["objects[0].uploadMs", (root, objects) => { entry(objects, 0).uploadMs = 1.5; }],
	["note", (root) => { root.note = 1; }],
	["objects[2].extra", (root, objects) => { entry(objects, 2).extra = 1; }],
];

function shuffledNames(g: Gen): ReceiptObjectName[] {
	const pool = [...RECEIPT_OBJECT_NAMES];
	const names: ReceiptObjectName[] = [];
	while (pool.length > 0) {
		names.push(...pool.splice(g.int(0, pool.length - 1), 1));
	}
	return names;
}

function genSdkVersion(g: Gen): string {
	const version = Array.from({ length: g.int(2, 4) }, () => String(g.int(0, 20))).join(".");
	return g.bool() ? `${version}-rc.${g.int(0, 9)}` : version;
}

const genInstant = (g: Gen): string => new Date(g.int(0, 2 ** 31) * 1000 + g.int(0, 999)).toISOString();

function genReceipt(g: Gen): Receipt {
	return {
		formatVersion: RECEIPT_FORMAT_VERSION,
		sdkVersion: genSdkVersion(g),
		platformLabel: g.pick(PLATFORM_CLASSES),
		uploadedAt: genInstant(g),
		objects: shuffledNames(g).map((name) => ({
			name,
			bytes: g.int(0, 2 ** 31),
			sha256: g.string(HEX_LOWER, 64),
			objectId: g.string(HEX_MIXED, g.int(1, 128)),
			uploadMs: g.int(0, 10 ** 7),
		})),
	};
}

function mutated(edit: Mutation): string {
	const root = JSON.parse(formatReceipt(VALID)) as Json;
	edit(root, root.objects as Json[]);
	return JSON.stringify(root);
}

function failurePath(text: string): string {
	const result = parseReceipt(text);
	assert.equal(result.ok, false, text);
	return result.path;
}

test("foliospindle-proof Property 3: Receipt round trip", async () => {
	await forAll(200, (g) => {
		const receipt = genReceipt(g);
		const text = formatReceipt(receipt);
		const parsed = parseReceipt(text);
		if (!parsed.ok) {
			assert.fail(`rejected at ${parsed.path} (${parsed.reason}): ${text}`);
		}
		assert.deepEqual(parsed.value, receipt);
		assert.equal(formatReceipt(parsed.value), text);
	});
});

test("the fixed receipt parses back to itself", () => {
	assert.deepEqual(parseReceipt(formatReceipt(VALID)), { ok: true, value: VALID });
});

test("parseReceipt names the first invalid field", () => {
	for (const [path, edit] of MUTATIONS) {
		assert.equal(failurePath(mutated(edit)), path);
	}
	assert.equal(failurePath("{ not json"), "");
	assert.equal(failurePath("[]"), "");
});

test("isCrossInstallation is true exactly when the label differs from the current class", () => {
	for (const label of PLATFORM_CLASSES) {
		for (const cls of PLATFORM_CLASSES) {
			assert.equal(isCrossInstallation({ ...VALID, platformLabel: label }, cls), label !== cls, `${label} on ${cls}`);
		}
	}
});
