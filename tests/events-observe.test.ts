import assert from "node:assert/strict";
import { test } from "node:test";
import type { EventCursor, RecordedEvent } from "../src/context.ts";
import {
	type PassName,
	type RecordedPage,
	computeObservations,
	distinctEvents,
	nextCursor,
} from "../src/events-observe.ts";
import { forAll, type Gen } from "./gen.ts";

const PASSES: PassName[] = ["create", "update", "deletion", "incremental"];
const LIMIT = 2;
const BASE = Date.parse("2026-10-12T00:00:00.000Z");
const PROBE = "probe";
const OTHER = "other";
const NO_SPAN: Record<PassName, boolean> = { create: false, update: false, deletion: false, incremental: false };

const at = (seconds: number): string => new Date(BASE + seconds * 1000).toISOString();

const event = (id: string, updatedAt: string, deleted = false, objectPresent = !deleted): RecordedEvent => ({
	id,
	deleted,
	updatedAt,
	objectPresent,
});

const page = (pass: PassName, pageNumber: number, events: RecordedEvent[], cursorSent: EventCursor | null = null): RecordedPage => ({
	pass,
	page: pageNumber,
	cursorSent,
	limit: LIMIT,
	count: events.length,
	events,
});

const CREATED = event(PROBE, at(1));
const UPDATED = event(PROBE, at(2));
const TOMBSTONE = event(PROBE, at(3), true, false);
const SCENARIO: RecordedPage[] = [
	page("create", 1, [event(OTHER, at(0)), CREATED]),
	page("update", 1, [UPDATED]),
	page("deletion", 1, [TOMBSTONE]),
	page("incremental", 1, [event(OTHER, at(4))]),
];

const without = (pages: readonly RecordedPage[], pass: PassName): RecordedPage[] => pages.filter((p) => p.pass !== pass);

const copyPages = (pages: readonly RecordedPage[]): RecordedPage[] =>
	pages.map((p) => ({ ...p, events: p.events.map((e) => ({ ...e })) }));

function genEvent(g: Gen, pool: readonly string[]): RecordedEvent {
	return { id: g.pick(pool), deleted: g.bool(), updatedAt: at(g.int(0, 10_000)), objectPresent: g.bool() };
}

function genPass(g: Gen, pass: PassName, pool: readonly string[]): RecordedPage[] {
	const pages: RecordedPage[] = [];
	const count = g.int(0, 4);
	let cursor: EventCursor | null = null;
	for (let pageNumber = 1; pageNumber <= count; pageNumber += 1) {
		const events = Array.from({ length: g.int(0, 2) }, () => genEvent(g, pool));
		pages.push(page(pass, pageNumber, events, cursor));
		cursor = nextCursor(events, cursor);
	}
	return pages;
}

function lastEvent(pages: readonly RecordedPage[], pass: PassName): RecordedEvent | null {
	const events = pages.filter((p) => p.pass === pass).flatMap((p) => p.events);
	return events[events.length - 1] ?? null;
}

function sample<T>(g: Gen, list: readonly T[], n: number): T[] {
	const pool = [...list];
	const chosen: T[] = [];
	while (chosen.length < n) {
		chosen.push(...pool.splice(g.int(0, pool.length - 1), 1));
	}
	return chosen;
}

function repeatEvents(g: Gen, pages: RecordedPage[], pass: PassName): boolean {
	const own = pages.filter((p) => p.pass === pass);
	const sources = own.slice(0, -1).filter((p) => p.events.length > 0);
	if (sources.length === 0) {
		return false;
	}
	for (let n = g.int(1, 2); n > 0; n -= 1) {
		const source = g.pick(sources);
		const target = g.pick(own.filter((p) => p.page > source.page));
		target.events.push(...sample(g, source.events, g.int(1, source.events.length)).map((e) => ({ ...e })));
		target.count = target.events.length;
	}
	return true;
}

test("foliospindle-proof Property 5: Observations are invariant under repeated events", async () => {
	let withRepetition = 0;
	await forAll(200, (g) => {
		const pool = Array.from({ length: g.int(1, 6) }, (_, i) => `id${i}`);
		const probeId = g.pick(pool);
		const pages = PASSES.flatMap((pass) => genPass(g, pass, pool));
		const cursorEvent = lastEvent(pages, "deletion");
		const original = computeObservations(pages, probeId, cursorEvent);
		const repeated = copyPages(pages);
		const repeatedPasses = PASSES.filter((pass) => repeatEvents(g, repeated, pass));
		const observed = computeObservations(repeated, probeId, cursorEvent);
		const label = JSON.stringify({ probeId, pages, repeated });
		assert.deepEqual(observed.a, original.a, label);
		assert.deepEqual(observed.b, original.b, label);
		assert.deepEqual(observed.c, original.c, label);
		assert.deepEqual(observed.e, original.e, label);
		for (const pass of PASSES) {
			assert.equal(observed.d[pass], repeatedPasses.includes(pass) ? true : original.d[pass], `${pass}: ${label}`);
		}
		withRepetition += repeatedPasses.length > 0 ? 1 : 0;
	});
	assert.ok(withRepetition >= 100, `only ${withRepetition} iterations had a repetition`);
});

