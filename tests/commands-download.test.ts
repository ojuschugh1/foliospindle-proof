import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { PRIVATE_RELAY_HINT } from "../src/capability.ts";
import { COMPLETE_NOTICE, type DownloadObjectResult, type DownloadResult, INCOMPLETE_NOTICE, NO_RECEIPT_NOTICE, runDownload } from "../src/commands/download.ts";
import { ENTER_RECEIPT_TITLE, type EnterReceiptResult, RECEIPT_SAVED_NOTICE, runEnterReceipt } from "../src/commands/enter-receipt.ts";
import type { PlatformClass } from "../src/context.ts";
import { storeSeed } from "../src/credential.ts";
import { utf8Decode, utf8Encode } from "../src/encoding.ts";
import { FIXTURE_NAMES, type FixtureName, committedHashes, fixtureBytes } from "../src/fixtures.ts";
import { type Receipt, type ReceiptObject, formatReceipt } from "../src/receipt.ts";
import { type CommandRecord, type Outcome, PROOF_FOLDER, RECORDS_FOLDER } from "../src/records.ts";
import type { ObjectHandle } from "../src/sdk-adapter.ts";
import { DEFAULT_SETTINGS } from "../src/settings.ts";
import { EPOCH_ISO, FakeClock, FakeSdk, type Harness, TEST_SEED, fakeContext } from "./fakes.ts";

const OBJECT_IDS: Record<FixtureName, string> = { "fixture-a.md": "aa01", "fixture-b.md": "bb02", "attachment.bin": "cc03" };
const PROBE_ID = "dd04";
const PROBE_HASH = "0f".repeat(32);
const WRONG_HASH = "1b".repeat(32);
const STEM = "download-2026-10-12T14-23-07-123Z";
const SECOND_STEM = "download-2026-10-12T14-23-08-123Z";
const LOOKUP_MS = 5;
const STREAM_MS = 20;
const INVALID_UTF8 = Uint8Array.of(0xff, 0xfe, 0x00);

const nodeSha256 = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");

const fixturePath = (name: FixtureName): string => `${PROOF_FOLDER}/${name}`;

class ClockedSdk extends FakeSdk {
	clock: FakeClock;

	constructor(clock: FakeClock) {
		super();
		this.clock = clock;
	}

	object(id: string): Promise<ObjectHandle> {
		this.clock.advance(LOOKUP_MS);
		return super.object(id);
	}

	async downloadAll(obj: ObjectHandle): Promise<Uint8Array> {
		const bytes = await super.downloadAll(obj);
		this.clock.advance(STREAM_MS);
		return bytes;
	}
}

function receiptFor(label: PlatformClass): Receipt {
	const hashes = committedHashes();
	const objects: ReceiptObject[] = FIXTURE_NAMES.map((name) => ({ name, bytes: fixtureBytes(name).length, sha256: hashes[name], objectId: OBJECT_IDS[name], uploadMs: 100 }));
	objects.push({ name: "probe", bytes: 48, sha256: PROBE_HASH, objectId: PROBE_ID, uploadMs: 100 });
	return { formatVersion: 1, sdkVersion: __SDK_VERSION__, platformLabel: label, uploadedAt: EPOCH_ISO, objects };
}

function withReceiptHash(receipt: Receipt, name: FixtureName, sha256: string): Receipt {
	return { ...receipt, objects: receipt.objects.map((object) => (object.name === name ? { ...object, sha256 } : object)) };
}

function downloadHarness(label: PlatformClass = "macos"): { h: Harness; sdk: FakeSdk } {
	const h = fakeContext({ settings: { receipt: receiptFor(label) } });
	storeSeed(h.secrets, TEST_SEED);
	const sdk = h.session.stored;
	assert.ok(sdk instanceof FakeSdk);
	for (const name of FIXTURE_NAMES) {
		sdk.downloads.set(OBJECT_IDS[name], fixtureBytes(name));
	}
	return { h, sdk };
}

function onlyRecord<T>(h: Harness): CommandRecord<T> {
	const records = h.records();
	assert.equal(records.length, 1);
	return records[0] as CommandRecord<T>;
}

async function download(h: Harness): Promise<CommandRecord<DownloadResult>> {
	await runDownload(h.ctx);
	return onlyRecord<DownloadResult>(h);
}

function nonRecordFiles(h: Harness): string[] {
	return [...h.vault.files.keys()].filter((path) => !path.startsWith(`${RECORDS_FOLDER}/`)).sort();
}

