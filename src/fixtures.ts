import attachment from "../fixtures/attachment.bin";
import fixtureA from "../fixtures/fixture-a.md";
import fixtureB from "../fixtures/fixture-b.md";
import { decodeBase64 } from "./encoding.ts";
import type { ParseResult } from "./receipt.ts";

export const FIXTURE_NAMES = ["fixture-a.md", "fixture-b.md", "attachment.bin"] as const;
export type FixtureName = (typeof FIXTURE_NAMES)[number];
export const MARKDOWN_FIXTURES: readonly FixtureName[] = ["fixture-a.md", "fixture-b.md"];
export const ATTACHMENT_FIXTURE: FixtureName = "attachment.bin";

const SHA256SUMS_LINE_PATTERN = /^[0-9a-f]{64} {2}\S+$/;

const FIXTURE_BASE64: Record<FixtureName, string> = {
	"fixture-a.md": fixtureA,
	"fixture-b.md": fixtureB,
	"attachment.bin": attachment,
};

const decoded = new Map<FixtureName, Uint8Array>();
let committed: Record<FixtureName, string> | null = null;

export function fixtureBytes(name: FixtureName): Uint8Array {
	let bytes = decoded.get(name);
	if (bytes === undefined) {
		bytes = decodeBase64(FIXTURE_BASE64[name]);
		decoded.set(name, bytes);
	}
	return bytes;
}

export function committedHashes(): Record<FixtureName, string> {
	if (committed === null) {
		committed = parseCommittedHashes();
	}
	return committed;
}

export function parseSha256Sums(text: string): ParseResult<Record<string, string>> {
	const lines = text.split("\n");
	if (lines[lines.length - 1] === "") {
		lines.pop();
	}
	const entries = new Map<string, string>();
	for (const [index, line] of lines.entries()) {
		if (!SHA256SUMS_LINE_PATTERN.test(line)) {
			return { ok: false, path: `line ${index + 1}`, reason: "expected 64 lowercase hex characters, two spaces and a name" };
		}
		const name = line.slice(66);
		if (entries.has(name)) {
			return { ok: false, path: `line ${index + 1}`, reason: "duplicate name" };
		}
		entries.set(name, line.slice(0, 64));
	}
	return { ok: true, value: Object.fromEntries(entries) };
}

export function formatSha256Sums(entries: Record<string, string>): string {
	return Object.entries(entries).map(([name, hash]) => `${hash}  ${name}\n`).join("");
}

function parseCommittedHashes(): Record<FixtureName, string> {
	const parsed = parseSha256Sums(__SHA256SUMS__);
	if (!parsed.ok) {
		throw new Error(`SHA256SUMS ${parsed.path}: ${parsed.reason}`);
	}
	return {
		"fixture-a.md": committedHash(parsed.value, "fixture-a.md"),
		"fixture-b.md": committedHash(parsed.value, "fixture-b.md"),
		"attachment.bin": committedHash(parsed.value, "attachment.bin"),
	};
}

function committedHash(entries: Record<string, string>, name: FixtureName): string {
	const hash = entries[name];
	if (hash === undefined) {
		throw new Error(`SHA256SUMS has no entry for ${name}`);
	}
	return hash;
}
