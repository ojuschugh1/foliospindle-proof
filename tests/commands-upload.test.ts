import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { FINALIZE_MISMATCH_NOTICE, RECEIPT_TITLE, UPLOAD_COMPLETE_NOTICE, type UploadResult, runUpload } from "../src/commands/upload.ts";
import { readSeed, storeSeed } from "../src/credential.ts";
import { FIXTURE_NAMES, committedHashes, fixtureBytes } from "../src/fixtures.ts";
import { RECEIPT_OBJECT_NAMES, type Receipt, type ReceiptObject, type ReceiptObjectName, formatReceipt, parseReceipt } from "../src/receipt.ts";
import type { CommandRecord } from "../src/records.ts";
import { DEFAULT_SETTINGS } from "../src/settings.ts";
import { EPOCH_ISO, FakeObject, FakeSdk, type Harness, type HarnessOverrides, TEST_SEED, fakeContext, recordPaths } from "./fakes.ts";

interface FailureCase {
	failure: string;
	call: string;
	key: string;
	label: string;
	failed: readonly ReceiptObjectName[];
	pinned: number;
	callCount: number;
}

const NO_CREDENTIAL_NOTICE = "No valid credential is stored. Run Connect to indexer.";
const PROBE_PATTERN = /^probe-\d{4}-\d{2}-\d{2}T[\d:.]+Z-[0-9a-f]{16}$/;
const FULL_CALLS = ["uploadPacked", "remaining", "add", "add", "finalize", "pin", "pin", "upload", "pin", "upload", "pin"];
const RECEIPT_KEYS = ["formatVersion", "objects", "platformLabel", "sdkVersion", "uploadedAt"];
const RECEIPT_OBJECT_KEYS = ["bytes", "name", "objectId", "sha256", "uploadMs"];

const PREVIOUS_RECEIPT: Receipt = {
	formatVersion: 1,
	sdkVersion: "0.1.0",
	platformLabel: "ios",
	uploadedAt: "2026-10-11T09:00:00.000Z",
	objects: [
		{ name: "fixture-a.md", bytes: 6203, sha256: "0a".repeat(32), objectId: "aa01", uploadMs: 1200 },
		{ name: "fixture-b.md", bytes: 12222, sha256: "1b".repeat(32), objectId: "aa02", uploadMs: 1800 },
		{ name: "attachment.bin", bytes: 262144, sha256: "2c".repeat(32), objectId: "aa03", uploadMs: 2500 },
		{ name: "probe", bytes: 47, sha256: "3d".repeat(32), objectId: "aa04", uploadMs: 400 },
	],
};

const FAILURES: FailureCase[] = [
	{ failure: "add#2", call: "add", key: "fixture-b.md", label: "fixture-b.md", failed: ["fixture-b.md"], pinned: 0, callCount: 4 },
	{ failure: "finalize", call: "finalize", key: "packed", label: "the packed session", failed: ["fixture-a.md", "fixture-b.md"], pinned: 0, callCount: 5 },
	{ failure: "pin#1", call: "pin", key: "fixture-a.md", label: "fixture-a.md", failed: ["fixture-a.md"], pinned: 0, callCount: 6 },
	{ failure: "upload#1", call: "upload", key: "attachment.bin", label: "attachment.bin", failed: ["attachment.bin"], pinned: 2, callCount: 8 },
	{ failure: "upload#2", call: "upload", key: "probe", label: "probe", failed: ["probe"], pinned: 3, callCount: 10 },
	{ failure: "pin#4", call: "pin", key: "probe", label: "probe", failed: ["probe"], pinned: 3, callCount: 11 },
];

const MISMATCHES: [FakeObject[], string][] = [
	[[new FakeObject("ff01", 6203)], "1 returned with sizes [6203]"],
	[[new FakeObject("ff01", 6203), new FakeObject("ff02", 1)], "2 returned with sizes [6203, 1]"],
];

const nodeSha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const callNames = (sdk: FakeSdk): string[] => sdk.calls.map((call) => call.replace(/:.*/, ""));

const storeCalls = (h: Harness): string[] => h.secrets.calls.filter((call) => call.startsWith("set:"));

