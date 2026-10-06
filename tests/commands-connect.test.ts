import assert from "node:assert/strict";
import { test } from "node:test";
import { MINIMUM_PLATFORMS } from "../src/capability.ts";
import { APPROVAL_DEADLINE_MS, APPROVAL_TITLE, CONNECTED_NOTICE, type ConnectResult, ENTRY_TITLE, type EntryOutcome, MISMATCH_NOTICE, PHRASE_NOTE, PHRASE_TITLE, runConnect, STORE_FAILED_NOTICE, TIMEOUT_NOTICE } from "../src/commands/connect.ts";
import { type RemoveCredentialResult, runRemoveCredential } from "../src/commands/remove-credential.ts";
import { requireSdk, startRecord } from "../src/commands/session-steps.ts";
import type { PlatformClass } from "../src/context.ts";
import { SECRET_ID, readSeed, storeSeed } from "../src/credential.ts";
import { toBase64Url } from "../src/encoding.ts";
import { type CommandRecord, PROOF_FOLDER, RECORDS_FOLDER } from "../src/records.ts";
import { encodingsOf } from "../src/redaction.ts";
import { APP_METADATA, createSession, validatePhrase } from "../src/sdk-adapter.ts";
import { DEFAULT_SETTINGS } from "../src/settings.ts";
import { embeddedWasmBytes } from "../src/wasm-embed.ts";
import { FakeTimers, type Harness, TEST_PHRASE, TEST_PUBLIC_KEY, TEST_SEED, fakeContext, recordPaths } from "./fakes.ts";

type Presentation = ConnectResult["approvalPresentation"];

const OTHER_SEED = Uint8Array.from({ length: 32 }, (_, i) => 255 - i);
const INVALID_PHRASE = "not a valid phrase";
const NO_CREDENTIAL_NOTICE = "No valid credential is stored. Run Connect to indexer.";
const REMOVED_NOTICE = "No credential is stored";
const STEM = "connect-2026-10-12T14-23-07-123Z";
const CLASSES: PlatformClass[] = ["macos", "desktop-other", "ios", "android", "unknown"];
const PRESENTATIONS: Record<PlatformClass, Presentation> = {
	macos: "system-browser",
	"desktop-other": "system-browser",
	ios: "selectable-text",
	android: "selectable-text",
	unknown: "selectable-text",
};

await createSession({
	layoutReady: Promise.resolve(),
	wasmBytes: embeddedWasmBytes,
	clock: () => performance.now(),
	now: () => new Date(),
	deadlineMs: 30000,
	timers: new FakeTimers(),
}).initialize();

assert.equal(validatePhrase(TEST_PHRASE), true);
assert.equal(validatePhrase(INVALID_PHRASE), false);

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const storeCalls = (h: Harness): string[] => h.secrets.calls.filter((call) => call.startsWith("set:"));

const registerCalls = (h: Harness): string[] => h.session.builder.calls.filter((call) => call.startsWith("register"));

const showsTitled = (h: Harness, title: string): { title: string; text: string }[] => h.shows.filter((entry) => entry.title === title);

function onlyRecord<T>(h: Harness): CommandRecord<T> {
	const records = h.records();
	assert.equal(records.length, 1);
	return records[0] as CommandRecord<T>;
}

async function connect(h: Harness, timers = new FakeTimers()): Promise<CommandRecord<ConnectResult>> {
	await runConnect(h.ctx, timers);
	return onlyRecord<ConnectResult>(h);
}

function preStore(h: Harness, seed: Uint8Array): void {
	storeSeed(h.secrets, seed);
	h.secrets.calls.length = 0;
}

function recordText(h: Harness): string {
	const [path] = recordPaths(h.vault);
	assert.ok(path !== undefined);
	return h.vault.text(path);
}

