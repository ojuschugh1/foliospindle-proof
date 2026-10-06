import assert from "node:assert/strict";
import { test } from "node:test";
import { EVENTS_COMPLETE_NOTICE, EVENTS_TITLE, type EventsResult, PAGE_LIMIT, PAGE_SIZE, PageLimitError, type StepOutcome, runEvents, runPass } from "../src/commands/events.ts";
import type { EventCursor, PlatformClass, RecordedEvent } from "../src/context.ts";
import { storeSeed } from "../src/credential.ts";
import { utf8Decode } from "../src/encoding.ts";
import { type PassName, type RecordedPage, computeObservations, nextCursor } from "../src/events-observe.ts";
import type { Receipt } from "../src/receipt.ts";
import type { CommandRecord } from "../src/records.ts";
import { EPOCH_ISO, FakeSdk, type Harness, type HarnessOverrides, TEST_SEED, fakeContext } from "./fakes.ts";

interface FailureCase {
	failure: string;
	step: string;
	calls: number;
	pages: number;
	deleteCompleted: boolean;
	probeId: string | null;
}

const PROBE_ID = "1001";
const RECEIPT_PROBE_ID = "dd04";
const OTHER = "other";
const BASE = Date.parse("2026-10-12T00:00:00.000Z");
const PROBE_BYTES = `probe-${EPOCH_ISO}-`.length + 16;
const PROBE_PATTERN = /^probe-\d{4}-\d{2}-\d{2}T[\d:.]+Z-[0-9a-f]{16}$/;
const METADATA_BYTES = `probe-metadata-${EPOCH_ISO}`.length;
const PAGE_LIMIT_NOTICE = "Event pass create reached the 1,000 page limit";
const PASSES: PassName[] = ["create", "update", "deletion", "incremental"];
const PAGE_KEYS = ["count", "cursorSent", "events", "limit", "page", "pass"];
const EVENT_KEYS = ["deleted", "id", "objectPresent", "updatedAt"];
const NO_SPAN: Record<PassName, boolean> = { create: false, update: false, deletion: false, incremental: false };
const OK_STEP: StepOutcome = { attempted: true, ok: true, message: null, durationMs: 0 };
const NOT_ATTEMPTED: StepOutcome = { attempted: false, ok: false, message: null, durationMs: null };

const at = (seconds: number): string => new Date(BASE + seconds * 1000).toISOString();

const event = (id: string, updatedAt: string, deleted = false, objectPresent = !deleted): RecordedEvent => ({ id, deleted, updatedAt, objectPresent });

const cursorOf = (e: RecordedEvent): EventCursor => ({ id: e.id, after: e.updatedAt });

const eventsCall = (cursor: EventCursor | null): string => `objectEvents:${JSON.stringify(cursor)}:${PAGE_SIZE}`;

const fullPage = (index: number): RecordedEvent[] => [event("x", at(2 * index)), event("y", at(2 * index + 1))];

const fullPages = (count: number): RecordedEvent[][] => Array.from({ length: count }, (_, index) => fullPage(index));

const CREATED = event(PROBE_ID, at(1));
const UPDATED = event(PROBE_ID, at(2));
const TOMBSTONE = event(PROBE_ID, at(3), true, false);
const O0 = event(OTHER, at(0));
const O2 = event("o2", at(2));
const O3 = event("o3", at(3));
const O9 = event("o9", at(9));
const SCENARIO_PAGES: RecordedEvent[][] = [[CREATED], [UPDATED], [TOMBSTONE], []];
const SCENARIO_CALLS = [
	`upload:${PROBE_BYTES}`,
	`pin:${PROBE_ID}`,
	eventsCall(null),
	`updateMetadata:${PROBE_ID}:${METADATA_BYTES}`,
	eventsCall(null),
	`deleteObject:${PROBE_ID}`,
	eventsCall(null),
	eventsCall(cursorOf(TOMBSTONE)),
];
const AUTHORITY_CALLS = [`object:${RECEIPT_PROBE_ID}`, `updateMetadata:${RECEIPT_PROBE_ID}:${METADATA_BYTES}`, `deleteObject:${RECEIPT_PROBE_ID}`];
const SPANNING: Record<PassName, RecordedEvent[][]> = {
	create: [[O0, CREATED], [CREATED, O2], [O3]],
	update: [[]],
	deletion: [[O0, TOMBSTONE], []],
	incremental: [[O9]],
};