const isTick = (value: number | null): boolean => value !== null && value > 0 && value % 7 === 0;

const failedCalls = (record: CommandRecord<UploadResult>): Record<string, string | null> => Object.fromEntries(record.result.objects.map((entry) => [entry.name, entry.failedCall]));

const pinnedCount = (record: CommandRecord<UploadResult>): number => record.result.objects.filter((entry) => entry.objectId !== null).length;

function uploadHarness(overrides: HarnessOverrides = {}): { h: Harness; sdk: FakeSdk } {
	const h = fakeContext(overrides);
	storeSeed(h.secrets, TEST_SEED);
	const sdk = h.session.stored;
	assert.ok(sdk instanceof FakeSdk);
	return { h, sdk };
}

function onlyRecord<T>(h: Harness): CommandRecord<T> {
	const records = h.records();
	assert.equal(records.length, 1);
	return records[0] as CommandRecord<T>;
}

async function upload(h: Harness): Promise<CommandRecord<UploadResult>> {
	await runUpload(h.ctx);
	return onlyRecord<UploadResult>(h);
}

function receiptOf(record: CommandRecord<UploadResult>): Receipt {
	const receipt = record.result.receipt;
	assert.ok(receipt !== null, record.error?.message);
	return receipt;
}

function entryNamed(receipt: Receipt, name: ReceiptObjectName): ReceiptObject {
	const entry = receipt.objects.find((candidate) => candidate.name === name);
	assert.ok(entry !== undefined, name);
	return entry;
}

function expectedFailedCalls(failed: readonly ReceiptObjectName[], call: string): Record<string, string | null> {
	return Object.fromEntries(RECEIPT_OBJECT_NAMES.map((name) => [name, failed.includes(name) ? call : null]));
}

function assertFailedWithoutReceipt(h: Harness, record: CommandRecord<UploadResult>, step: string, label: string): void {
	assert.equal(record.outcome, "failed", label);
	assert.equal(record.error?.kind, "error", label);
	assert.equal(record.error?.step, step, label);
	assert.equal(record.error?.transportHint, false, label);
	assert.equal(record.result.receipt, null, label);
	assert.deepEqual(h.settings.saves, [], label);
	assert.deepEqual(h.settings.value.receipt, PREVIOUS_RECEIPT, label);
	assert.deepEqual(h.shows, [], label);
}

async function failingUpload(c: FailureCase): Promise<void> {
	const { h, sdk } = uploadHarness({ settings: { receipt: PREVIOUS_RECEIPT } });
	const message = `${c.failure} rejected`;
	sdk.failures.set(c.failure, new Error(message));
	const record = await upload(h);
	assertFailedWithoutReceipt(h, record, `${c.call}:${c.key}`, c.failure);
	assert.equal(record.error?.message, message, c.failure);
	assert.deepEqual(h.notices, [`Upload failed at ${c.call} for ${c.label}: ${message}`], c.failure);
	assert.deepEqual(callNames(sdk), FULL_CALLS.slice(0, c.callCount), c.failure);
	assert.deepEqual(failedCalls(record), expectedFailedCalls(c.failed, c.call), c.failure);
	assert.equal(pinnedCount(record), c.pinned, c.failure);
}

test("the upload calls the SDK in order: one packed session with two adds and one finalize, two uploads, four pins", async () => {
	const { h, sdk } = uploadHarness();
	const record = await upload(h);
	const receipt = receiptOf(record);
	const a = entryNamed(receipt, "fixture-a.md");
	const b = entryNamed(receipt, "fixture-b.md");
	const attachment = entryNamed(receipt, "attachment.bin");
	const probe = entryNamed(receipt, "probe");
	assert.deepEqual(sdk.calls, [
		"uploadPacked",
		"remaining",
		`add:${a.bytes}`,
		`add:${b.bytes}`,
		"finalize",
		`pin:${a.objectId}`,
		`pin:${b.objectId}`,
		`upload:${attachment.bytes}`,
		`pin:${attachment.objectId}`,
		`upload:${probe.bytes}`,
		`pin:${probe.objectId}`,
	]);
	const names = callNames(sdk);
	const count = (name: string): number => names.filter((call) => call === name).length;
	assert.deepEqual(names, FULL_CALLS);
	assert.deepEqual([count("uploadPacked"), count("add"), count("finalize"), count("upload"), count("pin")], [1, 2, 1, 2, 4]);
	assert.equal(new Set(receipt.objects.map((entry) => entry.objectId)).size, 4);
	assert.deepEqual(record.result.packed, { remainingBeforeFirstAdd: sdk.packedRemaining, finalizeMs: 0, returnedCount: 2 });
});

