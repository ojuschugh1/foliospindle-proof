import type { CommandContext, EventCursor, InitSummary, PlatformInfo, RecordedEvent, SecretStore, SettingsStore, VaultWriter } from "../src/context.ts";
import type { DeadlineTimers } from "../src/deadline.ts";
import { RECORDS_FOLDER, type CommandRecord } from "../src/records.ts";
import { createRedactor } from "../src/redaction.ts";
import type { BuilderHandle, ObjectHandle, PackedHandle, SdkHandle, SdkSession } from "../src/sdk-adapter.ts";
import { DEFAULT_SETTINGS, type PluginSettings } from "../src/settings.ts";

export const TEST_SEED = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff);
export const EPOCH_ISO = "2026-10-12T14:23:07.123Z";
export const EPOCH = Date.parse(EPOCH_ISO);

export class FakeSecretStore implements SecretStore {
	values = new Map<string, string>();
	calls: string[] = [];
	throwOnSet: Error | null = null;

	getSecret(id: string): string | null {
		this.calls.push(`get:${id}`);
		return this.values.get(id) ?? null;
	}

	setSecret(id: string, secret: string): void {
		this.calls.push(`set:${id}`);
		if (this.throwOnSet !== null) {
			throw this.throwOnSet;
		}
		this.values.set(id, secret);
	}

	listSecrets(): string[] {
		return [...this.values.keys()];
	}
}

export class FakeVault implements VaultWriter {
	files = new Map<string, string | Uint8Array>();
	folders = new Set<string>();
	log: string[] = [];

	async exists(path: string): Promise<boolean> {
		return this.has(path);
	}

	async isFolder(path: string): Promise<boolean> {
		return this.folders.has(path);
	}

	async createFolder(path: string): Promise<void> {
		if (this.has(path)) {
			throw new Error("Folder already exists.");
		}
		this.folders.add(path);
		this.log.push(`createFolder:${path}`);
	}

	async createText(path: string, text: string): Promise<void> {
		this.create("createText", path, text);
	}

	async createBinary(path: string, bytes: Uint8Array): Promise<void> {
		this.create("createBinary", path, bytes.slice());
	}

	async replaceText(path: string, text: string): Promise<void> {
		this.replace("replaceText", path, text);
	}

	async replaceBinary(path: string, bytes: Uint8Array): Promise<void> {
		this.replace("replaceBinary", path, bytes.slice());
	}

	text(path: string): string {
		const value = this.files.get(path);
		if (typeof value !== "string") {
			throw new Error(`no text file at ${path}`);
		}
		return value;
	}

	binary(path: string): Uint8Array {
		const value = this.files.get(path);
		if (!(value instanceof Uint8Array)) {
			throw new Error(`no binary file at ${path}`);
		}
		return value;
	}

	private has(path: string): boolean {
		return this.files.has(path) || this.folders.has(path);
	}

	private create(op: string, path: string, value: string | Uint8Array): void {
		if (this.has(path)) {
			throw new Error("File already exists.");
		}
		this.files.set(path, value);
		this.log.push(`${op}:${path}`);
	}

	private replace(op: string, path: string, value: string | Uint8Array): void {
		if (!this.files.has(path)) {
			throw new Error("File does not exist.");
		}
		this.files.set(path, value);
		this.log.push(`${op}:${path}`);
	}
}

export class FakeClock {
	now = 0;

	advance(ms: number): void {
		this.now += ms;
	}

	read(): number {
		return this.now;
	}

	date(): Date {
		return new Date(EPOCH + this.now);
	}
}

export class FakeTimers implements DeadlineTimers {
	pending = new Map<number, () => void>();
	nextHandle = 1;
	delays: number[] = [];
	cleared: number[] = [];

	set(callback: () => void, ms: number): number {
		const handle = this.nextHandle;
		this.nextHandle += 1;
		this.pending.set(handle, callback);
		this.delays.push(ms);
		return handle;
	}