const FAILURES: FailureCase[] = [
	{ failure: "upload", step: "upload", calls: 1, pages: 0, deleteCompleted: false, probeId: null },
	{ failure: "pin", step: "pin", calls: 2, pages: 0, deleteCompleted: false, probeId: null },
	{ failure: "objectEvents#1", step: "create", calls: 3, pages: 0, deleteCompleted: false, probeId: PROBE_ID },
	{ failure: "updateMetadata", step: "updateMetadata", calls: 4, pages: 1, deleteCompleted: false, probeId: PROBE_ID },
	{ failure: "objectEvents#2", step: "update", calls: 5, pages: 1, deleteCompleted: false, probeId: PROBE_ID },
	{ failure: "deleteObject", step: "deleteObject", calls: 6, pages: 2, deleteCompleted: false, probeId: PROBE_ID },
	{ failure: "objectEvents#3", step: "deletion", calls: 7, pages: 2, deleteCompleted: true, probeId: PROBE_ID },
	{ failure: "objectEvents#4", step: "incremental", calls: 8, pages: 3, deleteCompleted: true, probeId: PROBE_ID },
];

function eventsHarness(overrides: HarnessOverrides = {}): { h: Harness; sdk: FakeSdk } {
	const h = fakeContext(overrides);
	storeSeed(h.secrets, TEST_SEED);
	const sdk = h.session.stored;
	assert.ok(sdk instanceof FakeSdk);
	return { h, sdk };
}

function scriptPages(sdk: FakeSdk, pages: RecordedEvent[][]): void {
	sdk.eventPages = pages.map((page) => [...page]);
}

function onlyRecord<T>(h: Harness): CommandRecord<T> {
	const records = h.records();
	assert.equal(records.length, 1);
	return records[0] as CommandRecord<T>;
}

async function observe(h: Harness): Promise<CommandRecord<EventsResult>> {
	await runEvents(h.ctx);
	return onlyRecord<EventsResult>(h);
}

function pagesOf(record: CommandRecord<EventsResult>, pass: PassName): RecordedPage[] {
	return record.result.pages.filter((page) => page.pass === pass);
}

function lastEventOf(record: CommandRecord<EventsResult>, pass: PassName): RecordedEvent | null {
	const events = pagesOf(record, pass).flatMap((page) => page.events);
	return events[events.length - 1] ?? null;
}

function shownText(h: Harness): string {
	assert.deepEqual(h.shows.map((shown) => shown.title), [EVENTS_TITLE]);
	return h.shows[0]?.text ?? "";
}

function receiptFor(label: PlatformClass): Receipt {
	return {
		formatVersion: 1,
		sdkVersion: __SDK_VERSION__,
		platformLabel: label,
		uploadedAt: EPOCH_ISO,
		objects: [
			{ name: "fixture-a.md", bytes: 6203, sha256: "0a".repeat(32), objectId: "aa01", uploadMs: 100 },
			{ name: "fixture-b.md", bytes: 12222, sha256: "1b".repeat(32), objectId: "bb02", uploadMs: 100 },
			{ name: "attachment.bin", bytes: 262144, sha256: "2c".repeat(32), objectId: "cc03", uploadMs: 100 },
			{ name: "probe", bytes: PROBE_BYTES, sha256: "3d".repeat(32), objectId: RECEIPT_PROBE_ID, uploadMs: 100 },
		],
	};
}