async function failingConnect(step: string, message: string): Promise<Harness> {
	const h = fakeContext();
	preStore(h, OTHER_SEED);
	h.session.builder.failures.set(step, new Error(message));
	const record = await connect(h);
	assert.equal(record.outcome, "failed", step);
	assert.equal(record.error?.step, step, step);
	assert.equal(record.error?.kind, "error", step);
	assert.deepEqual(h.notices, [`Connection attempt failed: ${step}: ${message}`], step);
	assert.equal(record.result.publicKeyHex, "", step);
	assert.equal(record.result.seedStored, false, step);
	assert.deepEqual(readSeed(h.secrets), OTHER_SEED, step);
	assert.deepEqual(storeCalls(h), [], step);
	assert.equal(showsTitled(h, PHRASE_TITLE).length, 0, step);
	return h;
}

function entryHarness(answer: string | null, matches: boolean): Harness {
	const h = fakeContext({ promptAnswers: [answer] });
	preStore(h, OTHER_SEED);
	h.session.builder.reconnectingFlag = true;
	h.session.builder.matches = matches;
	return h;
}

async function refusedEntry(answer: string | null, matches: boolean, entryOutcome: EntryOutcome, step: string): Promise<Harness> {
	const h = entryHarness(answer, matches);
	const record = await connect(h);
	assert.deepEqual(h.prompts, [ENTRY_TITLE], entryOutcome);
	assert.deepEqual(registerCalls(h), [], entryOutcome);
	assert.deepEqual(h.session.builder.registeredWith, [], entryOutcome);
	assert.deepEqual(readSeed(h.secrets), OTHER_SEED, entryOutcome);
	assert.deepEqual(storeCalls(h), [], entryOutcome);
	assert.deepEqual(h.shows, [], entryOutcome);
	assert.deepEqual(h.notices, [MISMATCH_NOTICE], entryOutcome);
	assert.equal(record.outcome, "refused", entryOutcome);
	assert.equal(record.error?.kind, "refusal", entryOutcome);
	assert.equal(record.error?.step, step, entryOutcome);
	assert.equal(record.result.reconnecting, true, entryOutcome);
	assert.equal(record.result.entryOutcome, entryOutcome, entryOutcome);
	assert.equal(record.result.plan, "refuse", entryOutcome);
	assert.equal(record.result.publicKeyHex, "", entryOutcome);
	assert.equal(record.result.seedStored, false, entryOutcome);
	assert.equal(h.session.current(), null, entryOutcome);
	return h;
}

test("a fresh connect calls the builder in order with the constant application metadata", async () => {
	const h = fakeContext();
	const record = await connect(h);
	assert.deepEqual(h.session.builder.calls, ["requestConnection", "responseUrl", "waitForApproval", "reconnecting", "register"]);
	assert.deepEqual(h.session.createBuilderUrls, [DEFAULT_SETTINGS.indexerUrl]);
	assert.equal(record.command, "connect");
	assert.equal(record.outcome, "passed");
	assert.equal(record.result.appId, APP_METADATA.appId);
	assert.equal(record.result.indexerUrl, DEFAULT_SETTINGS.indexerUrl);
	assert.equal(record.result.reconnecting, false);
	assert.equal(record.result.entryOutcome, null);
	assert.equal(record.result.plan, "registerFresh");
	const again = await connect(fakeContext());
	assert.equal(again.result.appId, record.result.appId);
	assert.equal(APP_METADATA.callbackUrl, undefined);
});

test("the approval URL is presented in exactly one mode per platform class", async () => {
	for (const cls of CLASSES) {
		const h = fakeContext({ platform: { platformClass: cls } });
		const url = h.session.builder.url;
		const record = await connect(h);
		const approvalShows = showsTitled(h, APPROVAL_TITLE);
		assert.equal(record.outcome, "passed", cls);
		assert.equal(record.result.approvalPresentation, PRESENTATIONS[cls], cls);
		assert.equal(h.opened.length + approvalShows.length, 1, cls);
		if (PRESENTATIONS[cls] === "system-browser") {
			assert.deepEqual(h.opened, [url], cls);
			assert.deepEqual(approvalShows, [], cls);
		} else {
			assert.deepEqual(h.opened, [], cls);
			assert.deepEqual(approvalShows, [{ title: APPROVAL_TITLE, text: url }], cls);
		}
	}
});

