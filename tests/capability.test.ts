import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
	MINIMUM_PLATFORMS,
	PRIVATE_RELAY_HINT,
	decideCapability,
	failureText,
	gate,
	isTransportError,
	missingCapabilities,
	privateRelayHint,
} from "../src/capability.ts";
import { type CapabilityResult, runCapability } from "../src/commands/capability.ts";
import type { PlatformClass, PlatformInfo } from "../src/context.ts";
import type { CommandRecord } from "../src/records.ts";
import { type Harness, fakeContext } from "./fakes.ts";

const TYPEOF_RESULTS = ["undefined", "object", "boolean", "number", "bigint", "string", "symbol", "function"];
const PLATFORM_CLASSES: PlatformClass[] = ["macos", "ios", "android", "desktop-other", "unknown"];
const TRANSPORT_ERRORS = [
	"WebTransport failed",
	"QUIC handshake timed out",
	"Load failed",
	"Failed to fetch",
	"network error",
	"connection refused",
	"TRANSPORT closed",
];
const OTHER_ERRORS = ["invalid receipt", "not found", ""];

const info = (platformClass: PlatformClass, isSecureContext: boolean, webTransportType: string): PlatformInfo => ({
	platformClass,
	osVersion: "26.4",
	obsidianApiVersion: "1.11.4",
	uaString: "Mozilla/5.0 (test)",
	isSecureContext,
	webTransportType,
});

function refusal(platformInfo: PlatformInfo): string {
	const result = gate(platformInfo);
	assert.equal(result.ok, false);
	return result.message;
}

function assertNames(message: string, named: string[], unnamed: string[]): void {
	for (const entry of named) {
		assert.ok(message.includes(entry), `${message} lacks ${entry}`);
	}
	for (const entry of unnamed) {
		assert.equal(message.includes(entry), false, `${message} names ${entry}`);
	}
	assert.ok(message.includes(MINIMUM_PLATFORMS), message);
}

test("foliospindle-proof Property 1: Capability decision", () => {
	let visited = 0;
	for (const isSecureContext of [true, false]) {
		for (const t of TYPEOF_RESULTS) {
			const expected = isSecureContext && t === "function";
			const label = `(${isSecureContext}, ${t})`;
			assert.equal(decideCapability(isSecureContext, t), expected ? "supported" : "unsupported", label);
			assert.equal(missingCapabilities(isSecureContext, t).length === 0, expected, label);
			visited += 1;
		}
	}
	assert.equal(visited, 16);
});

test("gate passes only with both capabilities present, on every platform class", () => {
	for (const cls of PLATFORM_CLASSES) {
		assert.deepEqual(gate(info(cls, true, "function")), { ok: true });
	}
});

test("gate refusal names the missing capability and the minimum platforms", () => {
	assertNames(refusal(info("ios", false, "function")), ["isSecureContext"], ["typeof WebTransport"]);
	assertNames(refusal(info("android", true, "undefined")), ["typeof WebTransport", "undefined"], ["isSecureContext"]);
	const missing = missingCapabilities(false, "undefined");
	assert.equal(missing.length, 2);
	assertNames(refusal(info("desktop-other", false, "undefined")), [...missing, "isSecureContext", "typeof WebTransport"], []);
});

test("isTransportError recognises transport-level messages in any letter case", () => {
	for (const message of TRANSPORT_ERRORS) {
		assert.equal(isTransportError(message), true, message);
	}
	for (const message of OTHER_ERRORS) {
		assert.equal(isTransportError(message), false, JSON.stringify(message));
	}
});

test("failureText appends the Private Relay hint only on iOS and macOS with a transport error", () => {
	for (const cls of ["ios", "macos"] as const) {
		const text = failureText("Upload failed", cls, "network error");
		assert.ok(text.startsWith("Upload failed: network error"), text);
		assert.ok(text.endsWith(PRIVATE_RELAY_HINT), text);
	}
	for (const cls of ["android", "desktop-other", "unknown"] as const) {
		const text = failureText("Upload failed", cls, "network error");
		assert.equal(text, "Upload failed: network error");
		assert.equal(text.includes(PRIVATE_RELAY_HINT), false, text);
	}
	for (const cls of PLATFORM_CLASSES) {
		assert.equal(failureText("Upload failed", cls, "invalid receipt"), "Upload failed: invalid receipt");
	}
});