test("the sequence runs upload, pin, create pass, updateMetadata, update pass, deleteObject, deletion pass and incremental pass in order", async () => {
	const { h, sdk } = eventsHarness();
	scriptPages(sdk, SCENARIO_PAGES);
	const record = await observe(h);
	assert.equal(record.command, "events");
	assert.equal(record.outcome, "passed");
	assert.equal(record.error, null);
	assert.equal(record.reconnect?.method, "connected");
	assert.equal(record.reconnect?.outcome, "ok");
	assert.equal(record.init?.firstInThisLoad, true);
	assert.deepEqual(sdk.calls, SCENARIO_CALLS);
	assert.deepEqual(sdk.eventPages, []);
	assert.equal(record.result.probeId, PROBE_ID);
	const probeBytes = sdk.contents.get(PROBE_ID);
	assert.ok(probeBytes !== undefined);
	assert.equal(probeBytes.length, PROBE_BYTES);
	const probeText = utf8Decode(probeBytes) ?? "";
	assert.match(probeText, PROBE_PATTERN);
	assert.ok(probeText.startsWith(`probe-${EPOCH_ISO}-`));
	assert.equal(record.result.metadataPayloadBytes, METADATA_BYTES);
	assert.ok(record.result.metadataPayloadBytes >= 1 && record.result.metadataPayloadBytes <= 256);
	assert.equal(record.result.deleteCompleted, true);
	assert.deepEqual(record.result.savedCursors, { create: cursorOf(CREATED), update: cursorOf(UPDATED), deletion: cursorOf(TOMBSTONE), incremental: null });
	assert.equal(record.result.authority, null);
	assert.deepEqual(h.notices, [EVENTS_COMPLETE_NOTICE]);
	const text = shownText(h);
	assert.ok(text.includes("coalesced current-state feed"));
	assert.ok(text.includes(`Probe object: ${PROBE_ID}`));
	assert.deepEqual(h.settings.saves, []);
	assert.deepEqual(h.prompts, []);
});

test("a pass ends on a page with fewer than 2 events, each next cursor is the last event's id and updatedAt, and the incremental pass starts from the saved deletion cursor", async () => {
	const { h, sdk } = eventsHarness();
	scriptPages(sdk, PASSES.flatMap((pass) => SPANNING[pass]));
	const record = await observe(h);
	assert.equal(record.outcome, "passed");
	assert.deepEqual(pagesOf(record, "create").map((page) => [page.cursorSent, page.count]), [[null, 2], [cursorOf(CREATED), 2], [cursorOf(O2), 1]]);
	assert.deepEqual(pagesOf(record, "update").map((page) => [page.cursorSent, page.count]), [[null, 0]]);
	assert.deepEqual(pagesOf(record, "deletion").map((page) => [page.cursorSent, page.count]), [[null, 2], [cursorOf(TOMBSTONE), 0]]);
	assert.deepEqual(pagesOf(record, "incremental").map((page) => [page.cursorSent, page.count]), [[record.result.savedCursors.deletion, 1]]);
	assert.deepEqual(record.result.savedCursors, { create: cursorOf(O3), update: null, deletion: cursorOf(TOMBSTONE), incremental: cursorOf(O9) });
	assert.deepEqual(sdk.calls.filter((call) => call.startsWith("objectEvents:")), [
		eventsCall(null),
		eventsCall(cursorOf(CREATED)),
		eventsCall(cursorOf(O2)),
		eventsCall(null),
		eventsCall(null),
		eventsCall(cursorOf(TOMBSTONE)),
		eventsCall(cursorOf(TOMBSTONE)),
	]);
	assert.deepEqual(sdk.eventPages, []);
});

test("a deletion pass without events saves the empty cursor, starts the incremental pass from it and marks observation (e) not applicable", async () => {
	const { h, sdk } = eventsHarness();
	scriptPages(sdk, [[CREATED], [UPDATED], [], [O9]]);
	const record = await observe(h);
	assert.equal(record.outcome, "passed");
	assert.deepEqual(record.result.savedCursors, { create: cursorOf(CREATED), update: cursorOf(UPDATED), deletion: null, incremental: cursorOf(O9) });
	assert.deepEqual(pagesOf(record, "deletion"), [{ pass: "deletion", page: 1, cursorSent: null, limit: PAGE_SIZE, count: 0, events: [] }]);
	assert.deepEqual(pagesOf(record, "incremental").map((page) => page.cursorSent), [null]);
	assert.deepEqual(sdk.calls.filter((call) => call.startsWith("objectEvents:")), [eventsCall(null), eventsCall(null), eventsCall(null), eventsCall(null)]);
	assert.deepEqual(record.result.observations?.c, { deletionDistinct: 0, tombstoneSeen: false });
	assert.deepEqual(record.result.observations?.e, { incrementalDistinct: 1, allLaterThanDeletionCursor: "not applicable" });
	assert.deepEqual(record.result.observations, computeObservations(record.result.pages, PROBE_ID, null));
});

