import { failureText } from "../capability.ts";
import type { CommandContext, PlatformClass } from "../context.ts";
import { toHex, utf8Encode } from "../encoding.ts";
import { ATTACHMENT_FIXTURE, FIXTURE_NAMES, type FixtureName, MARKDOWN_FIXTURES, committedHashes, fixtureBytes } from "../fixtures.ts";
import { sha256Hex } from "../hashing.ts";
import { RECEIPT_FORMAT_VERSION, RECEIPT_OBJECT_NAMES, type Receipt, type ReceiptObject, type ReceiptObjectName, formatReceipt } from "../receipt.ts";
import { writeRecord } from "../records.ts";
import type { ObjectHandle, SdkHandle } from "../sdk-adapter.ts";
import { errorMessage, finishRecord, requireCapability, requireInitialized, requireSdk, setFailure, startRecord } from "./session-steps.ts";

export interface UploadObjectResult {
	name: ReceiptObjectName;
	bytes: number;
	sha256: string;
	objectId: string | null;
	uploadMs: number | null;
	failedCall: string | null;
}

export interface UploadResult {
	receipt: Receipt | null;
	objects: UploadObjectResult[];
	packed: { remainingBeforeFirstAdd: number | null; finalizeMs: number | null; returnedCount: number | null };
	memory: { jsHeapBefore: number | "not measured"; jsHeapAfter: number | "not measured"; jsHeapReason: string | null; wasmMemoryBytesAfter: number | null };
}

export const RECEIPT_TITLE = "Demo receipt";
export const UPLOAD_COMPLETE_NOTICE = "Upload complete. Receipt saved.";
export const FINALIZE_MISMATCH_NOTICE = "finalize returned unexpected objects";

const PROBE_MAX_BYTES = 4096;

type StepKey = ReceiptObjectName | "packed";
type StepResult<T> = { ok: true; value: T } | { ok: false };

interface PackedAdd {
	name: FixtureName;
	started: number;
}

interface PackedObject extends PackedAdd {
	obj: ObjectHandle;
}

export async function runUpload(ctx: CommandContext): Promise<void> {
	const t0 = ctx.clock();
	const cls = ctx.platform.platformClass;
	const entries = objectEntries();
	const result: UploadResult = {
		receipt: null,
		objects: RECEIPT_OBJECT_NAMES.map((name) => entries[name]),
		packed: { remainingBeforeFirstAdd: null, finalizeMs: null, returnedCount: null },
		memory: { jsHeapBefore: "not measured", jsHeapAfter: "not measured", jsHeapReason: null, wasmMemoryBytesAfter: null },
	};
	const record = startRecord(ctx, "upload", result);
	const fail = (step: string, message: string): void => {
		ctx.notify(`Upload failed: ${message}`);
		setFailure(ctx, record, step, "error", message);
	};
	const step = async <T>(call: string, key: StepKey, run: () => Promise<T>): Promise<StepResult<T>> => {
		try {
			return { ok: true, value: await run() };
		} catch (error) {
			const message = errorMessage(error);
			for (const name of affectedNames(key)) {
				entries[name].failedCall = call;
			}
			ctx.notify(failureText(`Upload failed at ${call} for ${stepLabel(key)}`, cls, message));
			setFailure(ctx, record, `${call}:${key}`, "error", message);
			return { ok: false };
		}
	};
	const pinObject = async (sdk: SdkHandle, name: ReceiptObjectName, obj: ObjectHandle, started: number): Promise<boolean> => {
		const pinned = await step("pin", name, () => sdk.pin(obj));
		if (!pinned.ok) {
			return false;
		}
		entries[name].objectId = obj.id();
		entries[name].uploadMs = ctx.clock() - started;
		return true;
	};
	const uploadAndPin = async (sdk: SdkHandle, name: ReceiptObjectName, bytes: Uint8Array): Promise<boolean> => {
		const started = ctx.clock();
		const uploaded = await step("upload", name, () => sdk.upload(bytes));
		return uploaded.ok && (await pinObject(sdk, name, uploaded.value, started));
	};
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
		readHeap(ctx, result.memory, "jsHeapBefore");
		for (const name of FIXTURE_NAMES) {
			const actual = await sha256Hex(fixtureBytes(name));
			if (actual !== entries[name].sha256) {
				fail(`fixture-hash:${name}`, `embedded ${name} hashes to ${actual}, SHA256SUMS lists ${entries[name].sha256}`);
				return;
			}
		}
		const probeBytes = utf8Encode(`probe-${ctx.now().toISOString()}-${toHex(crypto.getRandomValues(new Uint8Array(8)))}`);
		if (probeBytes.length > PROBE_MAX_BYTES) {
			fail("probe-size", `probe is ${probeBytes.length} bytes, limit ${PROBE_MAX_BYTES}`);
			return;
		}
		entries.probe.bytes = probeBytes.length;
		entries.probe.sha256 = await sha256Hex(probeBytes);
		const packed = sdk.uploadPacked();
		result.packed.remainingBeforeFirstAdd = packed.remaining();
		const adds: PackedAdd[] = [];
		for (const name of MARKDOWN_FIXTURES) {
			adds.push({ name, started: ctx.clock() });
			const added = await step("add", name, () => packed.add(fixtureBytes(name)));
			if (!added.ok) {
				return;
			}
		}
		const tFinalize = ctx.clock();
		const finalized = await step("finalize", "packed", () => packed.finalize());
		result.packed.finalizeMs = ctx.clock() - tFinalize;
		if (!finalized.ok) {
			return;
		}
		result.packed.returnedCount = finalized.value.length;
		const matched = matchBySize(finalized.value, adds);
		if (matched === null) {
			const sizes = finalized.value.map((obj) => obj.size()).join(", ");
			ctx.notify(FINALIZE_MISMATCH_NOTICE);
			setFailure(ctx, record, "finalize:match", "error", `${FINALIZE_MISMATCH_NOTICE}: ${finalized.value.length} returned with sizes [${sizes}]`);
			return;
		}
		for (const { name, started, obj } of matched) {
			if (!(await pinObject(sdk, name, obj, started))) {
				return;
			}
		}
		if (!(await uploadAndPin(sdk, ATTACHMENT_FIXTURE, fixtureBytes(ATTACHMENT_FIXTURE)))) {
			return;
		}
		if (!(await uploadAndPin(sdk, "probe", probeBytes))) {
			return;
		}
		readHeap(ctx, result.memory, "jsHeapAfter");
		result.memory.wasmMemoryBytesAfter = ctx.session.wasmMemoryBytes();
		const receipt = buildReceipt(cls, ctx.now().toISOString(), result.objects);
		result.receipt = receipt;
		await ctx.settings.save({ ...ctx.settings.get(), receipt });
		record.outcome = "passed";
		ctx.show(RECEIPT_TITLE, formatReceipt(receipt));
		ctx.notify(UPLOAD_COMPLETE_NOTICE);
	} catch (error) {
		fail("upload-command", errorMessage(error));
	} finally {
		finishRecord(ctx, record, t0);
		try {
			await writeRecord(ctx.vault, ctx.redactor, record);
		} catch {
			ctx.notify("Could not write the record");
		}
	}
}