test("the bytes passed to the SDK hash to SHA256SUMS while the vault holds no fixture file", async () => {
	const { h, sdk } = uploadHarness();
	assert.equal(h.vault.files.size, 0);
	const record = await upload(h);
	const receipt = receiptOf(record);
	for (const name of FIXTURE_NAMES) {
		const entry = entryNamed(receipt, name);
		const sent = sdk.contents.get(entry.objectId);
		assert.ok(sent !== undefined, name);
		assert.equal(nodeSha256(sent), committedHashes()[name], name);
		assert.equal(entry.sha256, committedHashes()[name], name);
		assert.equal(Buffer.compare(sent, fixtureBytes(name)), 0, name);
		assert.equal(entry.bytes, fixtureBytes(name).length, name);
	}
	const probe = entryNamed(receipt, "probe");
	const probeBytes = sdk.contents.get(probe.objectId);
	assert.ok(probeBytes !== undefined);
	assert.equal(nodeSha256(probeBytes), probe.sha256);
	assert.equal(probeBytes.length, probe.bytes);
	const probeText = new TextDecoder().decode(probeBytes);
	assert.match(probeText, PROBE_PATTERN);
	assert.ok(probeText.startsWith(`probe-${EPOCH_ISO}-`));
	assert.deepEqual([...h.vault.files.keys()], recordPaths(h.vault));
	assert.equal(recordPaths(h.vault).length, 1);
	for (const name of FIXTURE_NAMES) {
		assert.equal([...h.vault.files.keys(), ...h.vault.folders].some((path) => path.endsWith(name)), false, name);
	}
});

test("the receipt carries the format version, SDK version, platform label, timestamp and the four objects in order", async () => {
	const { h } = uploadHarness();
	const record = await upload(h);
	const receipt = receiptOf(record);
	const probe = entryNamed(receipt, "probe");
	assert.equal(receipt.formatVersion, 1);
	assert.equal(receipt.sdkVersion, __SDK_VERSION__);
	assert.equal(receipt.platformLabel, "macos");
	assert.equal(receipt.uploadedAt, EPOCH_ISO);
	assert.equal(new Date(receipt.uploadedAt).toISOString(), receipt.uploadedAt);
	assert.deepEqual(receipt.objects.map((entry) => entry.name), [...RECEIPT_OBJECT_NAMES]);
	assert.deepEqual(receipt.objects.map((entry) => entry.bytes), [6203, 12222, 262144, probe.bytes]);
	assert.ok(probe.bytes > 0 && probe.bytes <= 4096);
	assert.deepEqual(Object.keys(receipt).sort(), RECEIPT_KEYS);
	for (const entry of receipt.objects) {
		assert.deepEqual(Object.keys(entry).sort(), RECEIPT_OBJECT_KEYS, entry.name);
		assert.match(entry.sha256, /^[0-9a-f]{64}$/, entry.name);
		assert.match(entry.objectId, /^[0-9a-f]+$/, entry.name);
		assert.ok(Number.isInteger(entry.uploadMs) && entry.uploadMs >= 0, entry.name);
	}
	const finalizeMs = record.result.packed.finalizeMs;
	assert.ok(finalizeMs !== null && Number.isInteger(finalizeMs) && finalizeMs >= 0);
	assert.deepEqual(parseReceipt(formatReceipt(receipt)), { ok: true, value: receipt });
	assert.deepEqual(
		record.result.objects.map((entry) => ({ name: entry.name, bytes: entry.bytes, sha256: entry.sha256, objectId: entry.objectId, uploadMs: entry.uploadMs })),
		receipt.objects,
	);
	assert.deepEqual(failedCalls(record), expectedFailedCalls([], ""));
});

