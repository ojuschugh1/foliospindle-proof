import type { CommandContext } from "../context.ts";
import { clearSeed } from "../credential.ts";
import { writeRecord } from "../records.ts";
import { errorMessage, finishRecord, setFailure, startRecord } from "./session-steps.ts";

export interface RemoveCredentialResult {
	hadSeed: boolean;
	method: "setSecret-empty";
	connectionDiscarded: boolean;
}

export async function runRemoveCredential(ctx: CommandContext): Promise<void> {
	const t0 = ctx.clock();
	const result: RemoveCredentialResult = { hadSeed: false, method: "setSecret-empty", connectionDiscarded: false };
	const record = startRecord(ctx, "remove-credential", result);
	try {
		const hadLive = ctx.session.current() !== null;
		result.hadSeed = clearSeed(ctx.secrets);
		ctx.session.discard();
		result.connectionDiscarded = hadLive;
		record.outcome = "passed";
		ctx.notify("No credential is stored");
	} catch (error) {
		const message = errorMessage(error);
		setFailure(ctx, record, "setSecret", "error", message);
		ctx.notify(`Could not remove the credential: ${message}`);
	} finally {
		finishRecord(ctx, record, t0);
		try {
			await writeRecord(ctx.vault, ctx.redactor, record);
		} catch {
			ctx.notify("Could not write the record");
		}
	}
}
