import { failureText, gate, isTransportError, privateRelayHint } from "../capability.ts";
import type { CommandContext, CommandName } from "../context.ts";
import { readSeed } from "../credential.ts";
import { DeadlineError } from "../deadline.ts";
import type { CommandRecord, RecordError } from "../records.ts";
import type { SdkHandle } from "../sdk-adapter.ts";

const NO_CREDENTIAL = "No valid credential is stored. Run Connect to indexer.";

export function startRecord<T>(ctx: CommandContext, command: CommandName, result: T): CommandRecord<T> {
	return {
		formatVersion: 1,
		command,
		outcome: "failed",
		startedAt: ctx.now().toISOString(),
		finishedAt: "",
		durationMs: 0,
		pluginVersion: ctx.pluginVersion,
		sdkVersion: __SDK_VERSION__,
		platform: ctx.platform,
		init: null,
		reconnect: null,
		error: null,
		result,
	};
}

export function finishRecord(ctx: CommandContext, record: CommandRecord<unknown>, startedClock: number): void {
	record.finishedAt = ctx.now().toISOString();
	record.durationMs = ctx.clock() - startedClock;
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function setFailure(ctx: CommandContext, record: CommandRecord<unknown>, step: string, kind: RecordError["kind"], message: string): void {
	record.error = {
		step,
		kind,
		message,
		transportHint: isTransportError(message) && privateRelayHint(ctx.platform.platformClass) !== null,
	};
	record.outcome = kind === "refusal" ? "refused" : "failed";
}

export async function requireCapability(ctx: CommandContext, record: CommandRecord<unknown>): Promise<boolean> {
	const result = gate(ctx.platform);
	if (result.ok) {
		return true;
	}
	ctx.notify(result.message);
	setFailure(ctx, record, "capability", "refusal", result.message);
	return false;
}

export async function requireInitialized(ctx: CommandContext, record: CommandRecord<unknown>): Promise<boolean> {
	try {
		const summary = await ctx.session.initialize();
		record.init = { ...summary, firstInThisLoad: ctx.session.initializedInThisCall() };
		return true;
	} catch (error) {
		const kind = error instanceof DeadlineError ? "timeout" : "error";
		const message = errorMessage(error);
		ctx.notify(`The SDK could not be initialized: ${message}`);
		setFailure(ctx, record, "wasm-init", kind, message);
		return false;
	}
}

export async function requireSdk(ctx: CommandContext, record: CommandRecord<unknown>): Promise<SdkHandle | null> {
	const live = ctx.session.current();
	if (live !== null) {
		record.reconnect = { method: "live-session", outcome: "ok", durationMs: 0 };
		return live;
	}
	const seed = readSeed(ctx.secrets);
	if (seed === null) {
		ctx.notify(NO_CREDENTIAL);
		setFailure(ctx, record, "credential", "refusal", NO_CREDENTIAL);
		return null;
	}
	ctx.redactor.add(seed);
	const t0 = ctx.clock();
	try {
		const sdk = await ctx.session.connectStored(ctx.settings.get().indexerUrl, seed);
		const durationMs = ctx.clock() - t0;
		if (sdk === null) {
			record.reconnect = { method: "connected", outcome: "null", durationMs };
			ctx.notify(NO_CREDENTIAL);
			setFailure(ctx, record, "credential", "refusal", NO_CREDENTIAL);
			return null;
		}
		record.reconnect = { method: "connected", outcome: "ok", durationMs };
		return sdk;
	} catch (error) {
		record.reconnect = { method: "connected", outcome: "error", durationMs: ctx.clock() - t0 };
		const message = errorMessage(error);
		ctx.notify(failureText("Reconnect failed", ctx.platform.platformClass, message));
		setFailure(ctx, record, "connected", "error", message);
		return null;
	}
}
