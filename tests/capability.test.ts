import assert from "node:assert/strict";
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
import type { PlatformClass, PlatformInfo } from "../src/context.ts";

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
