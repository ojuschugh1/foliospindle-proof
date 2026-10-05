import type { CommandName, InitSummary, PlatformInfo, VaultWriter } from "./context.ts";
import type { Redactor } from "./redaction.ts";

export const PROOF_FOLDER = "foliospindle-proof";
export const RECORDS_FOLDER = "foliospindle-proof/records";

const RECORD_EXTENSION = ".json";

export type Outcome = "passed" | "failed" | "refused";

export interface RecordError {
	step: string;
	kind: "error" | "timeout" | "page-limit" | "refusal";
	message: string;
	transportHint: boolean;
}

export interface CommandRecord<T> {
	formatVersion: 1;
	command: CommandName;
	outcome: Outcome;
	startedAt: string;
	finishedAt: string;
	durationMs: number;
	pluginVersion: string;
	sdkVersion: string;
	platform: PlatformInfo;
	init: (InitSummary & { firstInThisLoad: boolean }) | null;
	reconnect: { method: "connected" | "live-session"; outcome: "ok" | "null" | "error"; durationMs: number } | null;
	error: RecordError | null;
	result: T;
}

export function recordFileName(command: CommandName, startedAt: Date): string {
	return `${recordStem(command, startedAt)}${RECORD_EXTENSION}`;
}

export function formatRecord(record: CommandRecord<unknown>): string {
	return JSON.stringify(record, null, 2);
}

export async function writeRecord(vault: VaultWriter, redactor: Redactor, record: CommandRecord<unknown>): Promise<string> {
	await ensureFolder(vault, PROOF_FOLDER);
	await ensureFolder(vault, RECORDS_FOLDER);
	const text = redactor.redact(formatRecord(record));
	const stem = recordStem(record.command, new Date(record.startedAt));
	let path = `${RECORDS_FOLDER}/${stem}${RECORD_EXTENSION}`;
	for (let suffix = 2; await vault.exists(path); suffix += 1) {
		path = `${RECORDS_FOLDER}/${stem}-${suffix}${RECORD_EXTENSION}`;
	}
	await vault.createText(path, text);
	return path;
}

function recordStem(command: CommandName, startedAt: Date): string {
	return `${command}-${startedAt.toISOString().replaceAll(/[:.]/g, "-")}`;
}

async function ensureFolder(vault: VaultWriter, path: string): Promise<void> {
	if (!(await vault.exists(path))) {
		await vault.createFolder(path);
	}
}
