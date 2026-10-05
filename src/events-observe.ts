import type { EventCursor, RecordedEvent } from "./context.ts";

export type PassName = "create" | "update" | "deletion" | "incremental";

export interface RecordedPage {
	pass: PassName;
	page: number;
	cursorSent: EventCursor | null;
	limit: number;
	count: number;
	events: RecordedEvent[];
}

export type Tri = boolean | "not applicable";

export interface Observations {
	a: { createDistinct: number };
	b: { updateDistinct: number; laterThanCreate: Tri };
	c: { deletionDistinct: number; tombstoneSeen: boolean };
	d: Record<PassName, boolean>;
	e: { incrementalDistinct: number; allLaterThanDeletionCursor: Tri };
}

export function nextCursor(page: RecordedEvent[], previous: EventCursor | null): EventCursor | null {
	const last = page[page.length - 1];
	if (last === undefined) {
		return previous;
	}
	return { id: last.id, after: last.updatedAt };
}

export function distinctEvents(events: RecordedEvent[]): RecordedEvent[] {
	const seen = new Set<string>();
	const distinct: RecordedEvent[] = [];
	for (const event of events) {
		const key = eventKey(event);
		if (!seen.has(key)) {
			seen.add(key);
			distinct.push(event);
		}
	}
	return distinct;
}

export function computeObservations(pages: RecordedPage[], probeId: string, deletionCursorEvent: RecordedEvent | null): Observations {
	const createProbe = distinctProbeEvents(pages, "create", probeId);
	const updateProbe = distinctProbeEvents(pages, "update", probeId);
	const deletionProbe = distinctProbeEvents(pages, "deletion", probeId);
	const incremental = distinctEvents(eventsOfPass(pages, "incremental"));
	return {
		a: { createDistinct: createProbe.length },
		b: { updateDistinct: updateProbe.length, laterThanCreate: laterThan(updateProbe, createProbe) },
		c: { deletionDistinct: deletionProbe.length, tombstoneSeen: deletionProbe.some(isTombstone) },
		d: {
			create: spansPages(pages, "create"),
			update: spansPages(pages, "update"),
			deletion: spansPages(pages, "deletion"),
			incremental: spansPages(pages, "incremental"),
		},
		e: { incrementalDistinct: incremental.length, allLaterThanDeletionCursor: allLaterThan(incremental, deletionCursorEvent) },
	};
}

function eventKey(event: RecordedEvent): string {
	return `${event.id}|${event.deleted}|${event.updatedAt}`;
}

function pagesOfPass(pages: readonly RecordedPage[], pass: PassName): RecordedPage[] {
	return pages.filter((page) => page.pass === pass);
}

function eventsOfPass(pages: readonly RecordedPage[], pass: PassName): RecordedEvent[] {
	return pagesOfPass(pages, pass).flatMap((page) => page.events);
}

function distinctProbeEvents(pages: readonly RecordedPage[], pass: PassName, probeId: string): RecordedEvent[] {
	return distinctEvents(eventsOfPass(pages, pass).filter((event) => event.id === probeId));
}

function isTombstone(event: RecordedEvent): boolean {
	return event.deleted && !event.objectPresent;
}

function latestUpdatedAt(events: readonly RecordedEvent[]): number | null {
	if (events.length === 0) {
		return null;
	}
	return Math.max(...events.map((event) => Date.parse(event.updatedAt)));
}

function laterThan(events: readonly RecordedEvent[], reference: readonly RecordedEvent[]): Tri {
	const latest = latestUpdatedAt(events);
	const referenceLatest = latestUpdatedAt(reference);
	if (latest === null || referenceLatest === null) {
		return "not applicable";
	}
	return latest > referenceLatest;
}

function allLaterThan(events: readonly RecordedEvent[], cursorEvent: RecordedEvent | null): Tri {
	if (cursorEvent === null) {
		return "not applicable";
	}
	const cursorTime = Date.parse(cursorEvent.updatedAt);
	return events.every((event) => Date.parse(event.updatedAt) > cursorTime);
}

function spansPages(pages: readonly RecordedPage[], pass: PassName): boolean {
	const pagesById = new Map<string, Set<number>>();
	for (const page of pagesOfPass(pages, pass)) {
		for (const event of page.events) {
			const seen = pagesById.get(event.id) ?? new Set<number>();
			seen.add(page.page);
			pagesById.set(event.id, seen);
		}
	}
	return [...pagesById.values()].some((seen) => seen.size > 1);
}