function entry(record: CommandRecord<DownloadResult>, name: FixtureName): DownloadObjectResult {
	const object = record.result.objects.find((candidate) => candidate.name === name);
	assert.ok(object !== undefined, name);
	return object;
}

test("download without a stored receipt is refused before any SDK call and writes only the record", async () => {
	const h = fakeContext();
	storeSeed(h.secrets, TEST_SEED);
	const sdk = h.session.stored;
	assert.ok(sdk instanceof FakeSdk);
	const record = await download(h);
	assert.equal(record.command, "download");
	assert.equal(record.outcome, "refused");
	assert.equal(record.error?.step, "receipt");
	assert.equal(record.error?.kind, "refusal");
	assert.equal(record.error?.message, NO_RECEIPT_NOTICE);
	assert.equal(record.init, null);
	assert.equal(record.reconnect, null);
	assert.deepEqual(record.result.objects, []);
	assert.equal(record.result.crossInstallation, false);
	assert.equal(record.result.receiptPlatformLabel, "macos");
	assert.equal(record.result.proofFolder, PROOF_FOLDER);
	assert.deepEqual(sdk.calls, []);
	assert.equal(h.session.initCalls, 0);
	assert.deepEqual(h.session.connectStoredCalls, []);
	assert.deepEqual(nonRecordFiles(h), []);
	assert.deepEqual(h.vault.log, [`createFolder:${PROOF_FOLDER}`, `createFolder:${RECORDS_FOLDER}`, `createText:${RECORDS_FOLDER}/${STEM}.json`]);
	assert.deepEqual(h.notices, [NO_RECEIPT_NOTICE]);
	assert.deepEqual(h.settings.saves, []);
	assert.equal(h.settings.value.receipt, null);
});

test("three objects are fetched, hashed against the receipt and SHA256SUMS, and written after the folder is created", async () => {
	const { h, sdk } = downloadHarness();
	const record = await download(h);
	const hashes = committedHashes();
	assert.equal(record.command, "download");
	assert.equal(record.outcome, "passed");
	assert.equal(record.error, null);
	assert.equal(record.reconnect?.method, "connected");
	assert.equal(record.reconnect?.outcome, "ok");
	assert.equal(record.init?.firstInThisLoad, true);
	assert.equal(h.session.initCalls, 1);
	assert.deepEqual(record.result.objects.map((object) => object.name), [...FIXTURE_NAMES]);
	for (const name of FIXTURE_NAMES) {
		const object = entry(record, name);
		assert.equal(object.objectId, OBJECT_IDS[name], name);
		assert.equal(object.match, true, name);
		assert.equal(object.failedCall, null, name);
		assert.equal(object.downloadedBytes, fixtureBytes(name).length, name);
		assert.equal(object.downloadedSha256, hashes[name], name);
		assert.equal(object.receiptSha256, hashes[name], name);
		assert.equal(object.committedSha256, hashes[name], name);
		assert.equal(object.writtenPath, fixturePath(name), name);
		assert.equal(object.replacedExisting, false, name);
	}
	assert.deepEqual(record.result.objects.map((object) => object.writtenAs), ["text", "text", "binary"]);
	assert.deepEqual(sdk.calls, ["object:aa01", "downloadAll:aa01", "object:bb02", "downloadAll:bb02", "object:cc03", "downloadAll:cc03"]);
	assert.deepEqual(h.vault.log, [
		`createFolder:${PROOF_FOLDER}`,
		`createText:${fixturePath("fixture-a.md")}`,
		`createText:${fixturePath("fixture-b.md")}`,
		`createBinary:${fixturePath("attachment.bin")}`,
		`createFolder:${RECORDS_FOLDER}`,
		`createText:${RECORDS_FOLDER}/${STEM}.json`,
	]);
	assert.equal(h.vault.text(fixturePath("fixture-a.md")), utf8Decode(fixtureBytes("fixture-a.md")));
	assert.equal(h.vault.text(fixturePath("fixture-b.md")), utf8Decode(fixtureBytes("fixture-b.md")));
	assert.equal(Buffer.compare(h.vault.binary(fixturePath("attachment.bin")), fixtureBytes("attachment.bin")), 0);
	assert.deepEqual(h.notices, [COMPLETE_NOTICE]);
	assert.deepEqual(h.shows, []);
	assert.deepEqual(h.settings.saves, []);
	assert.equal(record.result.proofFolder, PROOF_FOLDER);
	assert.equal(record.result.receiptPlatformLabel, "macos");
	assert.equal(record.result.crossInstallation, false);
});

