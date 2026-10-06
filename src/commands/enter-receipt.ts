import type { CommandContext } from "../context.ts";
import { parseReceipt } from "../receipt.ts";
import { writeRecord } from "../records.ts";
import { errorMessage, finishRecord, setFailure, startRecord } from "./session-steps.ts";

export interface EnterReceiptResult {
	accepted: boolean;
	firstInvalidField: string | null;
	reason: string | null;
}

export const ENTER_RECEIPT_TITLE = "Paste the demo receipt";
export const RECEIPT_SAVED_NOTICE = "Receipt saved";

export async function runEnterReceipt(ctx: CommandContext): Promise<void> {
	const t0 = ctx.clock();
	const result: EnterReceiptResult = { accepted: false, firstInvalidField: null, reason: null };
	const record = startRecord(ctx, "enter-receipt", result);
	try {
		const answer = await ctx.prompt(ENTER_RECEIPT_TITLE);
		if (answer === null) {
			result.reason = "cancelled";
			setFailure(ctx, record, "prompt", "refusal", "cancelled");
			return;
		}
		const parsed = parseReceipt(answer);
		if (!parsed.ok) {
			result.firstInvalidField = parsed.path;
			result.reason = parsed.reason;
			ctx.notify(`Invalid receipt: ${parsed.path}: ${parsed.reason}`);
			setFailure(ctx, record, "parseReceipt", "error", `${parsed.path}: ${parsed.reason}`);
			return;
		}
		await ctx.settings.save({ ...ctx.settings.get(), receipt: parsed.value });
		result.accepted = true;
		record.outcome = "passed";
		ctx.notify(RECEIPT_SAVED_NOTICE);
	} catch (error) {
		const message = errorMessage(error);
		setFailure(ctx, record, "enter-receipt-command", "error", message);
		ctx.notify(`Could not save the receipt: ${message}`);
	} finally {
		finishRecord(ctx, record, t0);
		try {
			await writeRecord(ctx.vault, ctx.redactor, record);
		} catch {
			ctx.notify("Could not write the record");
		}
	}
}
