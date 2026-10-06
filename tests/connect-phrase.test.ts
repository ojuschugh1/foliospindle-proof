import assert from "node:assert/strict";
import { test } from "node:test";
import { type ConnectResult, type EntryOutcome, PHRASE_NOTE, PHRASE_TITLE, runConnect } from "../src/commands/connect.ts";
import { toHex } from "../src/encoding.ts";
import type { CommandRecord } from "../src/records.ts";
import { createSession, validatePhrase } from "../src/sdk-adapter.ts";
import { embeddedWasmBytes } from "../src/wasm-embed.ts";
import { FakeTimers, type Harness, TEST_PHRASE, fakeContext, recordPaths } from "./fakes.ts";

interface RedactorSpy {
	added: unknown[];
	redacted: string[];
}

interface Output {
	label: string;
	text: string;
}

const INVALID_PHRASE = "not a valid phrase";
const WORDS = [...new Set(TEST_PHRASE.split(" "))];
const WORD_PATTERN = new RegExp(`\\b(${WORDS.join("|")})\\b`, "i");
const DISPLAY_TEXT = `${TEST_PHRASE}\n\n${PHRASE_NOTE}`;
const loggerInputs: string[] = [];

await createSession({
	layoutReady: Promise.resolve(),
	wasmBytes: embeddedWasmBytes,
	clock: () => performance.now(),
	now: () => new Date(),
	deadlineMs: 30000,
	timers: new FakeTimers(),
	logWarn: (text) => {
		loggerInputs.push(text);
	},
}).initialize();

assert.equal(validatePhrase(TEST_PHRASE), true);
assert.equal(validatePhrase(INVALID_PHRASE), false);
assert.equal(TEST_PHRASE.split(" ").length, 12);

function spyRedactor(h: Harness): RedactorSpy {
	const redactor = h.ctx.redactor;
	const spy: RedactorSpy = { added: [], redacted: [] };
	const add = redactor.add.bind(redactor);
	const redact = redactor.redact.bind(redactor);
	redactor.add = (seed) => {
		spy.added.push(seed);
		add(seed);
	};
	redactor.redact = (text) => {
		spy.redacted.push(text);
		return redact(text);
	};
	return spy;
}

function outputsOf(h: Harness, spy: RedactorSpy): Output[] {
	const outputs: Output[] = [];
	for (const [i, text] of h.notices.entries()) {
		outputs.push({ label: `notice ${i}`, text });
	}
	for (const [i, entry] of h.shows.entries()) {
		outputs.push({ label: `show title ${i}`, text: entry.title });
		if (entry.title !== PHRASE_TITLE) {
			outputs.push({ label: `show text ${i}`, text: entry.text });
		}
	}
	for (const [i, text] of h.prompts.entries()) {
		outputs.push({ label: `prompt ${i}`, text });
	}
	for (const [i, text] of h.opened.entries()) {
		outputs.push({ label: `opened ${i}`, text });
	}
	for (const path of recordPaths(h.vault)) {
		outputs.push({ label: path, text: h.vault.text(path) });
	}
	for (const [id, value] of h.secrets.values) {
		outputs.push({ label: `secret ${id}`, text: value });
	}
	for (const [i, saved] of h.settings.saves.entries()) {
		outputs.push({ label: `settings save ${i}`, text: JSON.stringify(saved) });
	}
	for (const [i, text] of spy.redacted.entries()) {
		if (text !== DISPLAY_TEXT) {
			outputs.push({ label: `redact input ${i}`, text });
		}
	}
	for (const [i, text] of loggerInputs.entries()) {
		outputs.push({ label: `logger ${i}`, text });
	}
	return outputs;
}

function assertClean(h: Harness, spy: RedactorSpy, displays: number, label: string): void {
	assert.equal(h.shows.filter((entry) => entry.title === PHRASE_TITLE).length, displays, label);
	assert.equal(spy.redacted.filter((text) => text === DISPLAY_TEXT).length, displays, label);
	for (const output of outputsOf(h, spy)) {
		assert.equal(WORD_PATTERN.test(output.text), false, `${label} ${output.label}: ${output.text}`);
		assert.equal(output.text.includes(INVALID_PHRASE), false, `${label} ${output.label}: ${output.text}`);
	}
	for (const seed of spy.added) {
		assert.ok(seed instanceof Uint8Array, label);
		assert.equal(seed.length, 32, label);
		assert.equal(toHex(seed).includes(TEST_PHRASE), false, label);
	}
}

function onlyRecord(h: Harness): CommandRecord<ConnectResult> {
	const records = h.records();
	assert.equal(records.length, 1);
	return records[0] as CommandRecord<ConnectResult>;
}