test("downloadMs spans the object lookup and the end of the download stream for every object", async () => {
	const { h, sdk } = downloadHarness();
	const clocked = new ClockedSdk(h.clock);
	clocked.downloads = sdk.downloads;
	h.session.stored = clocked;
	const record = await download(h);
	assert.equal(record.outcome, "passed");
	for (const name of FIXTURE_NAMES) {
		assert.equal(entry(record, name).downloadMs, LOOKUP_MS + STREAM_MS, name);
	}
	assert.equal(record.durationMs, FIXTURE_NAMES.length * (LOOKUP_MS + STREAM_MS));
	assert.deepEqual(sdk.calls, []);
});

test("a hash mismatch is notified with the object id and all three hashes, fails the run and still writes the bytes", async () => {
	const hashes = committedHashes();
	const tampered = utf8Encode("tampered");
	const { h, sdk } = downloadHarness();
	sdk.downloads.set("bb02", tampered);
	const record = await download(h);
	assert.equal(record.outcome, "failed");
	assert.equal(record.error?.step, "download");
	assert.equal(record.error?.kind, "error");
	assert.ok(record.error?.message.includes("1 of 3"));
	const b = entry(record, "fixture-b.md");
	assert.equal(b.match, false);
	assert.equal(b.failedCall, null);
	assert.equal(b.downloadedBytes, tampered.length);
	assert.equal(b.downloadedSha256, nodeSha256(tampered));
	assert.equal(b.writtenPath, fixturePath("fixture-b.md"));
	assert.equal(b.writtenAs, "text");
	assert.equal(h.vault.text(fixturePath("fixture-b.md")), "tampered");
	assert.equal(entry(record, "fixture-a.md").match, true);
	assert.equal(entry(record, "attachment.bin").match, true);
	assert.deepEqual(h.notices, [
		`Hash mismatch for object bb02: downloaded ${nodeSha256(tampered)}, receipt ${hashes["fixture-b.md"]}, committed ${hashes["fixture-b.md"]}`,
		INCOMPLETE_NOTICE,
	]);
	assert.deepEqual(h.settings.saves, []);
	assert.deepEqual(h.settings.value.receipt, receiptFor("macos"));
	assert.deepEqual(nonRecordFiles(h), FIXTURE_NAMES.map((name) => fixturePath(name)).sort());

	const wrong = downloadHarness();
	wrong.h.settings.value.receipt = withReceiptHash(receiptFor("macos"), "fixture-b.md", WRONG_HASH);
	const wrongRecord = await download(wrong.h);
	assert.equal(wrongRecord.outcome, "failed");
	const wrongB = entry(wrongRecord, "fixture-b.md");
	assert.equal(wrongB.match, false);
	assert.equal(wrongB.downloadedSha256, hashes["fixture-b.md"]);
	assert.equal(wrongB.receiptSha256, WRONG_HASH);
	assert.equal(wrongB.committedSha256, hashes["fixture-b.md"]);
	assert.equal(wrong.h.vault.text(fixturePath("fixture-b.md")), utf8Decode(fixtureBytes("fixture-b.md")));
	assert.deepEqual(wrong.h.notices, [
		`Hash mismatch for object bb02: downloaded ${hashes["fixture-b.md"]}, receipt ${WRONG_HASH}, committed ${hashes["fixture-b.md"]}`,
		INCOMPLETE_NOTICE,
	]);
});

