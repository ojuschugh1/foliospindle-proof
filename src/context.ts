import type { Redactor } from "./redaction.ts";
import type { SdkSession } from "./sdk-adapter.ts";
import type { PluginSettings } from "./settings.ts";

export type CommandName = "capability" | "connect" | "remove-credential" | "upload" | "download" | "enter-receipt" | "events";
export type PlatformClass = "macos" | "ios" | "android" | "desktop-other" | "unknown";

export interface PlatformInfo {
	platformClass: PlatformClass;
	osVersion: string;
	obsidianApiVersion: string;
	uaString: string;
	isSecureContext: boolean;
	webTransportType: string;
}

export interface SecretStore {
	getSecret(id: string): string | null;
	setSecret(id: string, secret: string): void;
	listSecrets(): string[];
}

export interface VaultWriter {
	exists(path: string): Promise<boolean>;
	isFolder(path: string): Promise<boolean>;
	createFolder(path: string): Promise<void>;
	createText(path: string, text: string): Promise<void>;
	createBinary(path: string, bytes: Uint8Array): Promise<void>;
	replaceText(path: string, text: string): Promise<void>;
	replaceBinary(path: string, bytes: Uint8Array): Promise<void>;
}

export interface InitSummary {
	startedAt: string;
	durationMs: number;
	wasmBytes: number;
	wasmSha256: string;
	expectedWasmSha256: string;
}

export interface EventCursor {
	id: string;
	after: string;
}

export interface RecordedEvent {
	id: string;
	deleted: boolean;
	updatedAt: string;
	objectPresent: boolean;
}

export interface SettingsStore {
	get(): PluginSettings;
	save(next: PluginSettings): Promise<void>;
}

export interface CommandContext {
	pluginVersion: string;
	platform: PlatformInfo;
	session: SdkSession;
	secrets: SecretStore;
	vault: VaultWriter;
	settings: SettingsStore;
	redactor: Redactor;
	notify(text: string): void;
	show(title: string, text: string): void;
	prompt(title: string): Promise<string | null>;
	openExternal(url: string): void;
	clock(): number;
	now(): Date;
	readInstalledMainJs(): Promise<Uint8Array | null>;
	onloadMs: number;
	jsHeapBytes(): number | null;
}