test("uploadMs runs from each object's first SDK call to its pin, so the packed objects include finalize", async () => {
	const { h } = uploadHarness();
	let t = 0;
	h.ctx.clock = () => {
		t += 7;
		return t;
	};
	const record = await upload(h);
	const receipt = receiptOf(record);
	const ms = (name: ReceiptObjectName): number => entryNamed(receipt, name).uploadMs;
	const finalizeMs = record.result.packed.finalizeMs;
	assert.ok(finalizeMs !== null);
	assert.ok(isTick(finalizeMs), "finalizeMs");
	for (const entry of receipt.objects) {
		assert.ok(isTick(entry.uploadMs), entry.name);
	}
	assert.ok(ms("fixture-a.md") > finalizeMs);
	assert.ok(ms("fixture-b.md") > finalizeMs);
	assert.ok(ms("fixture-a.md") > ms("attachment.bin"));
	assert.ok(ms("fixture-b.md") > ms("attachment.bin"));
	assert.equal(ms("attachment.bin"), ms("probe"));
	assert.ok(isTick(record.durationMs), "durationMs");
	assert.ok(record.durationMs > ms("fixture-a.md"));
	assert.deepEqual(record.reconnect, { method: "connected", outcome: "ok", durationMs: 7 });
});

test("a failure at add, finalize, pin or upload, or a finalize size mismatch, stops the run and leaves the stored receipt unchanged", async () => {
	for (const c of FAILURES) {
		await failingUpload(c);
	}
	for (const [returned, detail] of MISMATCHES) {
		const { h, sdk } = uploadHarness({ settings: { receipt: PREVIOUS_RECEIPT } });
		sdk.finalizeReturns = returned;
		const record = await upload(h);
		assertFailedWithoutReceipt(h, record, "finalize:match", detail);
		assert.deepEqual(h.notices, [FINALIZE_MISMATCH_NOTICE], detail);
		assert.equal(record.error?.message, `${FINALIZE_MISMATCH_NOTICE}: ${detail}`, detail);
		assert.equal(record.result.packed.returnedCount, returned.length, detail);
		assert.deepEqual(callNames(sdk), FULL_CALLS.slice(0, 5), detail);
		assert.deepEqual(failedCalls(record), expectedFailedCalls([], ""), detail);
		assert.equal(pinnedCount(record), 0, detail);
	}
});

test("a completed upload saves the receipt into settings, shows it once and notifies", async () => {
	const { h } = uploadHarness();
	const record = await upload(h);
	const receipt = receiptOf(record);
	assert.equal(record.command, "upload");
	assert.equal(record.outcome, "passed");
	assert.equal(record.error, null);
	assert.deepEqual(h.settings.saves, [{ ...DEFAULT_SETTINGS, receipt }]);
	assert.deepEqual(h.settings.value, { ...DEFAULT_SETTINGS, receipt });
	assert.deepEqual(h.shows, [{ title: RECEIPT_TITLE, text: formatReceipt(receipt) }]);
	assert.deepEqual(h.notices, [UPLOAD_COMPLETE_NOTICE]);
	assert.deepEqual(parseReceipt(h.shows[0]?.text ?? ""), { ok: true, value: receipt });

	const { h: replacing } = uploadHarness({ settings: { receipt: PREVIOUS_RECEIPT } });
	const replaced = receiptOf(await upload(replacing));
	assert.notDeepEqual(replaced, PREVIOUS_RECEIPT);
	assert.deepEqual(replacing.settings.saves, [{ ...DEFAULT_SETTINGS, receipt: replaced }]);
	assert.deepEqual(replacing.settings.value.receipt, replaced);
});