test("object and download failures are recorded per object, the remaining objects continue and the receipt is unchanged", async () => {
	const { h, sdk } = downloadHarness();
	sdk.failures.set("object#1", new Error("not found"));
	sdk.failures.set("downloadAll#1", new Error("QUIC stream reset"));
	const record = await download(h);
	assert.equal(record.outcome, "failed");
	assert.equal(record.error?.step, "download");
	assert.ok(record.error?.message.includes("2 of 3"));
	const a = entry(record, "fixture-a.md");
	assert.equal(a.failedCall, "object");
	assert.equal(a.match, false);
	assert.equal(a.downloadMs, null);
	assert.equal(a.downloadedBytes, null);
	assert.equal(a.downloadedSha256, null);
	assert.equal(a.writtenPath, null);
	assert.equal(a.writtenAs, null);
	const b = entry(record, "fixture-b.md");
	assert.equal(b.failedCall, "download");
	assert.equal(b.match, false);
	assert.equal(b.downloadMs, null);
	assert.equal(b.downloadedSha256, null);
	assert.equal(b.writtenPath, null);
	const c = entry(record, "attachment.bin");
	assert.equal(c.failedCall, null);
	assert.equal(c.match, true);
	assert.equal(c.writtenPath, fixturePath("attachment.bin"));
	assert.deepEqual(sdk.calls, ["object:aa01", "object:bb02", "downloadAll:bb02", "object:cc03", "downloadAll:cc03"]);
	assert.deepEqual(h.notices, [
		"Download failed at object for object aa01: not found",
		`Download failed at download for object bb02: QUIC stream reset ${PRIVATE_RELAY_HINT}`,
		INCOMPLETE_NOTICE,
	]);
	assert.deepEqual(h.settings.saves, []);
	assert.deepEqual(h.settings.value.receipt, receiptFor("macos"));
	assert.deepEqual(nonRecordFiles(h), [fixturePath("attachment.bin")]);
});

test("a second run replaces the existing files so the folder holds one file per fixture", async () => {
	const { h } = downloadHarness();
	const first = await download(h);
	assert.equal(first.outcome, "passed");
	const before = h.vault.log.length;
	h.clock.advance(1000);
	await runDownload(h.ctx);
	const records = h.records();
	assert.equal(records.length, 2);
	assert.deepEqual(records.map((record) => record.outcome), ["passed", "passed"]);
	const second = records[1] as CommandRecord<DownloadResult>;
	assert.equal(second.error, null);
	for (const name of FIXTURE_NAMES) {
		const object = entry(second, name);
		assert.equal(object.replacedExisting, true, name);
		assert.equal(object.match, true, name);
		assert.equal(object.writtenAs, entry(first, name).writtenAs, name);
		assert.equal(object.writtenPath, fixturePath(name), name);
	}
	assert.deepEqual(h.vault.log.slice(before), [
		`replaceText:${fixturePath("fixture-a.md")}`,
		`replaceText:${fixturePath("fixture-b.md")}`,
		`replaceBinary:${fixturePath("attachment.bin")}`,
		`createText:${RECORDS_FOLDER}/${SECOND_STEM}.json`,
	]);
	assert.equal(h.vault.log.filter((line) => line === `createFolder:${PROOF_FOLDER}`).length, 1);
	assert.equal(nonRecordFiles(h).length, 3);
	assert.equal(Buffer.compare(h.vault.binary(fixturePath("attachment.bin")), fixtureBytes("attachment.bin")), 0);
	assert.deepEqual(h.notices, [COMPLETE_NOTICE, COMPLETE_NOTICE]);
});

test("Markdown bytes that are not valid UTF-8 are written as binary and the mismatch notice says so", async () => {
	const { h, sdk } = downloadHarness();
	sdk.downloads.set("aa01", INVALID_UTF8);
	const record = await download(h);
	assert.equal(record.outcome, "failed");
	const a = entry(record, "fixture-a.md");
	assert.equal(a.match, false);
	assert.equal(a.failedCall, null);
	assert.equal(a.downloadedBytes, INVALID_UTF8.length);
	assert.equal(a.downloadedSha256, nodeSha256(INVALID_UTF8));
	assert.equal(a.writtenPath, fixturePath("fixture-a.md"));
	assert.equal(a.writtenAs, "binary");
	assert.equal(a.replacedExisting, false);
	assert.equal(Buffer.compare(h.vault.binary(fixturePath("fixture-a.md")), INVALID_UTF8), 0);
	assert.ok(h.vault.log.includes(`createBinary:${fixturePath("fixture-a.md")}`));
	assert.equal(entry(record, "fixture-b.md").writtenAs, "text");
	const hash = committedHashes()["fixture-a.md"];
	assert.deepEqual(h.notices, [
		`Hash mismatch for object aa01: downloaded ${nodeSha256(INVALID_UTF8)}, receipt ${hash}, committed ${hash} (Markdown bytes are not valid UTF-8)`,
		INCOMPLETE_NOTICE,
	]);
});

