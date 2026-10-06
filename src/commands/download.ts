import { failureText } from "../capability.ts";
import type { CommandContext, PlatformClass, VaultWriter } from "../context.ts";
import { utf8Decode } from "../encoding.ts";
import { FIXTURE_NAMES, type FixtureName, MARKDOWN_FIXTURES, committedHashes } from "../fixtures.ts";
import { sha256Hex } from "../hashing.ts";
import { type Receipt, isCrossInstallation } from "../receipt.ts";
import { PROOF_FOLDER, writeRecord } from "../records.ts";
import type { SdkHandle } from "../sdk-adapter.ts";
import { errorMessage, finishRecord, requireCapability, requireInitialized, requireSdk, setFailure, startRecord } from "./session-steps.ts";

export interface DownloadObjectResult {
	name: FixtureName;
	objectId: string;
	downloadMs: number | null;
	downloadedBytes: number | null;
	downloadedSha256: string | null;
	receiptSha256: string;
	committedSha256: string;
	match: boolean;
	failedCall: string | null;
	writtenPath: string | null;
	writtenAs: "text" | "binary" | null;
	replacedExisting: boolean;
}

export interface DownloadResult {
	receiptPlatformLabel: PlatformClass;
	crossInstallation: boolean;
	proofFolder: string;
	objects: DownloadObjectResult[];
}

export const NO_RECEIPT_NOTICE = "Run Upload fixtures and probe or Enter demo receipt first";
export const COMPLETE_NOTICE = "Download complete. All three fixtures match.";
export const INCOMPLETE_NOTICE = "Download finished with failures or mismatches.";

export async function runDownload(ctx: CommandContext): Promise<void> {
	const t0 = ctx.clock();
	const receipt = ctx.settings.get().receipt;
	const cls = ctx.platform.platformClass;
	const result: DownloadResult = {
		receiptPlatformLabel: receipt?.platformLabel ?? cls,
		crossInstallation: receipt === null ? false : isCrossInstallation(receipt, cls),
		proofFolder: PROOF_FOLDER,
		objects: [],
	};
	const record = startRecord(ctx, "download", result);
	try {
		if (receipt === null) {
			ctx.notify(NO_RECEIPT_NOTICE);
			setFailure(ctx, record, "receipt", "refusal", NO_RECEIPT_NOTICE);
			return;
		}
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
		result.objects = FIXTURE_NAMES.map((name) => objectResult(receipt, name));
		let folderReady = false;
		for (const entry of result.objects) {
			if (entry.failedCall === "receipt") {
				ctx.notify(`Receipt has no entry for ${entry.name}`);
				continue;
			}
			const bytes = await fetchObject(ctx, sdk, entry);
			if (bytes === null) {
				continue;
			}
			const downloaded = await sha256Hex(bytes);
			entry.downloadedSha256 = downloaded;
			entry.match = downloaded === entry.receiptSha256 && downloaded === entry.committedSha256;
			const markdown = MARKDOWN_FIXTURES.includes(entry.name);
			const text = markdown ? utf8Decode(bytes) : null;
			if (!entry.match) {
				const note = markdown && text === null ? " (Markdown bytes are not valid UTF-8)" : "";
				ctx.notify(`Hash mismatch for object ${entry.objectId}: downloaded ${downloaded}, receipt ${entry.receiptSha256}, committed ${entry.committedSha256}${note}`);
			}
			const path = `${PROOF_FOLDER}/${entry.name}`;
			try {
				if (!folderReady) {
					await ensureProofFolder(ctx.vault);
					folderReady = true;
				}
				entry.replacedExisting = await writeBytes(ctx.vault, path, bytes, text);
				entry.writtenPath = path;
				entry.writtenAs = text === null ? "binary" : "text";
			} catch (error) {
				entry.failedCall = "vault";
				ctx.notify(`Could not write ${path}: ${errorMessage(error)}`);
			}
		}
		const failed = result.objects.filter((entry) => entry.failedCall !== null || !entry.match).length;
		if (failed === 0) {
			record.outcome = "passed";
			ctx.notify(COMPLETE_NOTICE);
		} else {
			setFailure(ctx, record, "download", "error", `${failed} of ${result.objects.length} objects failed or mismatched`);
			ctx.notify(INCOMPLETE_NOTICE);
		}
	} catch (error) {
		const message = errorMessage(error);
		setFailure(ctx, record, "download-command", "error", message);
		ctx.notify(`Download failed: ${message}`);
	} finally {
		finishRecord(ctx, record, t0);
		try {
			await writeRecord(ctx.vault, ctx.redactor, record);
		} catch {
			ctx.notify("Could not write the record");
		}
	}
}

function objectResult(receipt: Receipt, name: FixtureName): DownloadObjectResult {
	const entry = receipt.objects.find((object) => object.name === name);
	return {
		name,
		objectId: entry?.objectId ?? "",
		downloadMs: null,
		downloadedBytes: null,
		downloadedSha256: null,
		receiptSha256: entry?.sha256 ?? "",
		committedSha256: committedHashes()[name],
		match: false,
		failedCall: entry === undefined ? "receipt" : null,
		writtenPath: null,
		writtenAs: null,
		replacedExisting: false,
	};
}

async function fetchObject(ctx: CommandContext, sdk: SdkHandle, entry: DownloadObjectResult): Promise<Uint8Array | null> {
	const started = ctx.clock();
	let call = "object";
	try {
		const handle = await sdk.object(entry.objectId);
		call = "download";
		const bytes = await sdk.downloadAll(handle);
		entry.downloadMs = ctx.clock() - started;
		entry.downloadedBytes = bytes.length;
		return bytes;
	} catch (error) {
		entry.failedCall = call;
		ctx.notify(failureText(`Download failed at ${call} for object ${entry.objectId}`, ctx.platform.platformClass, errorMessage(error)));
		return null;
	}
}

async function ensureProofFolder(vault: VaultWriter): Promise<void> {
	if (!(await vault.exists(PROOF_FOLDER))) {
		await vault.createFolder(PROOF_FOLDER);
	}
}

async function writeBytes(vault: VaultWriter, path: string, bytes: Uint8Array, text: string | null): Promise<boolean> {
	const exists = await vault.exists(path);
	if (text === null) {
		await (exists ? vault.replaceBinary(path, bytes) : vault.createBinary(path, bytes));
	} else {
		await (exists ? vault.replaceText(path, text) : vault.createText(path, text));
	}
	return exists;
}