function entryHarness(answer: string | null, matches: boolean): Harness {
	const h = fakeContext({ promptAnswers: [answer] });
	h.session.builder.reconnectingFlag = true;
	h.session.builder.matches = matches;
	return h;
}

test("the fresh branch shows the phrase once and passes it nowhere else", async () => {
	const h = fakeContext();
	const spy = spyRedactor(h);
	await runConnect(h.ctx, new FakeTimers());
	const record = onlyRecord(h);
	assert.equal(record.outcome, "passed");
	assert.equal(record.result.plan, "registerFresh");
	assert.deepEqual(h.shows, [{ title: PHRASE_TITLE, text: DISPLAY_TEXT }]);
	assert.deepEqual(h.session.builder.checked, []);
	assert.deepEqual(h.session.builder.registeredWith, []);
	assertClean(h, spy, 1, "fresh");
	assert.equal(spy.added.length, 1);
});

test("the entry branch passes the phrase only to the SDK and displays nothing", async () => {
	const h = entryHarness(TEST_PHRASE, true);
	const spy = spyRedactor(h);
	await runConnect(h.ctx, new FakeTimers());
	const record = onlyRecord(h);
	assert.equal(record.outcome, "passed");
	assert.equal(record.result.plan, "registerWith");
	assert.deepEqual(h.shows, []);
	assert.deepEqual(h.session.builder.checked, [TEST_PHRASE]);
	assert.deepEqual(h.session.builder.registeredWith, [TEST_PHRASE]);
	assertClean(h, spy, 0, "entry");
	assert.equal(spy.added.length, 1);
});

test("entry refusals pass neither the phrase nor the rejected entry anywhere", async () => {
	const cases: { answer: string | null; matches: boolean; entryOutcome: EntryOutcome }[] = [
		{ answer: null, matches: true, entryOutcome: "cancelled" },
		{ answer: INVALID_PHRASE, matches: true, entryOutcome: "invalid" },
		{ answer: TEST_PHRASE, matches: false, entryOutcome: "mismatch" },
	];
	for (const { answer, matches, entryOutcome } of cases) {
		const h = entryHarness(answer, matches);
		const spy = spyRedactor(h);
		await runConnect(h.ctx, new FakeTimers());
		const record = onlyRecord(h);
		assert.equal(record.outcome, "refused", entryOutcome);
		assert.equal(record.result.entryOutcome, entryOutcome, entryOutcome);
		assert.equal(record.result.plan, "refuse", entryOutcome);
		assert.deepEqual(h.shows, [], entryOutcome);
		assert.deepEqual(h.session.builder.registeredWith, [], entryOutcome);
		assertClean(h, spy, 0, entryOutcome);
		assert.deepEqual(spy.added, [], entryOutcome);
	}
});

test("register and setSecret failures on the fresh branch pass the phrase nowhere", async () => {
	const rejected = fakeContext();
	rejected.session.builder.failures.set("register", new Error("rejected"));
	const rejectedSpy = spyRedactor(rejected);
	await runConnect(rejected.ctx, new FakeTimers());
	const rejectedRecord = onlyRecord(rejected);
	assert.equal(rejectedRecord.outcome, "failed");
	assert.equal(rejectedRecord.error?.step, "register");
	assert.deepEqual(rejected.shows, []);
	assertClean(rejected, rejectedSpy, 0, "register");
	assert.deepEqual(rejectedSpy.added, []);

	const locked = fakeContext();
	locked.secrets.throwOnSet = new Error("locked");
	const lockedSpy = spyRedactor(locked);
	await runConnect(locked.ctx, new FakeTimers());
	const lockedRecord = onlyRecord(locked);
	assert.equal(lockedRecord.outcome, "failed");
	assert.equal(lockedRecord.error?.step, "setSecret");
	assert.deepEqual(locked.shows, []);
	assertClean(locked, lockedSpy, 0, "setSecret");
	assert.equal(lockedSpy.added.length, 1);
});

test("the word pattern recognizes the phrase and the one-time display", () => {
	assert.equal(WORD_PATTERN.test(TEST_PHRASE), true);
	assert.equal(WORD_PATTERN.test(DISPLAY_TEXT), true);
	for (const word of WORDS) {
		assert.equal(WORD_PATTERN.test(`"${word}",`), true, word);
	}
	assert.equal(WORD_PATTERN.test(PHRASE_NOTE), false);
	assert.equal(WORD_PATTERN.test(WORDS.map((word) => `${word}ment`).join(" ")), false);
});
