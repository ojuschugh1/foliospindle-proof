import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { DeadlineError } from "../src/deadline.ts";
import { APP_METADATA, createSession, type InitSummary, type SdkSession, validatePhrase } from "../src/sdk-adapter.ts";
import { embeddedWasmBase64Length, embeddedWasmBytes } from "../src/wasm-embed.ts";
import { EPOCH_ISO, FakeClock, FakeTimers } from "./fakes.ts";

type InitOutcome = "resolve" | "reject" | "hang";

interface Harness {
	session: SdkSession;
	clock: FakeClock;
	timers: FakeTimers;
	counts: { init: number; bytes: number };
}

const FAKE_WASM = Uint8Array.of(1, 2, 3, 4);
const INIT_MS = 5;
const DEADLINE_MS = 1000;
const BOOM = new Error("boom");

const nodeSha256 = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function makeSession(overrides: { layoutReady?: Promise<void>; outcomes?: InitOutcome[] } = {}): Harness {
	const clock = new FakeClock();
	const timers = new FakeTimers();
	const counts = { init: 0, bytes: 0 };
	const outcomes = [...(overrides.outcomes ?? [])];
	const session = createSession({
		layoutReady: overrides.layoutReady ?? Promise.resolve(),
		wasmBytes: () => {
			counts.bytes += 1;
			return new Uint8Array(FAKE_WASM);
		},
		clock: () => clock.read(),
		now: () => clock.date(),
		deadlineMs: DEADLINE_MS,
		initFn: () => {
			counts.init += 1;
			const outcome = outcomes.shift() ?? "resolve";
			if (outcome === "hang") {
				return new Promise(() => {});
			}
			if (outcome === "reject") {
				return Promise.reject(BOOM);
			}
			clock.advance(INIT_MS);
			return Promise.resolve({ memory: new WebAssembly.Memory({ initial: 1 }) });
		},
		timers,
	});
	return { session, clock, timers, counts };
}

test("foliospindle-proof Property 8: Initialization runs once per load", async () => {
	for (let n = 1; n <= 20; n += 1) {
		const { session, counts } = makeSession();
		const calls: Promise<InitSummary>[] = [];
		const flags: boolean[] = [];
		for (let i = 0; i < n; i += 1) {
			calls.push(session.initialize());
			flags.push(session.initializedInThisCall());
		}
		assert.deepEqual(flags, Array.from({ length: n }, (_, i) => i === 0), `n=${n}`);
		const summaries = await Promise.all(calls);
		assert.equal(counts.init, 1, `n=${n}`);
		assert.equal(counts.bytes, 1, `n=${n}`);
		const summary = session.initSummary();
		assert.ok(summary !== null, `n=${n}`);
		for (const resolved of summaries) {
			assert.equal(resolved, summary, `n=${n}`);
		}
		assert.deepEqual(summary, {
			startedAt: EPOCH_ISO,
			durationMs: INIT_MS,
			wasmBytes: FAKE_WASM.length,
			wasmSha256: nodeSha256(FAKE_WASM),
			expectedWasmSha256: __SDK_WASM_SHA256__,
		});
		assert.equal(await session.initialize(), summary, `n=${n}`);
		assert.equal(session.initializedInThisCall(), false, `n=${n}`);
		assert.equal(counts.init, 1, `n=${n}`);
	}
	const retry = makeSession({ outcomes: ["reject"] });
	await assert.rejects(retry.session.initialize(), (e) => e === BOOM);
	assert.equal(retry.counts.init, 1);
	assert.equal(retry.session.initSummary(), null);
	const summary = await retry.session.initialize();
	assert.equal(retry.counts.init, 2);
	assert.equal(retry.session.initializedInThisCall(), true);
	assert.equal(retry.session.initSummary(), summary);
	assert.equal(summary.durationMs, INIT_MS);
});

test("a hanging initializer loses the deadline race and the next initialize retries", async () => {
	const { session, counts, timers } = makeSession({ outcomes: ["hang"] });
	const p = session.initialize();
	await settle();
	assert.equal(counts.init, 1);
	assert.deepEqual(timers.delays, [DEADLINE_MS]);
	assert.equal(timers.pending.size, 1);
	timers.fire();
	await assert.rejects(p, (e) => e instanceof DeadlineError && e.step === "wasm-init" && e.ms === DEADLINE_MS);
	assert.equal(session.initSummary(), null);
	assert.equal(session.wasmMemoryBytes(), null);
	const summary = await session.initialize();
	assert.equal(counts.init, 2);
	assert.equal(session.initSummary(), summary);
	assert.equal(summary.durationMs, INIT_MS);
	assert.deepEqual(timers.delays, [DEADLINE_MS, DEADLINE_MS]);
	assert.equal(timers.pending.size, 0);
});

test("initialize waits for layoutReady before decoding the bytes or calling the initializer", async () => {
	let releaseLayout: () => void = () => {};
	const layoutReady = new Promise<void>((resolve) => {
		releaseLayout = resolve;
	});
	const { session, counts, timers } = makeSession({ layoutReady });
	const p = session.initialize();
	await settle();
	assert.equal(session.initializedInThisCall(), true);
	assert.equal(counts.bytes, 0);
	assert.equal(counts.init, 0);
	assert.equal(timers.delays.length, 0);
	assert.equal(session.initSummary(), null);
	releaseLayout();
	const summary = await p;
	assert.equal(counts.bytes, 1);
	assert.equal(counts.init, 1);
	assert.equal(session.initSummary(), summary);
});

test("validatePhrase is false for an invalid phrase", () => {
	assert.equal(validatePhrase("not a phrase"), false);
	assert.equal(validatePhrase(""), false);
});

test("embeddedWasmBytes decodes the SDK module once and it hashes to __SDK_WASM_SHA256__", () => {
	assert.equal(embeddedWasmBase64Length(), 2213216);
	const bytes = embeddedWasmBytes();
	assert.equal(bytes.length, 1659910);
	assert.equal(nodeSha256(bytes), __SDK_WASM_SHA256__);
	assert.equal(embeddedWasmBytes(), bytes);
});

test("wasmMemoryBytes is null before initialization and one page after the fake initializer", async () => {
	const { session } = makeSession();
	assert.equal(session.wasmMemoryBytes(), null);
	await session.initialize();
	assert.equal(session.wasmMemoryBytes(), 65536);
});

test("APP_METADATA uses the SHA-256 of foliospindle-proof as appId and no logo or callback URL", () => {
	assert.equal(APP_METADATA.appId, nodeSha256("foliospindle-proof"));
	assert.equal(APP_METADATA.callbackUrl, undefined);
	assert.equal(APP_METADATA.logoUrl, undefined);
});
