import assert from "node:assert/strict";
import { test } from "node:test";
import type { PlatformInfo } from "../src/context.ts";
import { DeadlineError, withDeadline } from "../src/deadline.ts";
import { toHex } from "../src/encoding.ts";
import { PROOF_FOLDER, RECORDS_FOLDER, formatRecord, recordFileName, writeRecord, type CommandRecord } from "../src/records.ts";
import { createRedactor, encodingsOf } from "../src/redaction.ts";
import { EPOCH_ISO, FakeTimers, FakeVault, TEST_SEED } from "./fakes.ts";

const STEM = "capability-2026-10-12T14-23-07-123Z";
const RECORD_PATH = `${RECORDS_FOLDER}/${STEM}.json`;
const PLATFORM: PlatformInfo = {
	platformClass: "macos",
	osVersion: "not exposed",
	obsidianApiVersion: "1.11.4",
	uaString: "Mozilla/5.0 (test)",
	isSecureContext: true,
	webTransportType: "function",
};

function record(overrides: Partial<CommandRecord<unknown>> = {}): CommandRecord<unknown> {
	return {
		formatVersion: 1,
		command: "capability",
		outcome: "passed",
		startedAt: EPOCH_ISO,
		finishedAt: "2026-10-12T14:23:08.123Z",
		durationMs: 1000,
		pluginVersion: "0.1.0",
		sdkVersion: "0.1.1",
		platform: PLATFORM,
		init: null,
		reconnect: null,
		error: null,
		result: {},
		...overrides,
	};
}

const created = (vault: FakeVault): number => vault.log.filter((entry) => entry.startsWith("createText:")).length;

test("recordFileName replaces the colons and the period of the timestamp with hyphens", () => {
	assert.equal(recordFileName("capability", new Date(EPOCH_ISO)), `${STEM}.json`);
	assert.equal(recordFileName("enter-receipt", new Date(EPOCH_ISO)), "enter-receipt-2026-10-12T14-23-07-123Z.json");
});

test("formatRecord is two-space JSON that keeps the real ISO timestamp", () => {
	const r = record();
	assert.equal(formatRecord(r), JSON.stringify(r, null, 2));
	assert.ok(formatRecord(r).includes(`"startedAt": "${EPOCH_ISO}"`));
});

test("writeRecord creates both folders and then the file on an empty vault", async () => {
	const vault = new FakeVault();
	const path = await writeRecord(vault, createRedactor(), record());
	assert.equal(path, RECORD_PATH);
	assert.deepEqual(vault.log, [`createFolder:${PROOF_FOLDER}`, `createFolder:${RECORDS_FOLDER}`, `createText:${RECORD_PATH}`]);
	assert.equal(vault.text(path), formatRecord(record()));
	assert.ok(vault.text(path).includes(`"startedAt": "${EPOCH_ISO}"`));
});

test("writeRecord leaves existing folders alone", async () => {
	const vault = new FakeVault();
	vault.folders.add(PROOF_FOLDER);
	vault.folders.add(RECORDS_FOLDER);
	const path = await writeRecord(vault, createRedactor(), record());
	assert.equal(path, RECORD_PATH);
	assert.deepEqual(vault.log, [`createText:${RECORD_PATH}`]);
	assert.deepEqual([...vault.folders], [PROOF_FOLDER, RECORDS_FOLDER]);
});

test("writeRecord appends -2 and then -3 on a name collision, one file per call", async () => {
	const vault = new FakeVault();
	const redactor = createRedactor();
	const first = await writeRecord(vault, redactor, record());
	assert.equal(created(vault), 1);
	assert.equal(vault.files.size, 1);
	const second = await writeRecord(vault, redactor, record({ outcome: "failed" }));
	assert.equal(created(vault), 2);
	assert.equal(vault.files.size, 2);
	const third = await writeRecord(vault, redactor, record({ outcome: "refused" }));
	assert.equal(created(vault), 3);
	assert.equal(vault.files.size, 3);
	assert.equal(first, RECORD_PATH);
	assert.equal(second, `${RECORDS_FOLDER}/${STEM}-2.json`);
	assert.equal(third, `${RECORDS_FOLDER}/${STEM}-3.json`);
	assert.deepEqual([...vault.files.keys()], [first, second, third]);
	assert.ok(vault.text(first).includes('"outcome": "passed"'));
	assert.ok(vault.text(second).includes('"outcome": "failed"'));
	assert.ok(vault.text(third).includes('"outcome": "refused"'));
});

test("writeRecord passes the formatted record through the redactor", async () => {
	const redactor = createRedactor();
	redactor.add(TEST_SEED);
	const leaky = record({ result: { encodings: encodingsOf(TEST_SEED), nested: { hex: toHex(TEST_SEED) } } });
	const vault = new FakeVault();
	const path = await writeRecord(vault, redactor, leaky);
	const text = vault.text(path);
	assert.equal(vault.files.size, 1);
	assert.equal(text, redactor.redact(formatRecord(leaky)));
	for (const enc of encodingsOf(TEST_SEED)) {
		assert.equal(text.includes(enc), false, `written record contains ${enc}`);
	}
	assert.ok(text.includes("[redacted]"));
	const unredacted = new FakeVault();
	assert.ok(unredacted.text(await writeRecord(unredacted, createRedactor(), leaky)).includes(toHex(TEST_SEED)));
});

test("withDeadline rejects with a DeadlineError when the timer fires first", async () => {
	const timers = new FakeTimers();
	const p = withDeadline(new Promise<number>(() => {}), 600000, "waitForApproval", timers);
	timers.fire();
	await assert.rejects(p, (e) => e instanceof DeadlineError && e.step === "waitForApproval" && e.ms === 600000);
	assert.deepEqual(timers.delays, [600000]);
	assert.deepEqual(timers.cleared, [1]);
	assert.equal(timers.pending.size, 0);
});

test("withDeadline returns the value and clears the timer when the promise wins", async () => {
	const timers = new FakeTimers();
	assert.equal(await withDeadline(Promise.resolve(7), 1000, "init", timers), 7);
	assert.deepEqual(timers.delays, [1000]);
	assert.equal(timers.pending.size, 0);
	assert.equal(timers.cleared.length, 1);
});

test("withDeadline ignores a late resolution of the losing promise", async () => {
	const timers = new FakeTimers();
	let resolveSlow: (value: string) => void = () => {};
	const slow = new Promise<string>((resolve) => {
		resolveSlow = resolve;
	});
	const raced = withDeadline(slow, 10, "slow", timers);
	timers.fire();
	const error = await raced.catch((e: unknown) => e);
	assert.ok(error instanceof DeadlineError);
	assert.equal(error.step, "slow");
	assert.equal(error.ms, 10);
	resolveSlow("late");
	assert.equal(await slow, "late");
	assert.equal(await raced.catch((e: unknown) => e), error);
	assert.equal(timers.pending.size, 0);
	assert.deepEqual(timers.cleared, [1]);
});

test("withDeadline propagates the promise's own rejection and clears the timer", async () => {
	const timers = new FakeTimers();
	const failure = new Error("upload failed");
	await assert.rejects(withDeadline(Promise.reject(failure), 1000, "upload", timers), (e) => e === failure);
	assert.equal(timers.pending.size, 0);
	assert.deepEqual(timers.cleared, [1]);
});