test("the run passes only when every object was fetched and matched both hashes", async () => {
	const cases: [string, (sdk: FakeSdk) => void, Outcome][] = [
		["all match", () => undefined, "passed"],
		["one mismatch", (sdk) => sdk.downloads.set("cc03", Uint8Array.of(1)), "failed"],
		["one fetch failure", (sdk) => sdk.failures.set("object#3", new Error("gone")), "failed"],
	];
	for (const [label, arrange, outcome] of cases) {
		const { h, sdk } = downloadHarness();
		arrange(sdk);
		const record = await download(h);
		assert.equal(record.outcome, outcome, label);
		assert.equal(record.result.objects.length, 3, label);
		assert.equal(record.result.objects.every((object) => object.match && object.failedCall === null), outcome === "passed", label);
		assert.equal(record.error === null, outcome === "passed", label);
	}
});

test("crossInstallation reflects whether the receipt label differs from the running platform", async () => {
	const cross = downloadHarness("ios");
	const crossRecord = await download(cross.h);
	assert.equal(crossRecord.outcome, "passed");
	assert.equal(crossRecord.platform.platformClass, "macos");
	assert.equal(crossRecord.result.receiptPlatformLabel, "ios");
	assert.equal(crossRecord.result.crossInstallation, true);
	const own = downloadHarness("macos");
	const ownRecord = await download(own.h);
	assert.equal(ownRecord.outcome, "passed");
	assert.equal(ownRecord.result.receiptPlatformLabel, "macos");
	assert.equal(ownRecord.result.crossInstallation, false);
});

test("a vault write failure is recorded as failedCall vault and the remaining objects are still written", async () => {
	const { h } = downloadHarness();
	await h.vault.createFolder(PROOF_FOLDER);
	await h.vault.createFolder(fixturePath("fixture-a.md"));
	const before = h.vault.log.length;
	const record = await download(h);
	assert.equal(record.outcome, "failed");
	assert.equal(record.error?.step, "download");
	assert.ok(record.error?.message.includes("1 of 3"));
	const a = entry(record, "fixture-a.md");
	assert.equal(a.failedCall, "vault");
	assert.equal(a.match, true);
	assert.equal(a.downloadedSha256, committedHashes()["fixture-a.md"]);
	assert.equal(a.writtenPath, null);
	assert.equal(a.writtenAs, null);
	assert.equal(a.replacedExisting, false);
	assert.equal(entry(record, "fixture-b.md").writtenPath, fixturePath("fixture-b.md"));
	assert.equal(entry(record, "attachment.bin").writtenPath, fixturePath("attachment.bin"));
	assert.deepEqual(nonRecordFiles(h), [fixturePath("attachment.bin"), fixturePath("fixture-b.md")]);
	assert.deepEqual(h.vault.log.slice(before), [
		`createText:${fixturePath("fixture-b.md")}`,
		`createBinary:${fixturePath("attachment.bin")}`,
		`createFolder:${RECORDS_FOLDER}`,
		`createText:${RECORDS_FOLDER}/${STEM}.json`,
	]);
	assert.deepEqual(h.notices, [`Could not write ${fixturePath("fixture-a.md")}: File does not exist.`, INCOMPLETE_NOTICE]);
});

function enterHarness(answer: string | null, stored: Receipt | null = null): { h: Harness; sdk: FakeSdk } {
	const h = fakeContext({ promptAnswers: [answer], settings: { receipt: stored } });
	const sdk = h.session.stored;
	assert.ok(sdk instanceof FakeSdk);
	return { h, sdk };
}

async function enterReceipt(h: Harness): Promise<CommandRecord<EnterReceiptResult>> {
	await runEnterReceipt(h.ctx);
	return onlyRecord<EnterReceiptResult>(h);
}

function untouched(h: Harness, sdk: FakeSdk, label?: string): void {
	assert.deepEqual(sdk.calls, [], label);
	assert.deepEqual(h.secrets.calls, [], label);
	assert.equal(h.session.initCalls, 0, label);
	assert.deepEqual(h.session.connectStoredCalls, [], label);
}

test("a valid pasted receipt is saved into settings without touching the SDK or the credential", async () => {
	const { h, sdk } = enterHarness(formatReceipt(receiptFor("ios")));
	const record = await enterReceipt(h);
	assert.equal(record.command, "enter-receipt");
	assert.equal(record.outcome, "passed");
	assert.equal(record.error, null);
	assert.equal(record.init, null);
	assert.equal(record.reconnect, null);
	assert.deepEqual(record.result, { accepted: true, firstInvalidField: null, reason: null });
	assert.deepEqual(h.prompts, [ENTER_RECEIPT_TITLE]);
	assert.deepEqual(h.settings.saves, [{ ...DEFAULT_SETTINGS, receipt: receiptFor("ios") }]);
	assert.deepEqual(h.settings.value.receipt, receiptFor("ios"));
	assert.deepEqual(h.notices, [RECEIPT_SAVED_NOTICE]);
	assert.deepEqual(h.shows, []);
	untouched(h, sdk);
	assert.deepEqual(nonRecordFiles(h), []);
});