test("the approval deadline wins and a late approval reaches neither register nor the store", async () => {
	const h = fakeContext();
	const builder = h.session.builder;
	builder.holdApproval = true;
	const timers = new FakeTimers();
	const run = runConnect(h.ctx, timers);
	for (let i = 0; i < 20 && timers.pending.size === 0; i += 1) {
		await settle();
	}
	assert.equal(timers.pending.size, 1);
	assert.deepEqual(timers.delays, [APPROVAL_DEADLINE_MS]);
	timers.fire();
	await run;
	const record = onlyRecord<ConnectResult>(h);
	assert.deepEqual(h.notices, [TIMEOUT_NOTICE]);
	assert.equal(record.outcome, "failed");
	assert.equal(record.error?.kind, "timeout");
	assert.equal(record.error?.step, "waitForApproval");
	assert.equal(typeof record.result.approvalWaitMs, "number");
	assert.equal(record.result.publicKeyHex, "");
	assert.equal(record.result.plan, null);
	assert.equal(record.result.reconnecting, null);
	assert.equal(record.result.seedStored, false);
	assert.deepEqual(builder.calls, ["requestConnection", "responseUrl", "waitForApproval"]);
	builder.approval.resolve();
	await settle();
	await settle();
	assert.deepEqual(registerCalls(h), []);
	assert.deepEqual(storeCalls(h), []);
	assert.equal(readSeed(h.secrets), null);
	assert.equal(h.session.current(), null);
	assert.equal(h.records().length, 1);
	assert.equal(timers.pending.size, 0);
});

test("a fresh registration stores the seed under the secret id, replaces the previous seed and shows the phrase once", async () => {
	const h = fakeContext();
	preStore(h, OTHER_SEED);
	const builder = h.session.builder;
	const record = await connect(h);
	assert.equal(h.secrets.values.get(SECRET_ID), toBase64Url(TEST_SEED, false));
	assert.deepEqual(readSeed(h.secrets), TEST_SEED);
	assert.deepEqual(storeCalls(h), [`set:${SECRET_ID}`]);
	assert.equal(SECRET_ID, "foliospindle-proof-app-key");
	assert.equal(record.outcome, "passed");
	assert.equal(record.error, null);
	assert.equal(record.result.seedStored, true);
	assert.equal(record.result.replacedPreviousSeed, true);
	assert.equal(record.result.publicKeyHex, TEST_PUBLIC_KEY);
	assert.equal(record.result.secretId, SECRET_ID);
	assert.deepEqual(h.notices, [CONNECTED_NOTICE]);
	assert.deepEqual(showsTitled(h, PHRASE_TITLE), [{ title: PHRASE_TITLE, text: `${builder.phrase}\n\n${PHRASE_NOTE}` }]);
	assert.equal(h.shows.length, 1);
	assert.deepEqual(registerCalls(h), ["register"]);
	assert.equal(h.session.current(), builder.sdk);
	const text = recordText(h);
	for (const encoding of encodingsOf(TEST_SEED)) {
		assert.equal(text.includes(encoding), false, encoding);
	}
	assert.ok(text.includes(`"publicKeyHex": "${TEST_PUBLIC_KEY}"`));
});

