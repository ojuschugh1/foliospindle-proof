import { failureText } from "../capability.ts";
import type { CommandContext } from "../context.ts";
import { SECRET_ID, readSeed, storeSeed } from "../credential.ts";
import { DeadlineError, type DeadlineTimers, withDeadline } from "../deadline.ts";
import { approvalPresentation } from "../platform.ts";
import { type RecordError, writeRecord } from "../records.ts";
import { APP_METADATA, type SdkHandle, validatePhrase } from "../sdk-adapter.ts";
import { errorMessage, finishRecord, requireCapability, requireInitialized, setFailure, startRecord } from "./session-steps.ts";

export type EntryOutcome = "cancelled" | "invalid" | "mismatch" | "match";
export type ConnectPlan = "registerFresh" | "registerWith" | "refuse";

export interface ConnectResult {
	indexerUrl: string;
	appId: string;
	approvalPresentation: "system-browser" | "selectable-text";
	requestConnectionMs: number;
	approvalWaitMs: number | null;
	reconnecting: boolean | null;
	plan: ConnectPlan | null;
	entryOutcome: EntryOutcome | null;
	publicKeyHex: string;
	seedStored: boolean;
	replacedPreviousSeed: boolean;
	secretId: string;
}

export const APPROVAL_DEADLINE_MS = 600000;
export const APPROVAL_TITLE = "Approve this connection";
export const PHRASE_TITLE = "Recovery phrase for this application";
export const PHRASE_NOTE = "Write this phrase down now. It will not be shown again.";
export const ENTRY_TITLE = "Enter the recovery phrase shown on the first installation";
export const MISMATCH_NOTICE = "The entered phrase does not match the registered application key";
export const TIMEOUT_NOTICE = "Approval timed out after 10 minutes";
export const STORE_FAILED_NOTICE = "Could not store the credential";
export const CONNECTED_NOTICE = "Connected";

export function planConnect(reconnecting: boolean, entryOutcome: EntryOutcome | null): ConnectPlan {
	if (!reconnecting) {
		return "registerFresh";
	}
	return entryOutcome === "match" ? "registerWith" : "refuse";
}

export function buildConnectResult(fields: Omit<ConnectResult, "publicKeyHex">, plan: ConnectPlan, registered: boolean, publicKeyHex: string): ConnectResult {
	return { ...fields, publicKeyHex: plan !== "refuse" && registered ? publicKeyHex : "" };
}

export async function runConnect(ctx: CommandContext, timers?: DeadlineTimers): Promise<void> {
	const t0 = ctx.clock();
	const settings = ctx.settings.get();
	const cls = ctx.platform.platformClass;
	const fields: Omit<ConnectResult, "publicKeyHex"> = {
		indexerUrl: settings.indexerUrl,
		appId: APP_METADATA.appId,
		approvalPresentation: approvalPresentation(cls),
		requestConnectionMs: 0,
		approvalWaitMs: null,
		reconnecting: null,
		plan: null,
		entryOutcome: null,
		seedStored: false,
		replacedPreviousSeed: false,
		secretId: SECRET_ID,
	};
	const record = startRecord<ConnectResult>(ctx, "connect", buildConnectResult(fields, "refuse", false, ""));
	let registered = false;
	let publicKeyHex = "";
	const fail = (step: string, kind: RecordError["kind"], message: string, notice: string): void => {
		ctx.notify(notice);
		setFailure(ctx, record, step, kind, message);
	};
	const failStep = (step: string, error: unknown): void => {
		const message = errorMessage(error);
		fail(step, "error", message, failureText(`Connection attempt failed: ${step}`, cls, message));
	};
	try {
		if (!(await requireCapability(ctx, record))) {
			return;
		}
		if (!(await requireInitialized(ctx, record))) {
			return;
		}
		const builder = ctx.session.createBuilder(settings.indexerUrl);
		const tRequest = ctx.clock();
		try {
			await builder.requestConnection();
		} catch (error) {
			fields.requestConnectionMs = ctx.clock() - tRequest;
			failStep("requestConnection", error);
			return;
		}
		fields.requestConnectionMs = ctx.clock() - tRequest;
		const url = builder.responseUrl();
		if (fields.approvalPresentation === "system-browser") {
			ctx.openExternal(url);
		} else {
			ctx.show(APPROVAL_TITLE, url);
		}
		const tWait = ctx.clock();
		try {
			await withDeadline(builder.waitForApproval(), APPROVAL_DEADLINE_MS, "waitForApproval", timers);
		} catch (error) {
			fields.approvalWaitMs = ctx.clock() - tWait;
			if (error instanceof DeadlineError) {
				fail("waitForApproval", "timeout", errorMessage(error), TIMEOUT_NOTICE);
			} else {
				failStep("waitForApproval", error);
			}
			return;
		}
		fields.approvalWaitMs = ctx.clock() - tWait;
		const reconnecting = builder.reconnecting();
		fields.reconnecting = reconnecting;
		let entryOutcome: EntryOutcome | null = null;
		let phrase = "";
		if (reconnecting) {
			const answer = await ctx.prompt(ENTRY_TITLE);
			phrase = answer === null ? "" : answer.trim();
			if (phrase === "") {
				entryOutcome = "cancelled";
			} else if (!validatePhrase(phrase)) {
				entryOutcome = "invalid";
			} else {
				let matches: boolean;
				try {
					matches = await builder.matchesExistingAppKey(phrase);
				} catch (error) {
					failStep("matchesExistingAppKey", error);
					return;
				}
				entryOutcome = matches ? "match" : "mismatch";
			}
			fields.entryOutcome = entryOutcome;
		}
		const plan = planConnect(reconnecting, entryOutcome);
		fields.plan = plan;
		if (plan === "refuse") {
			fail(entryOutcome === "mismatch" ? "matchesExistingAppKey" : "phrase-entry", "refusal", MISMATCH_NOTICE, MISMATCH_NOTICE);
			return;
		}
		let sdk: SdkHandle;
		let freshPhrase: string | null = null;
		try {
			if (plan === "registerFresh") {
				const fresh = await builder.registerFresh();
				sdk = fresh.sdk;
				freshPhrase = fresh.phrase;
			} else {
				sdk = await builder.registerWith(phrase);
			}
		} catch (error) {
			failStep("register", error);
			return;
		}
		registered = true;
		const seed = sdk.exportSeed();
		ctx.redactor.add(seed);
		const hadPrevious = readSeed(ctx.secrets) !== null;
		try {
			storeSeed(ctx.secrets, seed);
		} catch (error) {
			ctx.session.discard();
			fail("setSecret", "error", errorMessage(error), STORE_FAILED_NOTICE);
			return;
		}
		fields.seedStored = true;
		fields.replacedPreviousSeed = hadPrevious;
		publicKeyHex = sdk.publicKeyHex();
		record.outcome = "passed";
		if (freshPhrase !== null) {
			ctx.show(PHRASE_TITLE, `${freshPhrase}\n\n${PHRASE_NOTE}`);
		}
		ctx.notify(CONNECTED_NOTICE);
	} catch (error) {
		failStep("connect-command", error);
	} finally {
		record.result = buildConnectResult(fields, fields.plan ?? "refuse", registered, publicKeyHex);
		finishRecord(ctx, record, t0);
		try {
			await writeRecord(ctx.vault, ctx.redactor, record);
		} catch {
			ctx.notify("Could not write the record");
		}
	}
}