test("every page record carries pass, page, cursorSent, limit, count and the events with id, deleted, updatedAt and objectPresent", async () => {
	const { h, sdk } = eventsHarness();
	scriptPages(sdk, PASSES.flatMap((pass) => SPANNING[pass]));
	const record = await observe(h);
	assert.equal(record.outcome, "passed");
	assert.deepEqual(record.result.pages.map((page) => page.pass), PASSES.flatMap((pass) => SPANNING[pass].map(() => pass)));
	for (const pass of PASSES) {
		const pages = pagesOf(record, pass);
		assert.deepEqual(pages.map((page) => page.page), SPANNING[pass].map((_, index) => index + 1), pass);
		assert.deepEqual(pages.map((page) => page.events), SPANNING[pass], pass);
		for (const page of pages) {
			assert.deepEqual(Object.keys(page).sort(), PAGE_KEYS, pass);
			assert.equal(page.limit, PAGE_SIZE, pass);
			assert.equal(page.count, page.events.length, pass);
			for (const e of page.events) {
				assert.deepEqual(Object.keys(e).sort(), EVENT_KEYS, pass);
			}
		}
	}
});

test("observations are computeObservations over the recorded pages with the deletion pass's last event as the cursor event", async () => {
	const { h, sdk } = eventsHarness();
	scriptPages(sdk, SCENARIO_PAGES);
	const record = await observe(h);
	assert.deepEqual(lastEventOf(record, "deletion"), TOMBSTONE);
	assert.deepEqual(record.result.observations, computeObservations(record.result.pages, PROBE_ID, TOMBSTONE));
	assert.deepEqual(record.result.observations, {
		a: { createDistinct: 1 },
		b: { updateDistinct: 1, laterThanCreate: true },
		c: { deletionDistinct: 1, tombstoneSeen: true },
		d: NO_SPAN,
		e: { incrementalDistinct: 0, allLaterThanDeletionCursor: true },
	});
	const spanning = eventsHarness();
	scriptPages(spanning.sdk, PASSES.flatMap((pass) => SPANNING[pass]));
	const spanningRecord = await observe(spanning.h);
	assert.deepEqual(lastEventOf(spanningRecord, "deletion"), TOMBSTONE);
	assert.deepEqual(spanningRecord.result.observations, computeObservations(spanningRecord.result.pages, PROBE_ID, TOMBSTONE));
	assert.deepEqual(spanningRecord.result.observations, {
		a: { createDistinct: 1 },
		b: { updateDistinct: 0, laterThanCreate: "not applicable" },
		c: { deletionDistinct: 1, tombstoneSeen: true },
		d: { ...NO_SPAN, create: true },
		e: { incrementalDistinct: 1, allLaterThanDeletionCursor: true },
	});
});

test("a failure at any SDK step stops the sequence, names the step, keeps the pages so far and records deleteCompleted", async () => {
	for (const c of FAILURES) {
		const { h, sdk } = eventsHarness({ settings: { receipt: receiptFor("ios") } });
		scriptPages(sdk, SCENARIO_PAGES);
		const message = `${c.failure} rejected`;
		sdk.failures.set(c.failure, new Error(message));
		const record = await observe(h);
		assert.equal(record.outcome, "failed", c.failure);
		assert.equal(record.error?.kind, "error", c.failure);
		assert.equal(record.error?.step, c.step, c.failure);
		assert.equal(record.error?.message, message, c.failure);
		assert.equal(record.error?.transportHint, false, c.failure);
		assert.deepEqual(sdk.calls, SCENARIO_CALLS.slice(0, c.calls), c.failure);
		assert.equal(record.result.pages.length, c.pages, c.failure);
		assert.deepEqual(record.result.pages.map((page) => page.pass), PASSES.slice(0, c.pages), c.failure);
		assert.equal(record.result.deleteCompleted, c.deleteCompleted, c.failure);
		assert.equal(record.result.probeId, c.probeId, c.failure);
		assert.equal(record.result.observations, null, c.failure);
		assert.equal(record.result.authority, null, c.failure);
		assert.deepEqual(h.notices, [`Event sequence stopped at ${c.step}: ${message}`], c.failure);
		assert.deepEqual(h.shows, [], c.failure);
		assert.deepEqual(h.settings.saves, [], c.failure);
	}
});