test("a fresh session with a stored seed reconnects with connected once and never requests a connection", async () => {
	const { h, sdk } = uploadHarness();
	const record = await upload(h);
	assert.equal(record.outcome, "passed");
	assert.deepEqual(h.session.connectStoredCalls, [{ indexerUrl: DEFAULT_SETTINGS.indexerUrl, seed: TEST_SEED }]);
	assert.deepEqual(h.session.builder.calls, []);
	assert.deepEqual(h.session.createBuilderUrls, []);
	assert.deepEqual(h.opened, []);
	assert.deepEqual(record.reconnect, { method: "connected", outcome: "ok", durationMs: 0 });
	assert.equal(h.session.current(), sdk);
	h.clock.advance(1000);
	await runUpload(h.ctx);
	const records = h.records() as CommandRecord<UploadResult>[];
	assert.equal(records.length, 2);
	assert.equal(records[1]?.outcome, "passed");
	assert.deepEqual(records[1]?.reconnect, { method: "live-session", outcome: "ok", durationMs: 0 });
	assert.equal(h.session.connectStoredCalls.length, 1);
	assert.deepEqual(h.session.builder.calls, []);
	assert.deepEqual(callNames(sdk), [...FULL_CALLS, ...FULL_CALLS]);
});

test("no stored seed, or connected resolving null, refuses before any SDK operation and leaves the store untouched", async () => {
	const h = fakeContext();
	const sdk = h.session.stored;
	assert.ok(sdk instanceof FakeSdk);
	const record = await upload(h);
	assert.equal(record.outcome, "refused");
	assert.equal(record.error?.kind, "refusal");
	assert.equal(record.error?.step, "credential");
	assert.equal(record.reconnect, null);
	assert.equal(record.result.receipt, null);
	assert.deepEqual(sdk.calls, []);
	assert.deepEqual(h.session.connectStoredCalls, []);
	assert.deepEqual(storeCalls(h), []);
	assert.equal(h.secrets.values.size, 0);
	assert.deepEqual(h.settings.saves, []);
	assert.deepEqual(h.shows, []);
	assert.deepEqual(h.notices, [NO_CREDENTIAL_NOTICE]);
	assert.equal(h.session.current(), null);

	const { h: nulled } = uploadHarness();
	nulled.session.stored = null;
	nulled.secrets.calls.length = 0;
	const refused = await upload(nulled);
	assert.equal(refused.outcome, "refused");
	assert.equal(refused.error?.kind, "refusal");
	assert.equal(refused.error?.step, "credential");
	assert.deepEqual(refused.reconnect, { method: "connected", outcome: "null", durationMs: 0 });
	assert.equal(refused.result.receipt, null);
	assert.equal(nulled.session.connectStoredCalls.length, 1);
	assert.deepEqual(storeCalls(nulled), []);
	assert.deepEqual(readSeed(nulled.secrets), TEST_SEED);
	assert.deepEqual(nulled.settings.saves, []);
	assert.deepEqual(nulled.shows, []);
	assert.deepEqual(nulled.notices, [NO_CREDENTIAL_NOTICE]);
	assert.equal(nulled.session.current(), null);
});

test("the memory fields report the heap when it is measurable and the platform reason otherwise", async () => {
	const { h } = uploadHarness();
	const record = await upload(h);
	assert.deepEqual(record.result.memory, {
		jsHeapBefore: "not measured",
		jsHeapAfter: "not measured",
		jsHeapReason: "performance.memory is not available on this platform",
		wasmMemoryBytesAfter: 65536,
	});

	const { h: ios } = uploadHarness({ platform: { platformClass: "ios" } });
	const iosRecord = await upload(ios);
	assert.equal(iosRecord.outcome, "passed");
	assert.equal(receiptOf(iosRecord).platformLabel, "ios");
	assert.deepEqual(iosRecord.result.memory, {
		jsHeapBefore: "not measured",
		jsHeapAfter: "not measured",
		jsHeapReason: "performance.memory is not exposed by WKWebView",
		wasmMemoryBytesAfter: 65536,
	});

	let heap = 1000;
	const { h: measured } = uploadHarness({
		jsHeapBytes: () => {
			heap += 234;
			return heap;
		},
	});
	const measuredRecord = await upload(measured);
	assert.equal(measuredRecord.outcome, "passed");
	assert.deepEqual(measuredRecord.result.memory, { jsHeapBefore: 1234, jsHeapAfter: 1468, jsHeapReason: null, wasmMemoryBytesAfter: 65536 });
});