	clear(handle: number): void {
		this.pending.delete(handle);
		this.cleared.push(handle);
	}

	fire(handle?: number): void {
		const target = handle ?? this.pending.keys().next().value;
		if (target === undefined) {
			throw new Error("no pending timer");
		}
		const callback = this.pending.get(target);
		if (callback === undefined) {
			throw new Error(`no pending timer ${target}`);
		}
		this.pending.delete(target);
		callback();
	}

	fireAll(): void {
		for (const handle of [...this.pending.keys()]) {
			this.fire(handle);
		}
	}
}

export const TEST_PHRASE = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
export const TEST_PUBLIC_KEY = "0123456789abcdef".repeat(4);
export const TEST_PLATFORM: PlatformInfo = {
	platformClass: "macos",
	osVersion: "not exposed",
	obsidianApiVersion: "1.11.4",
	uaString: "test",
	isSecureContext: true,
	webTransportType: "function",
};

export interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: Error) => void;
}

export function deferred<T>(): Deferred<T> {
	let resolve: (value: T) => void = () => {};
	let reject: (error: Error) => void = () => {};
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

export class FakeObject implements ObjectHandle {
	objectId: string;
	byteLength: number;

	constructor(objectId: string, byteLength: number) {
		this.objectId = objectId;
		this.byteLength = byteLength;
	}

	id(): string {
		return this.objectId;
	}

	size(): number {
		return this.byteLength;
	}
}

export class FakeSdk implements SdkHandle {
	calls: string[] = [];
	failures = new Map<string, Error>();
	seed: Uint8Array = TEST_SEED;
	publicKey = TEST_PUBLIC_KEY;
	contents = new Map<string, Uint8Array>();
	objects = new Map<string, FakeObject>();
	objectSizes = new Map<string, number>();
	downloads = new Map<string, Uint8Array>();
	eventPages: RecordedEvent[][] = [];
	finalizeReturns: FakeObject[] | null = null;
	packedRemaining = 4194304;
	nextId = 0;
	occurrences = new Map<string, number>();

	exportSeed(): Uint8Array {
		this.call("exportSeed");
		return this.seed.slice();
	}

	publicKeyHex(): string {
		this.call("publicKeyHex");
		return this.publicKey;
	}

	async upload(bytes: Uint8Array): Promise<ObjectHandle> {
		this.call("upload", `upload:${bytes.length}`);
		return this.store(bytes);
	}

	uploadPacked(): PackedHandle {
		this.call("uploadPacked");
		const pending: Uint8Array[] = [];
		let added = 0;
		return {
			add: async (bytes) => {
				this.call("add", `add:${bytes.length}`);
				pending.push(bytes.slice());
				added += bytes.length;
				return added;
			},
			finalize: async () => {
				this.call("finalize");
				const objects = pending.splice(0).map((chunk) => this.store(chunk));
				return this.finalizeReturns ?? objects;
			},
			remaining: () => {
				this.call("remaining");
				return this.packedRemaining - added;
			},
		};
	}

	async pin(obj: ObjectHandle): Promise<void> {
		this.call("pin", `pin:${obj.id()}`);
	}

	async object(id: string): Promise<ObjectHandle> {
		this.call("object", `object:${id}`);
		return this.objects.get(id) ?? new FakeObject(id, this.objectSizes.get(id) ?? 0);
	}

	async downloadAll(obj: ObjectHandle): Promise<Uint8Array> {
		const id = obj.id();
		this.call("downloadAll", `downloadAll:${id}`);
		const bytes = this.downloads.get(id) ?? this.contents.get(id) ?? new Uint8Array(0);
		return bytes.slice();
	}

	async objectEvents(cursor: EventCursor | null, limit: number): Promise<RecordedEvent[]> {
		this.call("objectEvents", `objectEvents:${JSON.stringify(cursor)}:${limit}`);
		return this.eventPages.shift() ?? [];
	}

	async updateMetadata(obj: ObjectHandle, payload: Uint8Array): Promise<void> {
		this.call("updateMetadata", `updateMetadata:${obj.id()}:${payload.length}`);
	}

	async deleteObject(id: string): Promise<void> {
		this.call("deleteObject", `deleteObject:${id}`);
	}

	free(): void {
		this.call("free");
	}

	private store(bytes: Uint8Array): FakeObject {
		this.nextId += 1;
		const id = (0x1000 + this.nextId).toString(16);
		const object = new FakeObject(id, bytes.length);
		this.contents.set(id, bytes.slice());
		this.objects.set(id, object);
		return object;
	}

	private call(name: string, entry: string = name): void {
		this.calls.push(entry);
		const occurrence = (this.occurrences.get(name) ?? 0) + 1;
		this.occurrences.set(name, occurrence);
		const error = this.failures.get(name) ?? this.failures.get(`${name}#${occurrence}`);
		if (error !== undefined) {
			throw error;
		}
	}
}

export class FakeBuilder implements BuilderHandle {
	calls: string[] = [];
	url = "https://sia.storage/approve/abc";
	reconnectingFlag = false;
	matches = true;
	failures = new Map<string, Error>();
	holdApproval = false;
	approval = deferred<void>();
	phrase = TEST_PHRASE;
	sdk = new FakeSdk();
	checked: string[] = [];
	registeredWith: string[] = [];
	session: FakeSession;

	constructor(session: FakeSession) {
		this.session = session;
	}

	async requestConnection(): Promise<void> {
		this.call("requestConnection");
	}

	responseUrl(): string {
		this.calls.push("responseUrl");
		return this.url;
	}

	async waitForApproval(): Promise<void> {
		this.call("waitForApproval");
		if (this.holdApproval) {
			await this.approval.promise;
		}
	}

	reconnecting(): boolean {
		this.calls.push("reconnecting");
		return this.reconnectingFlag;
	}

	async registerFresh(): Promise<{ sdk: SdkHandle; phrase: string }> {
		this.call("register");
		this.session.live = this.sdk;
		return { sdk: this.sdk, phrase: this.phrase };
	}

	async matchesExistingAppKey(phrase: string): Promise<boolean> {
		this.checked.push(phrase);
		this.call("matchesExistingAppKey");
		return this.matches;
	}

	async registerWith(phrase: string): Promise<SdkHandle> {
		this.registeredWith.push(phrase);
		this.call("register", "register:with");
		this.session.live = this.sdk;
		return this.sdk;
	}

	private call(name: string, entry: string = name): void {
		this.calls.push(entry);
		const error = this.failures.get(name);
		if (error !== undefined) {
			throw error;
		}
	}
}

export class FakeSession implements SdkSession {
	initOutcome: "resolve" | "reject" | "hang" = "resolve";
	initCalls = 0;
	summary: InitSummary = {
		startedAt: EPOCH_ISO,
		durationMs: 12,
		wasmBytes: 1659910,
		wasmSha256: __SDK_WASM_SHA256__,
		expectedWasmSha256: __SDK_WASM_SHA256__,
	};
	first = true;
	builder = new FakeBuilder(this);
	createBuilderUrls: string[] = [];
	live: SdkHandle | null = null;
	stored: SdkHandle | null = new FakeSdk();
	connectStoredCalls: { indexerUrl: string; seed: Uint8Array }[] = [];
	connectStoredFails: Error | null = null;
	discardCalls = 0;
	initialized = false;

	initialize(): Promise<InitSummary> {
		this.initCalls += 1;
		if (this.initOutcome === "hang") {
			return new Promise<InitSummary>(() => {});
		}
		if (this.initOutcome === "reject") {
			return Promise.reject(new Error("init failed"));
		}
		this.initialized = true;
		return Promise.resolve(this.summary);
	}

	initSummary(): InitSummary | null {
		return this.initialized ? this.summary : null;
	}

	initializedInThisCall(): boolean {
		const first = this.first;
		this.first = false;
		return first;
	}

	createBuilder(indexerUrl: string): BuilderHandle {
		this.createBuilderUrls.push(indexerUrl);
		return this.builder;
	}

	async connectStored(indexerUrl: string, seed: Uint8Array): Promise<SdkHandle | null> {
		this.connectStoredCalls.push({ indexerUrl, seed: seed.slice() });
		if (this.connectStoredFails !== null) {
			throw this.connectStoredFails;
		}
		this.live = this.stored;
		return this.stored;
	}

	current(): SdkHandle | null {
		return this.live;
	}

	discard(): void {
		this.live = null;
		this.discardCalls += 1;
	}

	wasmMemoryBytes(): number | null {
		return this.initialized ? 65536 : null;
	}
}

export class FakeSettingsStore implements SettingsStore {
	value: PluginSettings;
	saves: PluginSettings[] = [];

	constructor(value: PluginSettings) {
		this.value = value;
	}

	get(): PluginSettings {
		return this.value;
	}

	async save(next: PluginSettings): Promise<void> {
		this.saves.push(next);
		this.value = next;
	}
}

export interface Harness {
	ctx: CommandContext;
	session: FakeSession;
	secrets: FakeSecretStore;
	vault: FakeVault;
	settings: FakeSettingsStore;
	clock: FakeClock;
	notices: string[];
	shows: { title: string; text: string }[];
	prompts: string[];
	promptAnswers: (string | null)[];
	opened: string[];
	records(): CommandRecord<unknown>[];
}

export interface HarnessOverrides {
	platform?: Partial<PlatformInfo>;
	settings?: Partial<PluginSettings>;
	promptAnswers?: (string | null)[];
	jsHeapBytes?: () => number | null;
	readInstalledMainJs?: () => Promise<Uint8Array | null>;
}

export function fakeContext(overrides: HarnessOverrides = {}): Harness {
	const session = new FakeSession();
	const secrets = new FakeSecretStore();
	const vault = new FakeVault();
	const settings = new FakeSettingsStore({ ...DEFAULT_SETTINGS, ...overrides.settings });
	const clock = new FakeClock();
	const redactor = createRedactor();
	const notices: string[] = [];
	const shows: { title: string; text: string }[] = [];
	const prompts: string[] = [];
	const promptAnswers = [...(overrides.promptAnswers ?? [])];
	const opened: string[] = [];
	const ctx: CommandContext = {
		pluginVersion: "0.1.0",
		platform: { ...TEST_PLATFORM, ...overrides.platform },
		session,
		secrets,
		vault,
		settings,
		redactor,
		notify: (text) => {
			notices.push(redactor.redact(text));
		},
		show: (title, text) => {
			shows.push({ title, text: redactor.redact(text) });
		},
		prompt: async (title) => {
			prompts.push(title);
			return promptAnswers.shift() ?? null;
		},
		openExternal: (url) => {
			opened.push(url);
		},
		clock: () => clock.read(),
		now: () => clock.date(),
		readInstalledMainJs: overrides.readInstalledMainJs ?? (async () => Uint8Array.of(1, 2, 3)),
		onloadMs: 12,
		jsHeapBytes: overrides.jsHeapBytes ?? (() => null),
	};
	return {
		ctx,
		session,
		secrets,
		vault,
		settings,
		clock,
		notices,
		shows,
		prompts,
		promptAnswers,
		opened,
		records: () => recordsIn(vault),
	};
}

export function recordPaths(vault: FakeVault): string[] {
	return [...vault.files.keys()].filter((path) => path.startsWith(`${RECORDS_FOLDER}/`)).sort();
}

function recordsIn(vault: FakeVault): CommandRecord<unknown>[] {
	return recordPaths(vault).map((path) => JSON.parse(vault.text(path)) as CommandRecord<unknown>);
}