test("whitespace and newlines around the pasted receipt still parse and save", async () => {
	const { h, sdk } = enterHarness(`\n\n  ${formatReceipt(receiptFor("ios"))}\n\t \n`);
	const record = await enterReceipt(h);
	assert.equal(record.outcome, "passed");
	assert.deepEqual(record.result, { accepted: true, firstInvalidField: null, reason: null });
	assert.deepEqual(h.settings.value.receipt, receiptFor("ios"));
	assert.deepEqual(h.notices, [RECEIPT_SAVED_NOTICE]);
	untouched(h, sdk);
});

test("a valid receipt replaces the receipt already stored", async () => {
	const { h, sdk } = enterHarness(formatReceipt(receiptFor("ios")), receiptFor("macos"));
	const record = await enterReceipt(h);
	assert.equal(record.outcome, "passed");
	assert.deepEqual(h.settings.saves, [{ ...DEFAULT_SETTINGS, receipt: receiptFor("ios") }]);
	assert.deepEqual(h.settings.value.receipt, receiptFor("ios"));
	assert.deepEqual(h.notices, [RECEIPT_SAVED_NOTICE]);
	untouched(h, sdk);
});

test("an invalid receipt is rejected naming its first invalid field and the stored receipt is unchanged", async () => {
	const hashes = committedHashes();
	const cases: [string, string, string, string][] = [
		["not JSON", "{ not json", "", "not valid JSON"],
		["format version", JSON.stringify({ ...receiptFor("ios"), formatVersion: 2 }), "formatVersion", "expected 1"],
		["uppercase hash", JSON.stringify(withReceiptHash(receiptFor("ios"), "attachment.bin", hashes["attachment.bin"].toUpperCase())), "objects[2].sha256", "expected 64 lowercase hex characters"],
		["unknown key", JSON.stringify({ ...receiptFor("ios"), note: "x" }), "note", "unknown key"],
	];
	for (const [label, text, path, reason] of cases) {
		const { h, sdk } = enterHarness(text, receiptFor("macos"));
		const record = await enterReceipt(h);
		assert.equal(record.command, "enter-receipt", label);
		assert.equal(record.outcome, "failed", label);
		assert.equal(record.error?.step, "parseReceipt", label);
		assert.equal(record.error?.kind, "error", label);
		assert.equal(record.error?.message, `${path}: ${reason}`, label);
		assert.deepEqual(record.result, { accepted: false, firstInvalidField: path, reason }, label);
		assert.deepEqual(h.prompts, [ENTER_RECEIPT_TITLE], label);
		assert.deepEqual(h.notices, [`Invalid receipt: ${path}: ${reason}`], label);
		assert.deepEqual(h.shows, [], label);
		assert.deepEqual(h.settings.saves, [], label);
		assert.deepEqual(h.settings.value.receipt, receiptFor("macos"), label);
		untouched(h, sdk, label);
		assert.deepEqual(nonRecordFiles(h), [], label);
	}
});

test("a cancelled receipt prompt is refused without a notice and leaves settings unchanged", async () => {
	const { h, sdk } = enterHarness(null, receiptFor("macos"));
	const record = await enterReceipt(h);
	assert.equal(record.command, "enter-receipt");
	assert.equal(record.outcome, "refused");
	assert.deepEqual(record.error, { step: "prompt", kind: "refusal", message: "cancelled", transportHint: false });
	assert.deepEqual(record.result, { accepted: false, firstInvalidField: null, reason: "cancelled" });
	assert.equal(record.init, null);
	assert.equal(record.reconnect, null);
	assert.deepEqual(h.prompts, [ENTER_RECEIPT_TITLE]);
	assert.deepEqual(h.notices, []);
	assert.deepEqual(h.shows, []);
	assert.deepEqual(h.settings.saves, []);
	assert.deepEqual(h.settings.value.receipt, receiptFor("macos"));
	untouched(h, sdk);
	assert.deepEqual(nonRecordFiles(h), []);
});