test("reaching 1,000 pages in a pass fails the run with kind page-limit and keeps the 1,000 recorded pages", async () => {
	const { h, sdk } = eventsHarness();
	scriptPages(sdk, fullPages(PAGE_LIMIT + 1));
	const record = await observe(h);
	assert.equal(record.outcome, "failed");
	assert.equal(record.error?.kind, "page-limit");
	assert.equal(record.error?.step, "create");
	assert.equal(record.error?.message, PAGE_LIMIT_NOTICE);
	assert.deepEqual(h.notices, [PAGE_LIMIT_NOTICE]);
	assert.deepEqual(h.shows, []);
	assert.equal(record.result.probeId, PROBE_ID);
	assert.equal(record.result.pages.length, PAGE_LIMIT);
	assert.equal(pagesOf(record, "create").length, PAGE_LIMIT);
	assert.equal(record.result.deleteCompleted, false);
	assert.equal(record.result.observations, null);
	assert.deepEqual(record.result.savedCursors, { create: null, update: null, deletion: null, incremental: null });
	assert.deepEqual(sdk.calls.slice(0, 2), SCENARIO_CALLS.slice(0, 2));
	assert.equal(sdk.calls.length, 2 + PAGE_LIMIT);
	assert.equal(sdk.eventPages.length, 1);
	const last = record.result.pages[PAGE_LIMIT - 1];
	assert.equal(last?.page, PAGE_LIMIT);
	assert.deepEqual(last?.cursorSent, nextCursor(fullPage(PAGE_LIMIT - 2), null));
	assert.deepEqual(last?.events, fullPage(PAGE_LIMIT - 1));
});

test("a cross-installation receipt adds the authority block with object, updateObjectMetadata and deleteObject on the receipt's probe", async () => {
	const { h, sdk } = eventsHarness({ settings: { receipt: receiptFor("ios") } });
	scriptPages(sdk, SCENARIO_PAGES);
	const record = await observe(h);
	assert.equal(record.outcome, "passed");
	assert.equal(record.error, null);
	assert.deepEqual(record.result.authority, { receiptProbeId: RECEIPT_PROBE_ID, objectFetch: OK_STEP, updateObjectMetadata: OK_STEP, deleteObject: OK_STEP });
	assert.deepEqual(sdk.calls, [...SCENARIO_CALLS, ...AUTHORITY_CALLS]);
	assert.equal(record.result.probeId, PROBE_ID);
	assert.deepEqual(h.notices, [EVENTS_COMPLETE_NOTICE]);
	assert.ok(shownText(h).includes(`Authority over the receipt's probe ${RECEIPT_PROBE_ID}`));
	assert.deepEqual(h.settings.saves, []);
	assert.deepEqual(h.settings.value.receipt, receiptFor("ios"));
});

test("a failed authority fetch skips updateObjectMetadata, still attempts deleteObject and leaves the run passed", async () => {
	const { h, sdk } = eventsHarness({ settings: { receipt: receiptFor("ios") } });
	scriptPages(sdk, SCENARIO_PAGES);
	sdk.failures.set("object", new Error("not found"));
	const record = await observe(h);
	assert.equal(record.outcome, "passed");
	assert.equal(record.error, null);
	assert.deepEqual(record.result.authority, {
		receiptProbeId: RECEIPT_PROBE_ID,
		objectFetch: { attempted: true, ok: false, message: "not found", durationMs: 0 },
		updateObjectMetadata: NOT_ATTEMPTED,
		deleteObject: OK_STEP,
	});
	assert.deepEqual(sdk.calls, [...SCENARIO_CALLS, `object:${RECEIPT_PROBE_ID}`, `deleteObject:${RECEIPT_PROBE_ID}`]);
	assert.deepEqual(h.notices, [EVENTS_COMPLETE_NOTICE]);
	assert.ok(shownText(h).includes("object failed: not found"));

	const refused = eventsHarness({ settings: { receipt: receiptFor("ios") } });
	scriptPages(refused.sdk, SCENARIO_PAGES);
	refused.sdk.failures.set("updateMetadata#2", new Error("metadata refused"));
	refused.sdk.failures.set("deleteObject#2", new Error("delete refused"));
	const refusedRecord = await observe(refused.h);
	assert.equal(refusedRecord.outcome, "passed");
	assert.deepEqual(refusedRecord.result.authority, {
		receiptProbeId: RECEIPT_PROBE_ID,
		objectFetch: OK_STEP,
		updateObjectMetadata: { attempted: true, ok: false, message: "metadata refused", durationMs: 0 },
		deleteObject: { attempted: true, ok: false, message: "delete refused", durationMs: 0 },
	});
	assert.deepEqual(refused.sdk.calls, [...SCENARIO_CALLS, ...AUTHORITY_CALLS]);
	assert.equal(refusedRecord.result.deleteCompleted, true);
	assert.deepEqual(refused.h.notices, [EVENTS_COMPLETE_NOTICE]);
});