function objectEntries(): Record<ReceiptObjectName, UploadObjectResult> {
	return {
		"fixture-a.md": fixtureEntry("fixture-a.md"),
		"fixture-b.md": fixtureEntry("fixture-b.md"),
		"attachment.bin": fixtureEntry("attachment.bin"),
		probe: { name: "probe", bytes: 0, sha256: "", objectId: null, uploadMs: null, failedCall: null },
	};
}

function fixtureEntry(name: FixtureName): UploadObjectResult {
	return { name, bytes: fixtureBytes(name).length, sha256: committedHashes()[name], objectId: null, uploadMs: null, failedCall: null };
}

function affectedNames(key: StepKey): readonly ReceiptObjectName[] {
	return key === "packed" ? MARKDOWN_FIXTURES : [key];
}

function stepLabel(key: StepKey): string {
	return key === "packed" ? "the packed session" : key;
}

function readHeap(ctx: CommandContext, memory: UploadResult["memory"], key: "jsHeapBefore" | "jsHeapAfter"): void {
	const bytes = ctx.jsHeapBytes();
	memory[key] = bytes ?? "not measured";
	if (bytes === null) {
		memory.jsHeapReason = ctx.platform.platformClass === "ios" ? "performance.memory is not exposed by WKWebView" : "performance.memory is not available on this platform";
	}
}

function matchBySize(returned: readonly ObjectHandle[], adds: readonly PackedAdd[]): PackedObject[] | null {
	if (returned.length !== adds.length) {
		return null;
	}
	const matched: PackedObject[] = [];
	for (const add of adds) {
		const size = fixtureBytes(add.name).length;
		const obj = returned.find((candidate) => candidate.size() === size);
		if (obj === undefined) {
			return null;
		}
		matched.push({ ...add, obj });
	}
	return matched;
}

function buildReceipt(cls: PlatformClass, uploadedAt: string, entries: readonly UploadObjectResult[]): Receipt {
	return { formatVersion: RECEIPT_FORMAT_VERSION, sdkVersion: __SDK_VERSION__, platformLabel: cls, uploadedAt, objects: entries.map(receiptObject) };
}

function receiptObject(entry: UploadObjectResult): ReceiptObject {
	if (entry.objectId === null || entry.uploadMs === null) {
		throw new Error(`${entry.name} was not pinned`);
	}
	return { name: entry.name, bytes: entry.bytes, sha256: entry.sha256, objectId: entry.objectId, uploadMs: entry.uploadMs };
}
