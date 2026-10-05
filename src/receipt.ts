import type { PlatformClass } from "./context.ts";

export const RECEIPT_FORMAT_VERSION = 1;
export const RECEIPT_OBJECT_NAMES = ["fixture-a.md", "fixture-b.md", "attachment.bin", "probe"] as const;
export type ReceiptObjectName = (typeof RECEIPT_OBJECT_NAMES)[number];

export interface ReceiptObject {
	name: ReceiptObjectName;
	bytes: number;
	sha256: string;
	objectId: string;
	uploadMs: number;
}

export interface Receipt {
	formatVersion: 1;
	sdkVersion: string;
	platformLabel: PlatformClass;
	uploadedAt: string;
	objects: ReceiptObject[];
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; path: string; reason: string };

interface ParseFailure {
	ok: false;
	path: string;
	reason: string;
}

const PLATFORM_CLASSES: readonly PlatformClass[] = ["macos", "ios", "android", "desktop-other", "unknown"];
const RECEIPT_KEYS: readonly string[] = ["formatVersion", "sdkVersion", "platformLabel", "uploadedAt", "objects"];
const RECEIPT_OBJECT_KEYS: readonly string[] = ["name", "bytes", "sha256", "objectId", "uploadMs"];
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const OBJECT_ID_PATTERN = /^[0-9a-fA-F]+$/;

export function formatReceipt(receipt: Receipt): string {
	return JSON.stringify(receipt, null, 2);
}

export function parseReceipt(text: string): ParseResult<Receipt> {
	let root: unknown;
	try {
		root = JSON.parse(text);
	} catch {
		return fail("", "not valid JSON");
	}
	if (!isRecord(root)) {
		return fail("", "not an object");
	}
	if (root.formatVersion !== RECEIPT_FORMAT_VERSION) {
		return fail("formatVersion", `expected ${RECEIPT_FORMAT_VERSION}`);
	}
	const sdkVersion = root.sdkVersion;
	if (!isNonEmptyString(sdkVersion)) {
		return fail("sdkVersion", "expected a non-empty string");
	}
	const platformLabel = root.platformLabel;
	if (!isPlatformClass(platformLabel)) {
		return fail("platformLabel", `expected one of ${PLATFORM_CLASSES.join(", ")}`);
	}
	const uploadedAt = root.uploadedAt;
	if (!isIsoTimestamp(uploadedAt)) {
		return fail("uploadedAt", "expected an ISO 8601 timestamp");
	}
	const entries = root.objects;
	if (!isArray(entries)) {
		return fail("objects", "expected an array");
	}
	if (entries.length !== RECEIPT_OBJECT_NAMES.length) {
		return fail("objects", `expected ${RECEIPT_OBJECT_NAMES.length} entries`);
	}
	const unknown = unknownKeyPath(root, RECEIPT_KEYS, "");
	if (unknown !== undefined) {
		return fail(unknown, "unknown key");
	}
	const objects = parseObjects(entries);
	if (!objects.ok) {
		return objects;
	}
	return { ok: true, value: { formatVersion: RECEIPT_FORMAT_VERSION, sdkVersion, platformLabel, uploadedAt, objects: objects.value } };
}

export function isCrossInstallation(receipt: Receipt, cls: PlatformClass): boolean {
	return receipt.platformLabel !== cls;
}

function parseObjects(entries: readonly unknown[]): ParseResult<ReceiptObject[]> {
	const objects: ReceiptObject[] = [];
	const seen = new Set<ReceiptObjectName>();
	for (const [index, entry] of entries.entries()) {
		const parsed = parseObject(entry, `objects[${index}]`, seen);
		if (!parsed.ok) {
			return parsed;
		}
		seen.add(parsed.value.name);
		objects.push(parsed.value);
	}
	return { ok: true, value: objects };
}

function parseObject(entry: unknown, path: string, seen: ReadonlySet<ReceiptObjectName>): ParseResult<ReceiptObject> {
	if (!isRecord(entry)) {
		return fail(path, "not an object");
	}
	const name = entry.name;
	if (!isReceiptObjectName(name)) {
		return fail(`${path}.name`, `expected one of ${RECEIPT_OBJECT_NAMES.join(", ")}`);
	}
	if (seen.has(name)) {
		return fail(`${path}.name`, "duplicate name");
	}
	const bytes = entry.bytes;
	if (!isNonNegativeInteger(bytes)) {
		return fail(`${path}.bytes`, "expected a non-negative integer");
	}
	const sha256 = entry.sha256;
	if (typeof sha256 !== "string" || !SHA256_PATTERN.test(sha256)) {
		return fail(`${path}.sha256`, "expected 64 lowercase hex characters");
	}
	const objectId = entry.objectId;
	if (typeof objectId !== "string" || !OBJECT_ID_PATTERN.test(objectId)) {
		return fail(`${path}.objectId`, "expected one or more hex characters");
	}
	const uploadMs = entry.uploadMs;
	if (!isNonNegativeInteger(uploadMs)) {
		return fail(`${path}.uploadMs`, "expected a non-negative integer");
	}
	const unknown = unknownKeyPath(entry, RECEIPT_OBJECT_KEYS, path);
	if (unknown !== undefined) {
		return fail(unknown, "unknown key");
	}
	return { ok: true, value: { name, bytes, sha256, objectId, uploadMs } };
}

function unknownKeyPath(record: Record<string, unknown>, known: readonly string[], path: string): string | undefined {
	const key = Object.keys(record).find((candidate) => !known.includes(candidate));
	if (key === undefined) {
		return undefined;
	}
	return path === "" ? key : `${path}.${key}`;
}

function fail(path: string, reason: string): ParseFailure {
	return { ok: false, path, reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isArray(value: unknown): value is readonly unknown[] {
	return Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPlatformClass(value: unknown): value is PlatformClass {
	return PLATFORM_CLASSES.some((cls) => cls === value);
}

function isReceiptObjectName(value: unknown): value is ReceiptObjectName {
	return RECEIPT_OBJECT_NAMES.some((name) => name === value);
}

function isIsoTimestamp(value: unknown): value is string {
	if (typeof value !== "string") {
		return false;
	}
	const date = new Date(value);
	return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}