test("privateRelayHint per class", () => {
	assert.equal(privateRelayHint("ios"), PRIVATE_RELAY_HINT);
	assert.equal(privateRelayHint("macos"), PRIVATE_RELAY_HINT);
	assert.equal(privateRelayHint("android"), null);
	assert.equal(privateRelayHint("desktop-other"), null);
	assert.equal(privateRelayHint("unknown"), null);
});

const CAPABILITY_TITLE = "Runtime capability";
const SUPPORTED_NOTICE = "Runtime capability: supported";
const SMALL_MAIN_JS = Uint8Array.of(1, 2, 3);
const LARGE_MAIN_JS = Uint8Array.from({ length: 1000 }, (_, i) => i & 0xff);

const nodeSha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function onlyRecord(h: Harness): CommandRecord<CapabilityResult> {
	const records = h.records();
	assert.equal(records.length, 1);
	return records[0] as CommandRecord<CapabilityResult>;
}

function onlyShow(h: Harness): string {
	assert.equal(h.shows.length, 1);
	const [entry] = h.shows;
	assert.ok(entry !== undefined);
	assert.equal(entry.title, CAPABILITY_TITLE);
	return entry.text;
}

async function capability(h: Harness): Promise<CommandRecord<CapabilityResult>> {
	await runCapability(h.ctx);
	return onlyRecord(h);
}

test("runCapability reports the decision, the hint per class and the init summary in one passed record", async () => {
	for (const cls of PLATFORM_CLASSES) {
		const h = fakeContext({ platform: { platformClass: cls } });
		const record = await capability(h);
		const hint = cls === "ios" || cls === "macos" ? PRIVATE_RELAY_HINT : null;
		assert.equal(record.command, "capability", cls);
		assert.equal(record.outcome, "passed", cls);
		assert.equal(record.error, null, cls);
		assert.equal(record.result.decision, "supported", cls);
		assert.deepEqual(record.result.missing, [], cls);
		assert.equal(record.result.minimumPlatforms, MINIMUM_PLATFORMS, cls);
		assert.equal(record.result.privateRelayHint, hint, cls);
		assert.equal(record.result.onloadMs, 12, cls);
		assert.equal(record.result.pluginVersion, "0.1.0", cls);
		assert.equal(record.result.sdkVersion, __SDK_VERSION__, cls);
		assert.equal(record.result.obsidianApiVersion, "1.11.4", cls);
		assert.equal(record.platform.platformClass, cls);
		assert.ok(record.init !== null, cls);
		assert.equal(record.init.firstInThisLoad, true, cls);
		assert.equal(record.init.durationMs, h.session.summary.durationMs, cls);
		assert.equal(h.session.initCalls, 1, cls);
		const text = onlyShow(h);
		assert.ok(text.includes("Decision: supported"), text);
		assert.ok(text.includes(`Platform class: ${cls}`), text);
		assert.equal(text.includes(PRIVATE_RELAY_HINT), hint !== null, text);
		assert.deepEqual(h.notices, [SUPPORTED_NOTICE], cls);
	}
});

test("runCapability records the installed main.js bytes and SHA-256 from readInstalledMainJs", async () => {
	const h = fakeContext();
	const record = await capability(h);
	const smallHash = nodeSha256(SMALL_MAIN_JS);
	assert.deepEqual(record.result.mainJs, { bytes: 3, sha256: smallHash });
	const text = onlyShow(h);
	assert.ok(text.includes("main.js bytes: 3"), text);
	assert.ok(text.includes(`main.js sha256: ${smallHash}`), text);

	const large = fakeContext({ readInstalledMainJs: async () => LARGE_MAIN_JS });
	const largeRecord = await capability(large);
	assert.deepEqual(largeRecord.result.mainJs, { bytes: 1000, sha256: nodeSha256(LARGE_MAIN_JS) });
	assert.equal(largeRecord.outcome, "passed");
	assert.ok(onlyShow(large).includes("main.js bytes: 1000"));
});

