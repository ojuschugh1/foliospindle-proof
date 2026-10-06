import { failureText } from "../capability.ts";
import type { CommandContext, EventCursor, RecordedEvent } from "../context.ts";
import { toHex, utf8Encode } from "../encoding.ts";
import { type Observations, type PassName, type RecordedPage, computeObservations, nextCursor } from "../events-observe.ts";
import { isCrossInstallation } from "../receipt.ts";
import { writeRecord } from "../records.ts";
import type { SdkHandle } from "../sdk-adapter.ts";
import { errorMessage, finishRecord, requireCapability, requireInitialized, requireSdk, setFailure, startRecord } from "./session-steps.ts";

export interface StepOutcome {
	attempted: boolean;
	ok: boolean;
	message: string | null;
	durationMs: number | null;
}

export interface EventsResult {
	probeId: string | null;
	metadataPayloadBytes: number;
	pages: RecordedPage[];
	savedCursors: Record<PassName, EventCursor | null>;
	observations: Observations | null;
	deleteCompleted: boolean;
	authority: { receiptProbeId: string; objectFetch: StepOutcome; updateObjectMetadata: StepOutcome; deleteObject: StepOutcome } | null;
}

export const PAGE_LIMIT = 1000;
export const PAGE_SIZE = 2;
export const EVENTS_TITLE = "Object events";
export const EVENTS_COMPLETE_NOTICE = "Event observation complete";

const METADATA_MIN_BYTES = 1;
const METADATA_MAX_BYTES = 256;
const PASS_NAMES: readonly PassName[] = ["create", "update", "deletion", "incremental"];

type StepResult<T> = { ok: true; value: T } | { ok: false };

interface PassOutcome {
	saved: EventCursor | null;
	cursorEvent: RecordedEvent | null;
}

export class PageLimitError extends Error {
	pass: PassName;

	constructor(pass: PassName) {
		super(`Event pass ${pass} reached the 1,000 page limit`);
		this.name = "PageLimitError";
		this.pass = pass;
	}
}

export async function runPass(sdk: SdkHandle, name: PassName, start: EventCursor | null, record: (page: RecordedPage) => void): Promise<PassOutcome> {
	let cursor = start;
	let page = 1;
	let cursorEvent: RecordedEvent | null = null;
	for (;;) {
		const events = await sdk.objectEvents(cursor, PAGE_SIZE);
		record({ pass: name, page, cursorSent: cursor, limit: PAGE_SIZE, count: events.length, events });
		cursorEvent = events[events.length - 1] ?? cursorEvent;
		cursor = nextCursor(events, cursor);
		if (events.length < PAGE_SIZE) {
			return { saved: cursorEvent === null ? null : cursor, cursorEvent };
		}
		page += 1;
		if (page > PAGE_LIMIT) {
			throw new PageLimitError(name);
		}
	}
}

export async function runEvents(ctx: CommandContext): Promise<void> {
	const t0 = ctx.clock();
	const cls = ctx.platform.platformClass;
	const result: EventsResult = {
		probeId: null,
		metadataPayloadBytes: 0,
		pages: [],
		savedCursors: { create: null, update: null, deletion: null, incremental: null },
		observations: null,
		deleteCompleted: false,
		authority: null,
	};
	const record = startRecord(ctx, "events", result);
	const fail = (step: string, message: string): void => {
		ctx.notify(failureText(`Event sequence stopped at ${step}`, cls, message));
		setFailure(ctx, record, step, "error", message);
	};
	const step = async <T>(name: string, run: () => Promise<T>): Promise<StepResult<T>> => {
		try {
			return { ok: true, value: await run() };
		} catch (error) {
			if (error instanceof PageLimitError) {
				ctx.notify(error.message);
				setFailure(ctx, record, name, "page-limit", error.message);
			} else {
				fail(name, errorMessage(error));
			}
			return { ok: false };
		}
	};
	const recordPage = (page: RecordedPage): void => {
		result.pages.push(page);
	};
	const pass = (sdk: SdkHandle, name: PassName, start: EventCursor | null): Promise<StepResult<PassOutcome>> => step(name, () => runPass(sdk, name, start, recordPage));
	try {
		if (!(await requireCapability(ctx, record))) {
			return;
		}
		if (!(await requireInitialized(ctx, record))) {
			return;
		}
		const sdk = await requireSdk(ctx, record);
		if (sdk === null) {
			return;
		}
		const probeBytes = utf8Encode(`probe-${ctx.now().toISOString()}-${toHex(crypto.getRandomValues(new Uint8Array(8)))}`);
		const uploaded = await step("upload", () => sdk.upload(probeBytes));
		if (!uploaded.ok) {
			return;
		}
		const probe = uploaded.value;
		const pinned = await step("pin", () => sdk.pin(probe));
		if (!pinned.ok) {
			return;
		}
		const probeId = probe.id();
		result.probeId = probeId;
		const create = await pass(sdk, "create", null);
		if (!create.ok) {
			return;
		}
		result.savedCursors.create = create.value.saved;
		const payload = metadataPayload(ctx);
		if (payload.length < METADATA_MIN_BYTES || payload.length > METADATA_MAX_BYTES) {
			fail("metadata-size", `metadata payload is ${payload.length} bytes, allowed ${METADATA_MIN_BYTES} to ${METADATA_MAX_BYTES}`);
			return;
		}
		result.metadataPayloadBytes = payload.length;
		const updated = await step("updateMetadata", () => sdk.updateMetadata(probe, payload));
		if (!updated.ok) {
			return;
		}
		const update = await pass(sdk, "update", null);
		if (!update.ok) {
			return;
		}
		result.savedCursors.update = update.value.saved;
		const deleted = await step("deleteObject", () => sdk.deleteObject(probeId));
		if (!deleted.ok) {
			return;
		}
		result.deleteCompleted = true;
		const deletion = await pass(sdk, "deletion", null);
		if (!deletion.ok) {
			return;
		}
		result.savedCursors.deletion = deletion.value.saved;
		const incremental = await pass(sdk, "incremental", deletion.value.saved);
		if (!incremental.ok) {
			return;
		}
		result.savedCursors.incremental = incremental.value.saved;
		result.observations = computeObservations(result.pages, probeId, deletion.value.cursorEvent);
		const receipt = ctx.settings.get().receipt;
		if (receipt !== null && isCrossInstallation(receipt, cls)) {
			const receiptProbe = receipt.objects.find((object) => object.name === "probe");
			if (receiptProbe !== undefined) {
				result.authority = await probeAuthority(ctx, sdk, receiptProbe.objectId);
			}
		}
		record.outcome = "passed";
		ctx.show(EVENTS_TITLE, summarize(result));
		ctx.notify(EVENTS_COMPLETE_NOTICE);
	} catch (error) {
		fail("events-command", errorMessage(error));
	} finally {
		finishRecord(ctx, record, t0);
		try {
			await writeRecord(ctx.vault, ctx.redactor, record);
		} catch {
			ctx.notify("Could not write the record");
		}
	}
}

