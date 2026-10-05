import __wbg_init, { AppKey, Builder, PinnedObject, type AppMetadata, type Sdk, generateRecoveryPhrase, setLogger, validateRecoveryPhrase } from "@siafoundation/sia-storage/wasm";
import type { EventCursor, InitSummary, RecordedEvent } from "./context.ts";
import type { DeadlineTimers } from "./deadline.ts";
import { withDeadline } from "./deadline.ts";
import { sha256Hex } from "./hashing.ts";

export type { EventCursor, InitSummary, RecordedEvent } from "./context.ts";

export const APP_METADATA: AppMetadata = {
	appId: "1c319f5148a02f9274f4eddb8d2e9abe042292f2b5c8d93ea6acbe3371b08fec",
	name: "FolioSpindle Proof",
	description: "Unfunded pre-application proof for a notes vault sync plugin",
	serviceUrl: "https://github.com/ojuschugh1/foliospindle-proof",
	logoUrl: undefined,
	callbackUrl: undefined,
};

export interface ObjectHandle {
	id(): string;
	size(): number;
}

export interface PackedHandle {
	add(bytes: Uint8Array): Promise<number>;
	finalize(): Promise<ObjectHandle[]>;
	remaining(): number;
}

export interface SdkHandle {
	exportSeed(): Uint8Array;
	publicKeyHex(): string;
	upload(bytes: Uint8Array): Promise<ObjectHandle>;
	uploadPacked(): PackedHandle;
	pin(obj: ObjectHandle): Promise<void>;
	object(id: string): Promise<ObjectHandle>;
	downloadAll(obj: ObjectHandle): Promise<Uint8Array>;
	objectEvents(cursor: EventCursor | null, limit: number): Promise<RecordedEvent[]>;
	updateMetadata(obj: ObjectHandle, payload: Uint8Array): Promise<void>;
	deleteObject(id: string): Promise<void>;
	free(): void;
}

export interface BuilderHandle {
	requestConnection(): Promise<void>;
	responseUrl(): string;
	waitForApproval(): Promise<void>;
	reconnecting(): boolean;
	registerFresh(): Promise<{ sdk: SdkHandle; phrase: string }>;
	matchesExistingAppKey(phrase: string): Promise<boolean>;
	registerWith(phrase: string): Promise<SdkHandle>;
}

export interface SdkSession {
	initialize(): Promise<InitSummary>;
	initSummary(): InitSummary | null;
	initializedInThisCall(): boolean;
	createBuilder(indexerUrl: string): BuilderHandle;
	connectStored(indexerUrl: string, seed: Uint8Array): Promise<SdkHandle | null>;
	current(): SdkHandle | null;
	discard(): void;
	wasmMemoryBytes(): number | null;
}

export interface SessionDeps {
	layoutReady: Promise<void>;
	wasmBytes: () => Uint8Array;
	clock: () => number;
	now: () => Date;
	deadlineMs: number;
	initFn?: (input: { module_or_path: Uint8Array }) => Promise<{ memory: WebAssembly.Memory }>;
	timers?: DeadlineTimers;
	logWarn?: (text: string) => void;
}

let loggerInstalled = false;