test("failures of requestConnection, waitForApproval, register and setSecret keep the previous seed and record the step", async () => {
	const request = await failingConnect("requestConnection", "net down");
	assert.deepEqual(request.session.builder.calls, ["requestConnection"]);
	assert.deepEqual(request.opened, []);
	const approval = await failingConnect("waitForApproval", "denied");
	assert.deepEqual(approval.session.builder.calls, ["requestConnection", "responseUrl", "waitForApproval"]);
	const register = await failingConnect("register", "rejected");
	assert.deepEqual(registerCalls(register), ["register"]);
	assert.equal(register.session.current(), null);

	const h = fakeContext();
	preStore(h, OTHER_SEED);
	h.secrets.throwOnSet = new Error("keychain locked");
	const record = await connect(h);
	assert.deepEqual(h.notices, [STORE_FAILED_NOTICE]);
	assert.equal(record.outcome, "failed");
	assert.equal(record.error?.step, "setSecret");
	assert.equal(record.error?.kind, "error");
	assert.equal(record.result.publicKeyHex, "");
	assert.equal(record.result.seedStored, false);
	assert.equal(record.result.replacedPreviousSeed, false);
	assert.equal(h.session.discardCalls, 1);
	assert.equal(h.session.current(), null);
	assert.deepEqual(readSeed(h.secrets), OTHER_SEED);
	assert.deepEqual(storeCalls(h), [`set:${SECRET_ID}`]);
	assert.equal(showsTitled(h, PHRASE_TITLE).length, 0);
});

test("phrase entry registers once on a match and refuses without register when cancelled, invalid or mismatched", async () => {
	const h = entryHarness(TEST_PHRASE, true);
	const builder = h.session.builder;
	const record = await connect(h);
	assert.deepEqual(h.prompts, [ENTRY_TITLE]);
	assert.deepEqual(builder.checked, [TEST_PHRASE]);
	assert.deepEqual(builder.registeredWith, [TEST_PHRASE]);
	assert.deepEqual(registerCalls(h), ["register:with"]);
	assert.deepEqual(builder.calls, ["requestConnection", "responseUrl", "waitForApproval", "reconnecting", "matchesExistingAppKey", "register:with"]);
	assert.deepEqual(readSeed(h.secrets), TEST_SEED);
	assert.deepEqual(storeCalls(h), [`set:${SECRET_ID}`]);
	assert.deepEqual(h.shows, []);
	assert.deepEqual(h.notices, [CONNECTED_NOTICE]);
	assert.equal(record.outcome, "passed");
	assert.equal(record.error, null);
	assert.equal(record.result.reconnecting, true);
	assert.equal(record.result.entryOutcome, "match");
	assert.equal(record.result.plan, "registerWith");
	assert.equal(record.result.publicKeyHex, TEST_PUBLIC_KEY);
	assert.equal(record.result.seedStored, true);
	assert.equal(record.result.replacedPreviousSeed, true);
	assert.equal(h.session.current(), builder.sdk);

	const cancelled = await refusedEntry(null, true, "cancelled", "phrase-entry");
	assert.deepEqual(cancelled.session.builder.checked, []);
	const invalid = await refusedEntry(INVALID_PHRASE, true, "invalid", "phrase-entry");
	assert.deepEqual(invalid.session.builder.checked, []);
	const mismatch = await refusedEntry(TEST_PHRASE, false, "mismatch", "matchesExistingAppKey");
	assert.deepEqual(mismatch.session.builder.checked, [TEST_PHRASE]);
});