function metadataPayload(ctx: CommandContext): Uint8Array {
	return utf8Encode(`probe-metadata-${ctx.now().toISOString()}`);
}

function pendingOutcome(): StepOutcome {
	return { attempted: false, ok: false, message: null, durationMs: null };
}

async function attempt<T>(ctx: CommandContext, outcome: StepOutcome, run: () => Promise<T>): Promise<T | null> {
	const started = ctx.clock();
	outcome.attempted = true;
	try {
		const value = await run();
		outcome.ok = true;
		outcome.durationMs = ctx.clock() - started;
		return value;
	} catch (error) {
		outcome.message = errorMessage(error);
		outcome.durationMs = ctx.clock() - started;
		return null;
	}
}

async function probeAuthority(ctx: CommandContext, sdk: SdkHandle, receiptProbeId: string): Promise<EventsResult["authority"]> {
	const authority = { receiptProbeId, objectFetch: pendingOutcome(), updateObjectMetadata: pendingOutcome(), deleteObject: pendingOutcome() };
	const handle = await attempt(ctx, authority.objectFetch, () => sdk.object(receiptProbeId));
	if (handle !== null) {
		await attempt(ctx, authority.updateObjectMetadata, () => sdk.updateMetadata(handle, metadataPayload(ctx)));
	}
	await attempt(ctx, authority.deleteObject, () => sdk.deleteObject(receiptProbeId));
	return authority;
}

function summarize(result: EventsResult): string {
	const lines = [`Probe object: ${result.probeId ?? "none"}`];
	lines.push(`Pages: ${PASS_NAMES.map((name) => `${name} ${result.pages.filter((page) => page.pass === name).length}`).join(", ")}`);
	const o = result.observations;
	if (o !== null) {
		lines.push("Observations of the coalesced current-state feed:");
		lines.push(`(a) distinct probe events in the create pass: ${o.a.createDistinct}`);
		lines.push(`(b) distinct probe events in the update pass: ${o.b.updateDistinct}; later than the create pass: ${String(o.b.laterThanCreate)}`);
		lines.push(`(c) distinct probe events in the deletion pass: ${o.c.deletionDistinct}; tombstone seen: ${String(o.c.tombstoneSeen)}`);
		lines.push(`(d) an id appeared on more than one page: ${PASS_NAMES.map((name) => `${name} ${String(o.d[name])}`).join(", ")}`);
		lines.push(`(e) distinct incremental events: ${o.e.incrementalDistinct}; all later than the deletion cursor: ${String(o.e.allLaterThanDeletionCursor)}`);
	}
	const authority = result.authority;
	if (authority !== null) {
		lines.push(`Authority over the receipt's probe ${authority.receiptProbeId}: object ${describeOutcome(authority.objectFetch)}; updateObjectMetadata ${describeOutcome(authority.updateObjectMetadata)}; deleteObject ${describeOutcome(authority.deleteObject)}`);
	}
	return lines.join("\n");
}

function describeOutcome(outcome: StepOutcome): string {
	if (!outcome.attempted) {
		return "not attempted";
	}
	if (outcome.ok) {
		return `ok in ${outcome.durationMs ?? 0} ms`;
	}
	return `failed: ${outcome.message ?? "unknown error"}`;
}