test("the authority block is absent for a same-platform receipt and when no receipt is stored", async () => {
	const own = eventsHarness({ settings: { receipt: receiptFor("macos") } });
	scriptPages(own.sdk, SCENARIO_PAGES);
	const ownRecord = await observe(own.h);
	assert.equal(ownRecord.outcome, "passed");
	assert.equal(ownRecord.result.authority, null);
	assert.deepEqual(own.sdk.calls, SCENARIO_CALLS);
	assert.ok(!shownText(own.h).includes("Authority"));
	const none = eventsHarness();
	scriptPages(none.sdk, SCENARIO_PAGES);
	const noneRecord = await observe(none.h);
	assert.equal(noneRecord.outcome, "passed");
	assert.equal(noneRecord.result.authority, null);
	assert.deepEqual(none.sdk.calls, SCENARIO_CALLS);
	assert.equal(none.h.settings.value.receipt, null);
});

test("runPass returns the saved cursor and cursor event of the last event, or null for a pass without events", async () => {
	const sdk = new FakeSdk();
	const pages: RecordedPage[] = [];
	scriptPages(sdk, [[O0, CREATED], [O2]]);
	assert.deepEqual(await runPass(sdk, "create", null, (page) => { pages.push(page); }), { saved: cursorOf(O2), cursorEvent: O2 });
	assert.deepEqual(pages, [
		{ pass: "create", page: 1, cursorSent: null, limit: PAGE_SIZE, count: 2, events: [O0, CREATED] },
		{ pass: "create", page: 2, cursorSent: cursorOf(CREATED), limit: PAGE_SIZE, count: 1, events: [O2] },
	]);
	assert.deepEqual(sdk.calls, [eventsCall(null), eventsCall(cursorOf(CREATED))]);

	const trailing: RecordedPage[] = [];
	scriptPages(sdk, [[UPDATED, TOMBSTONE], []]);
	assert.deepEqual(await runPass(sdk, "deletion", null, (page) => { trailing.push(page); }), { saved: cursorOf(TOMBSTONE), cursorEvent: TOMBSTONE });
	assert.deepEqual(trailing.map((page) => [page.page, page.cursorSent, page.count]), [[1, null, 2], [2, cursorOf(TOMBSTONE), 0]]);

	const start = cursorOf(TOMBSTONE);
	const empty: RecordedPage[] = [];
	scriptPages(sdk, [[]]);
	assert.deepEqual(await runPass(sdk, "incremental", start, (page) => { empty.push(page); }), { saved: null, cursorEvent: null });
	assert.deepEqual(empty, [{ pass: "incremental", page: 1, cursorSent: start, limit: PAGE_SIZE, count: 0, events: [] }]);
	assert.deepEqual(sdk.calls.slice(-1), [eventsCall(start)]);
});

test("runPass throws PageLimitError naming its pass after 1,000 full pages", async () => {
	const sdk = new FakeSdk();
	const pages: RecordedPage[] = [];
	scriptPages(sdk, fullPages(PAGE_LIMIT + 1));
	await assert.rejects(runPass(sdk, "create", null, (page) => { pages.push(page); }), (error: unknown) => {
		assert.ok(error instanceof PageLimitError);
		assert.equal(error.pass, "create");
		assert.equal(error.name, "PageLimitError");
		assert.equal(error.message, PAGE_LIMIT_NOTICE);
		return true;
	});
	assert.equal(pages.length, PAGE_LIMIT);
	assert.equal(pages[PAGE_LIMIT - 1]?.page, PAGE_LIMIT);
	assert.equal(sdk.calls.length, PAGE_LIMIT);
	assert.equal(sdk.eventPages.length, 1);
});