test("nextCursor keeps the previous cursor on an empty page and follows the last event otherwise", () => {
	const previous: EventCursor = { id: OTHER, after: at(0) };
	assert.equal(nextCursor([], null), null);
	assert.equal(nextCursor([], previous), previous);
	assert.deepEqual(nextCursor([event(OTHER, at(0)), CREATED], null), { id: PROBE, after: at(1) });
	assert.deepEqual(nextCursor([UPDATED, TOMBSTONE], previous), { id: PROBE, after: at(3) });
});

test("distinctEvents keys on id, deleted and updatedAt and keeps first occurrences in order", () => {
	const other = event(OTHER, at(1));
	const deletedPresent = event(PROBE, at(1), true, true);
	const events = [CREATED, other, { ...CREATED, objectPresent: false }, deletedPresent, UPDATED, { ...deletedPresent, objectPresent: false }, other];
	assert.deepEqual(distinctEvents(events), [CREATED, other, deletedPresent, UPDATED]);
	assert.deepEqual(distinctEvents([]), []);
});

test("a create, update, deletion and incremental run with a tombstone", () => {
	assert.deepEqual(computeObservations(SCENARIO, PROBE, TOMBSTONE), {
		a: { createDistinct: 1 },
		b: { updateDistinct: 1, laterThanCreate: true },
		c: { deletionDistinct: 1, tombstoneSeen: true },
		d: NO_SPAN,
		e: { incrementalDistinct: 1, allLaterThanDeletionCursor: true },
	});
});

test("laterThanCreate is not applicable when either pass has no probe event", () => {
	const noUpdate = [...without(SCENARIO, "update"), page("update", 1, [event(OTHER, at(2))])];
	assert.deepEqual(computeObservations(noUpdate, PROBE, TOMBSTONE).b, { updateDistinct: 0, laterThanCreate: "not applicable" });
	const noCreate = [...without(SCENARIO, "create"), page("create", 1, [event(OTHER, at(0))])];
	const observed = computeObservations(noCreate, PROBE, TOMBSTONE);
	assert.deepEqual(observed.a, { createDistinct: 0 });
	assert.deepEqual(observed.b, { updateDistinct: 1, laterThanCreate: "not applicable" });
});

test("laterThanCreate is false when the update pass is not strictly later", () => {
	const same = [...without(SCENARIO, "update"), page("update", 1, [{ ...CREATED }])];
	assert.deepEqual(computeObservations(same, PROBE, TOMBSTONE).b, { updateDistinct: 1, laterThanCreate: false });
});

test("tombstoneSeen needs deleted true with the object absent", () => {
	const present = [...without(SCENARIO, "deletion"), page("deletion", 1, [event(PROBE, at(3), true, true)])];
	assert.deepEqual(computeObservations(present, PROBE, TOMBSTONE).c, { deletionDistinct: 1, tombstoneSeen: false });
});

test("allLaterThanDeletionCursor per incremental outcome", () => {
	assert.deepEqual(computeObservations(SCENARIO, PROBE, null).e, { incrementalDistinct: 1, allLaterThanDeletionCursor: "not applicable" });
	const empty = [...without(SCENARIO, "incremental"), page("incremental", 1, [])];
	assert.deepEqual(computeObservations(empty, PROBE, TOMBSTONE).e, { incrementalDistinct: 0, allLaterThanDeletionCursor: true });
	assert.deepEqual(computeObservations(without(SCENARIO, "incremental"), PROBE, TOMBSTONE).e, { incrementalDistinct: 0, allLaterThanDeletionCursor: true });
	const echoed = [...without(SCENARIO, "incremental"), page("incremental", 1, [{ ...TOMBSTONE }])];
	assert.deepEqual(computeObservations(echoed, PROBE, TOMBSTONE).e, { incrementalDistinct: 1, allLaterThanDeletionCursor: false });
});

test("an id on two pages of a pass sets observation (d) for that pass only", () => {
	const first = page("create", 1, [event(OTHER, at(0)), CREATED]);
	const spanning = [first, page("create", 2, [{ ...CREATED }], nextCursor(first.events, null))];
	assert.deepEqual(computeObservations(spanning, PROBE, null).d, { ...NO_SPAN, create: true });
	const samePage = [page("create", 1, [CREATED, { ...CREATED }])];
	assert.deepEqual(computeObservations(samePage, PROBE, null).d, NO_SPAN);
});