test("remove credential clears the seed and discards the session, after which a gated command is refused", async () => {
	const h = fakeContext();
	storeSeed(h.secrets, TEST_SEED);
	h.session.live = h.session.stored;
	await runRemoveCredential(h.ctx);
	const record = onlyRecord<RemoveCredentialResult>(h);
	assert.equal(record.command, "remove-credential");
	assert.equal(record.outcome, "passed");
	assert.equal(record.error, null);
	assert.deepEqual(record.result, { hadSeed: true, method: "setSecret-empty", connectionDiscarded: true });
	assert.equal(h.secrets.values.get(SECRET_ID), "");
	assert.equal(readSeed(h.secrets), null);
	assert.equal(h.session.discardCalls, 1);
	assert.equal(h.session.current(), null);
	assert.deepEqual(h.notices, [REMOVED_NOTICE]);
	const afterRemoval = startRecord(h.ctx, "upload", {});
	assert.equal(await requireSdk(h.ctx, afterRemoval), null);
	assert.equal(afterRemoval.outcome, "refused");
	assert.equal(afterRemoval.error?.step, "credential");
	assert.deepEqual(h.session.connectStoredCalls, []);
	assert.equal(h.records().length, 1);

	const empty = fakeContext();
	await runRemoveCredential(empty.ctx);
	const second = onlyRecord<RemoveCredentialResult>(empty);
	assert.equal(second.outcome, "passed");
	assert.equal(second.error, null);
	assert.deepEqual(second.result, { hadSeed: false, method: "setSecret-empty", connectionDiscarded: false });
	assert.equal(empty.secrets.values.get(SECRET_ID), "");
	assert.equal(empty.session.discardCalls, 1);
	assert.deepEqual(empty.notices, [REMOVED_NOTICE]);
	const gated = startRecord(empty.ctx, "upload", {});
	assert.equal(await requireSdk(empty.ctx, gated), null);
	assert.equal(gated.outcome, "refused");
	assert.equal(gated.error?.step, "credential");
	assert.equal(gated.error?.kind, "refusal");
	assert.ok(empty.notices.includes(NO_CREDENTIAL_NOTICE));
	assert.equal(empty.session.connectStoredCalls.length, 0);
	assert.equal(empty.records().length, 1);
});

test("the capability gate refuses connect before any SDK call and names the missing capability", async () => {
	const h = fakeContext({ platform: { isSecureContext: false } });
	const record = await connect(h);
	assert.deepEqual(h.session.builder.calls, []);
	assert.deepEqual(h.session.createBuilderUrls, []);
	assert.equal(h.session.initCalls, 0);
	assert.equal(h.notices.length, 1);
	const [notice] = h.notices;
	assert.ok(notice !== undefined);
	assert.ok(notice.includes("isSecureContext"));
	assert.ok(notice.includes(MINIMUM_PLATFORMS));
	assert.equal(record.outcome, "refused");
	assert.equal(record.error?.step, "capability");
	assert.equal(record.error?.kind, "refusal");
	assert.equal(record.result.publicKeyHex, "");
	assert.deepEqual(storeCalls(h), []);
	assert.deepEqual(h.opened, []);
	assert.deepEqual(h.shows, []);

	const transport = fakeContext({ platform: { webTransportType: "undefined" } });
	const refused = await connect(transport);
	assert.equal(transport.session.initCalls, 0);
	assert.equal(refused.outcome, "refused");
	assert.equal(refused.error?.step, "capability");
	assert.equal(transport.notices.length, 1);
	assert.ok(transport.notices[0]?.includes("WebTransport"));
});

test("a connect whose record path exists writes exactly one new file with the -2 suffix", async () => {
	const h = fakeContext();
	await h.vault.createFolder(PROOF_FOLDER);
	await h.vault.createFolder(RECORDS_FOLDER);
	await h.vault.createText(`${RECORDS_FOLDER}/${STEM}.json`, "{}");
	const before = h.vault.log.length;
	await runConnect(h.ctx, new FakeTimers());
	assert.deepEqual(h.vault.log.slice(before), [`createText:${RECORDS_FOLDER}/${STEM}-2.json`]);
	assert.equal(h.records().length, 2);
	assert.equal(h.vault.text(`${RECORDS_FOLDER}/${STEM}.json`), "{}");
	const record = JSON.parse(h.vault.text(`${RECORDS_FOLDER}/${STEM}-2.json`)) as CommandRecord<ConnectResult>;
	assert.equal(record.command, "connect");
	assert.equal(record.outcome, "passed");
	assert.equal(record.result.publicKeyHex, TEST_PUBLIC_KEY);
});
