import { MINIMUM_PLATFORMS, decideCapability, missingCapabilities, privateRelayHint, type Decision } from "../capability.ts";
import type { CommandContext } from "../context.ts";
import { sha256Hex } from "../hashing.ts";
import { writeRecord, type CommandRecord } from "../records.ts";
import { errorMessage, finishRecord, requireInitialized, setFailure, startRecord } from "./session-steps.ts";

export interface CapabilityResult {
	decision: Decision;
	missing: string[];
	minimumPlatforms: string;
	privateRelayHint: string | null;
	onloadMs: number;
	mainJs: { bytes: number; sha256: string } | { error: string };
	pluginVersion: string;
	sdkVersion: string;
	obsidianApiVersion: string;
}

export async function runCapability(ctx: CommandContext): Promise<void> {
	const t0 = ctx.clock();
	const p = ctx.platform;
	const result: CapabilityResult = {
		decision: decideCapability(p.isSecureContext, p.webTransportType),
		missing: missingCapabilities(p.isSecureContext, p.webTransportType),
		minimumPlatforms: MINIMUM_PLATFORMS,
		privateRelayHint: privateRelayHint(p.platformClass),
		onloadMs: ctx.onloadMs,
		mainJs: { error: "not read" },
		pluginVersion: ctx.pluginVersion,
		sdkVersion: __SDK_VERSION__,
		obsidianApiVersion: p.obsidianApiVersion,
	};
	const record = startRecord(ctx, "capability", result);
	try {
		result.mainJs = await readMainJs(ctx);
		const initialized = await requireInitialized(ctx, record);
		if (initialized) {
			record.outcome = "passed";
		}
		ctx.show("Runtime capability", formatCapabilityText(record));
		ctx.notify(noticeText(result.decision, initialized));
	} catch (error) {
		const message = errorMessage(error);
		setFailure(ctx, record, "capability-command", "error", message);
		ctx.notify(`Capability check failed: ${message}`);
	} finally {
		finishRecord(ctx, record, t0);
		try {
			await writeRecord(ctx.vault, ctx.redactor, record);
		} catch {
			ctx.notify("Could not write the record");
		}
	}
}

async function readMainJs(ctx: CommandContext): Promise<CapabilityResult["mainJs"]> {
	try {
		const bytes = await ctx.readInstalledMainJs();
		if (bytes === null) {
			return { error: "main.js could not be read" };
		}
		return { bytes: bytes.length, sha256: await sha256Hex(bytes) };
	} catch (error) {
		return { error: errorMessage(error) };
	}
}

function noticeText(decision: Decision, initialized: boolean): string {
	const text = `Runtime capability: ${decision}`;
	return initialized ? text : `${text} (SDK init failed)`;
}

function formatCapabilityText(record: CommandRecord<CapabilityResult>): string {
	const { platform, result, init } = record;
	const lines = [
		`Decision: ${result.decision}`,
		`Missing: ${result.missing.length === 0 ? "none" : result.missing.join("; ")}`,
		`Minimum supported platforms: ${result.minimumPlatforms}`,
		`Private Relay hint: ${result.privateRelayHint ?? "not applicable"}`,
		`Platform class: ${platform.platformClass}`,
		`OS version: ${platform.osVersion}`,
		`isSecureContext: ${String(platform.isSecureContext)}`,
		`typeof WebTransport: ${platform.webTransportType}`,
		`onload: ${result.onloadMs} ms`,
	];
	if ("error" in result.mainJs) {
		lines.push(`main.js: ${result.mainJs.error}`);
	} else {
		lines.push(`main.js bytes: ${result.mainJs.bytes}`, `main.js sha256: ${result.mainJs.sha256}`);
	}
	lines.push(`Plugin version: ${result.pluginVersion}`, `SDK version: ${result.sdkVersion}`, `Obsidian API version: ${result.obsidianApiVersion}`);
	if (init !== null) {
		lines.push(
			`WASM init: ${init.durationMs} ms (first in this load: ${init.firstInThisLoad ? "yes" : "no"})`,
			`WASM bytes: ${init.wasmBytes}`,
			`WASM sha256: ${init.wasmSha256}`,
			`WASM sha256 matches expected: ${init.wasmSha256 === init.expectedWasmSha256 ? "yes" : "no"}`,
		);
	} else if (record.error !== null) {
		lines.push(`WASM init: failed at ${record.error.step} (${record.error.message})`);
	}
	return lines.join("\n");
}
