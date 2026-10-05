import type { SecretStore, VaultWriter } from "../src/context.ts";
import type { DeadlineTimers } from "../src/deadline.ts";

export const TEST_SEED = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff);
export const EPOCH_ISO = "2026-10-12T14:23:07.123Z";
export const EPOCH = Date.parse(EPOCH_ISO);

export class FakeSecretStore implements SecretStore {
	values = new Map<string, string>();
	calls: string[] = [];

	getSecret(id: string): string | null {
		this.calls.push(`get:${id}`);
		return this.values.get(id) ?? null;
	}

	setSecret(id: string, secret: string): void {
		this.calls.push(`set:${id}`);
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