export function createSession(deps: SessionDeps): SdkSession {
	const init = deps.initFn ?? glueInit;
	const usesGlue = deps.initFn === undefined;
	let pending: Promise<InitSummary> | null = null;
	let summary: InitSummary | null = null;
	let memory: WebAssembly.Memory | null = null;
	let startedByLastCall = false;
	let current: SdkHandle | null = null;

	async function runInit(): Promise<InitSummary> {
		await deps.layoutReady;
		const startedAt = deps.now().toISOString();
		const t0 = deps.clock();
		const bytes = deps.wasmBytes();
		const output = await withDeadline(init({ module_or_path: bytes }), deps.deadlineMs, "wasm-init", deps.timers);
		const durationMs = deps.clock() - t0;
		memory = output.memory;
		if (usesGlue && deps.logWarn !== undefined) {
			installLogger(deps.logWarn);
		}
		summary = {
			startedAt,
			durationMs,
			wasmBytes: bytes.length,
			wasmSha256: await sha256Hex(bytes),
			expectedWasmSha256: __SDK_WASM_SHA256__,
		};
		return summary;
	}

	function wrap(sdk: Sdk): SdkHandle {
		const handle: SdkHandle = {
			exportSeed() {
				const key = sdk.appKey();
				try {
					return key.export();
				} finally {
					key.free();
				}
			},
			publicKeyHex() {
				const key = sdk.appKey();
				try {
					return key.publicKey().replace(/^ed25519:/, "").toLowerCase();
				} finally {
					key.free();
				}
			},
			upload(bytes) {
				return sdk.upload(new PinnedObject(), streamOf(bytes));
			},
			uploadPacked() {
				const packed = sdk.uploadPacked();
				return {
					add(bytes) {
						return packed.add(streamOf(bytes));
					},
					finalize() {
						return packed.finalize();
					},
					remaining() {
						return packed.remaining();
					},
				};
			},
			pin(obj) {
				return sdk.pinObject(pinned(obj));
			},
			object(id) {
				return sdk.object(id);
			},
			async downloadAll(obj) {
				const buffer = await new Response(sdk.download(pinned(obj))).arrayBuffer();
				return new Uint8Array(buffer);
			},
			async objectEvents(cursor, limit) {
				const events = await sdk.objectEvents(cursor === null ? null : { id: cursor.id, after: new Date(cursor.after) }, limit);
				return events.map((event) => {
					const object = event.object;
					const record: RecordedEvent = {
						id: event.id,
						deleted: event.deleted,
						updatedAt: event.updatedAt.toISOString(),
						objectPresent: object !== undefined,
					};
					object?.free();
					event.free();
					return record;
				});
			},
			async updateMetadata(obj, payload) {
				const target = pinned(obj);
				target.updateMetadata(payload);
				await sdk.updateObjectMetadata(target);
			},
			deleteObject(id) {
				return sdk.deleteObject(id);
			},
			free() {
				sdk.free();
			},
		};
		current = handle;
		return handle;
	}

	return {
		initialize() {
			if (pending !== null) {
				startedByLastCall = false;
				return pending;
			}
			startedByLastCall = true;
			const attempt = runInit();
			pending = attempt;
			attempt.catch(() => {
				pending = null;
			});
			return attempt;
		},
		initSummary() {
			return summary;
		},
		initializedInThisCall() {
			return startedByLastCall;
		},
		createBuilder(indexerUrl) {
			const builder = new Builder(indexerUrl, APP_METADATA);
			return {
				requestConnection() {
					return builder.requestConnection();
				},
				responseUrl() {
					return builder.responseUrl();
				},
				waitForApproval() {
					return builder.waitForApproval();
				},
				reconnecting() {
					return builder.reconnecting();
				},
				async registerFresh() {
					const phrase = generateRecoveryPhrase();
					const sdk = await builder.register(phrase);
					return { sdk: wrap(sdk), phrase };
				},
				matchesExistingAppKey(phrase) {
					return builder.matchesExistingAppKey(phrase);
				},
				async registerWith(phrase) {
					return wrap(await builder.register(phrase));
				},
			};
		},
		async connectStored(indexerUrl, seed) {
			const key = new AppKey(seed);
			try {
				const sdk = await new Builder(indexerUrl, APP_METADATA).connected(key);
				return sdk === undefined ? null : wrap(sdk);
			} finally {
				key.free();
			}
		},
		current() {
			return current;
		},
		discard() {
			const live = current;
			current = null;
			try {
				live?.free();
			} catch {
				return;
			}
		},
		wasmMemoryBytes() {
			return memory === null ? null : memory.buffer.byteLength;
		},
	};
}

export function validatePhrase(phrase: string): boolean {
	try {
		validateRecoveryPhrase(phrase);
		return true;
	} catch {
		return false;
	}
}

function glueInit(input: { module_or_path: Uint8Array }): Promise<{ memory: WebAssembly.Memory }> {
	return __wbg_init({ module_or_path: new Uint8Array(input.module_or_path) });
}

function installLogger(logWarn: (text: string) => void): void {
	if (loggerInstalled) {
		return;
	}
	setLogger(logWarn, "warn");
	loggerInstalled = true;
}

function pinned(obj: ObjectHandle): PinnedObject {
	if (!(obj instanceof PinnedObject)) {
		throw new TypeError("not an SDK object handle");
	}
	return obj;
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
	return new Blob([new Uint8Array(bytes)]).stream();
}