test("runCapability records mainJs.error when main.js cannot be read and still passes", async () => {
	const missing = fakeContext({ readInstalledMainJs: async () => null });
	const missingRecord = await capability(missing);
	assert.deepEqual(missingRecord.result.mainJs, { error: "main.js could not be read" });
	assert.equal(missingRecord.outcome, "passed");
	assert.equal(missingRecord.error, null);
	assert.ok(onlyShow(missing).includes("main.js: main.js could not be read"));
	assert.deepEqual(missing.notices, [SUPPORTED_NOTICE]);

	const failing = fakeContext({
		readInstalledMainJs: async () => {
			throw new Error("adapter down");
		},
	});
	const failingRecord = await capability(failing);
	assert.deepEqual(failingRecord.result.mainJs, { error: "adapter down" });
	assert.equal(failingRecord.outcome, "passed");
	assert.equal(failingRecord.error, null);
	assert.ok(failingRecord.init !== null);
	assert.ok(onlyShow(failing).includes("main.js: adapter down"));
	assert.deepEqual(failing.notices, [SUPPORTED_NOTICE]);
});

test("runCapability initializes the SDK even when the decision is unsupported", async () => {
	const h = fakeContext({ platform: { isSecureContext: false, webTransportType: "undefined" } });
	const record = await capability(h);
	assert.equal(record.result.decision, "unsupported");
	assert.equal(record.result.missing.length, 2);
	assert.deepEqual(record.result.missing, missingCapabilities(false, "undefined"));
	assert.equal(h.session.initCalls, 1);
	assert.ok(record.init !== null);
	assert.equal(record.init.firstInThisLoad, true);
	assert.equal(record.outcome, "passed");
	assert.equal(record.error, null);
	assert.deepEqual(h.notices, ["Runtime capability: unsupported"]);
	const text = onlyShow(h);
	assert.ok(text.includes("Decision: unsupported"), text);
	assert.ok(text.includes("isSecureContext: false"), text);
	assert.ok(text.includes("typeof WebTransport: undefined"), text);
});

test("runCapability records a failed initialization with step wasm-init and keeps the main.js hash", async () => {
	const h = fakeContext();
	h.session.initOutcome = "reject";
	const record = await capability(h);
	assert.equal(record.outcome, "failed");
	assert.equal(record.error?.step, "wasm-init");
	assert.equal(record.error?.kind, "error");
	assert.equal(record.error?.message, "init failed");
	assert.equal(record.init, null);
	assert.equal(h.session.initCalls, 1);
	assert.deepEqual(record.result.mainJs, { bytes: 3, sha256: nodeSha256(SMALL_MAIN_JS) });
	assert.equal(record.result.decision, "supported");
	assert.deepEqual(h.notices, ["The SDK could not be initialized: init failed", "Runtime capability: supported (SDK init failed)"]);
	const text = onlyShow(h);
	assert.ok(text.includes("WASM init: failed at wasm-init"), text);
	assert.ok(text.includes("init failed"), text);
});

test("runCapability writes one record per run and marks only the first initialization as first in this load", async () => {
	const h = fakeContext();
	for (let run = 0; run < 3; run += 1) {
		if (run > 0) {
			h.clock.advance(1000);
		}
		await runCapability(h.ctx);
		assert.equal(h.records().length, run + 1);
	}
	const records = h.records() as CommandRecord<CapabilityResult>[];
	assert.equal(records.length, 3);
	assert.deepEqual(records.map((record) => record.command), ["capability", "capability", "capability"]);
	assert.deepEqual(records.map((record) => record.outcome), ["passed", "passed", "passed"]);
	assert.deepEqual(records.map((record) => record.init?.firstInThisLoad), [true, false, false]);
	assert.equal(new Set(records.map((record) => record.startedAt)).size, 3);
	assert.equal(h.session.initCalls, 3);
	assert.equal(h.shows.length, 3);
	assert.deepEqual(h.notices, [SUPPORTED_NOTICE, SUPPORTED_NOTICE, SUPPORTED_NOTICE]);
});
