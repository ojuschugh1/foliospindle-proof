import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { findMatches } from "../scripts/boundary-lib.mjs";
import { forAll, type Gen } from "./gen.ts";

type BoundaryFile = { path: string; text: string };
type Match = { path: string; line: number; literal: string };

const TEXT_ALPHABET = "abcdefghijkl(.\"' ";
const PATH_ALPHABET = "abc";
const DENYLIST = [
	"vault.on(",
	"workspace.on(",
	"metadataCache.on(",
	"registerEvent(",
	"registerInterval(",
	"setInterval(",
	".on(\"create\"",
	".on('create'",
	".on(\"modify\"",
	".on('modify'",
	".on(\"delete\"",
	".on('delete'",
	".on(\"rename\"",
	".on('rename'",
	"createSharingKey",
	"shareObject",
	"sharedObjects",
	"unshareObject",
	"revokeSharingKey",
	"objectShareUrl",
	"pruneSlabs",
	"this.register(",
	"unregister(",
	"connectPreAuthorized",
	"stream-worker",
	"serviceWorker",
	"localStorage",
	"sessionStorage",
];
const REGISTER_FILE: BoundaryFile = {
	path: "src/main.ts",
	text: [
		"this.register(() => dispose());",
		"handle.unregister();",
		"this.registerEvent(ref);",
		"this.registerInterval(id);",
		"this.addCommand(command);",
		"this.addSettingTab(tab);",
		"const key = await builder.register(phrase);",
	].join("\n"),
};

const order = (a: string | number, b: string | number): number => (a < b ? -1 : a > b ? 1 : 0);

const byPosition = (a: Match, b: Match): number =>
	order(a.path, b.path) || order(a.line, b.line) || order(a.literal, b.literal);

const naiveMatches = (files: BoundaryFile[], literals: string[]): Match[] => {
	const found: Match[] = [];
	for (const { path, text } of files) {
		for (const [index, content] of text.split("\n").entries()) {
			for (const literal of literals) {
				if (content.indexOf(literal) !== -1) {
					found.push({ path, line: index + 1, literal });
				}
			}
		}
	}
	return found.sort(byPosition);
};

const insertAt = (text: string, insertion: string, at: number): string =>
	text.slice(0, at) + insertion + text.slice(at);

function genFile(g: Gen): BoundaryFile {
	const path = Array.from({ length: g.int(1, 3) }, () => g.string(PATH_ALPHABET, g.int(1, 3))).join("/");
	const lines = Array.from({ length: g.int(0, 6) }, () => g.string(TEXT_ALPHABET, g.int(0, 20)));
	return { path, text: lines.join("\n") };
}

function shuffled<T>(g: Gen, list: readonly T[]): T[] {
	const pool = [...list];
	const out: T[] = [];
	while (pool.length > 0) {
		out.push(...pool.splice(g.int(0, pool.length - 1), 1));
	}
	return out;
}

function withInsertion(g: Gen, files: BoundaryFile[], literal: string): BoundaryFile[] {
	const target = g.pick(files);
	const lines = target.text.split("\n");
	const row = g.int(0, lines.length - 1);
	const content = lines[row] ?? "";
	lines[row] = insertAt(content, literal, g.int(0, content.length));
	return files.map((file) => (file === target ? { path: file.path, text: lines.join("\n") } : file));
}

test("foliospindle-proof Property 6: Boundary matcher is deterministic and single-match sensitive", async () => {
	let withMatch = 0;
	let withoutMatch = 0;
	await forAll(200, (g) => {
		const files = Array.from({ length: g.int(0, 5) }, () => genFile(g));
		const literals = Array.from({ length: g.int(1, 10) }, () => g.string(TEXT_ALPHABET, g.int(1, 6)));
		const label = JSON.stringify({ files, literals });
		const matches = findMatches(files, literals);
		assert.deepEqual(findMatches(files, literals), matches, label);
		assert.deepEqual(findMatches(shuffled(g, files), shuffled(g, literals)), matches, label);
		assert.deepEqual(matches, naiveMatches(files, literals), label);
		const occurs = files.some((file) => literals.some((literal) => file.text.includes(literal)));
		assert.equal(matches.length > 0, occurs, label);
		withMatch += occurs ? 1 : 0;
		withoutMatch += occurs ? 0 : 1;
		let sensitized = withInsertion(g, files.length > 0 ? files : [genFile(g)], g.pick(literals));
		for (let extra = g.int(0, 3); extra > 0; extra -= 1) {
			sensitized = withInsertion(g, sensitized, g.pick(literals));
		}
		const sensitive = findMatches(sensitized, literals);
		assert.ok(sensitive.length > 0, `no match after insertion: ${JSON.stringify({ sensitized, literals })}`);
		assert.deepEqual(sensitive, naiveMatches(sensitized, literals), label);
	});
	assert.ok(withMatch >= 50, `only ${withMatch} iterations had a natural match`);
	assert.ok(withoutMatch >= 50, `only ${withoutMatch} iterations had no natural match`);
});

test("unshareObject also matches shareObject", () => {
	const file = { path: "src/a.ts", text: "await sdk.unshareObject(id);" };
	assert.deepEqual(findMatches([file], DENYLIST), [
		{ path: "src/a.ts", line: 1, literal: "shareObject" },
		{ path: "src/a.ts", line: 1, literal: "unshareObject" },
	]);
});

test("this.register( and unregister( match the cleanup hook and an unregister call only", () => {
	assert.deepEqual(findMatches([REGISTER_FILE], ["this.register(", "unregister("]), [
		{ path: "src/main.ts", line: 1, literal: "this.register(" },
		{ path: "src/main.ts", line: 2, literal: "unregister(" },
	]);
	assert.deepEqual(findMatches([REGISTER_FILE], DENYLIST), [
		{ path: "src/main.ts", line: 1, literal: "this.register(" },
		{ path: "src/main.ts", line: 2, literal: "unregister(" },
		{ path: "src/main.ts", line: 3, literal: "registerEvent(" },
		{ path: "src/main.ts", line: 4, literal: "registerInterval(" },
	]);
});

test("the committed boundary denylist equals the Requirement 9.5 list", () => {
	const text = readFileSync(new URL("../scripts/boundary-denylist.txt", import.meta.url), "utf8");
	assert.equal(DENYLIST.length, 28);
	assert.deepEqual(text.split("\n"), [...DENYLIST, ""]);
});
