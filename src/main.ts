import { Notice, Platform, Plugin, type SecretStorage, TFile, TFolder, type Vault, apiVersion, normalizePath } from "obsidian";
import { runCapability } from "./commands/capability.ts";
import { runConnect } from "./commands/connect.ts";
import { runDownload } from "./commands/download.ts";
import { runEnterReceipt } from "./commands/enter-receipt.ts";
import { runEvents } from "./commands/events.ts";
import { runRemoveCredential } from "./commands/remove-credential.ts";
import { runUpload } from "./commands/upload.ts";
import type { CommandContext, PlatformInfo, SecretStore, VaultWriter } from "./context.ts";
import { classify, osVersionFromUa } from "./platform.ts";
import { type Redactor, createRedactor } from "./redaction.ts";
import { type SdkSession, createSession } from "./sdk-adapter.ts";
import { IndexerSettingTab } from "./settings-tab.ts";
import { DEFAULT_SETTINGS, type PluginSettings, validateIndexerUrl } from "./settings.ts";
import { TextEntryModal, TextModal } from "./ui.ts";
import { embeddedWasmBytes } from "./wasm-embed.ts";

const INIT_DEADLINE_MS = 30000;

export default class FolioSpindleProofPlugin extends Plugin {
	settings: PluginSettings = { ...DEFAULT_SETTINGS };
	session!: SdkSession;
	redactor: Redactor = createRedactor();
	onloadMs = 0;
	layoutReady!: Promise<void>;

	async onload(): Promise<void> {
		const t0 = clock();
		this.layoutReady = new Promise<void>((resolve) => {
			this.app.workspace.onLayoutReady(() => {
				resolve();
			});
		});
		this.session = createSession({
			layoutReady: this.layoutReady,
			wasmBytes: embeddedWasmBytes,
			clock,
			now,
			deadlineMs: INIT_DEADLINE_MS,
			logWarn: (text) => {
				console.warn(this.redactor.redact(text));
			},
		});
		this.settings = settingsFrom((await this.loadData()) as Partial<PluginSettings> | null);
		this.addSettingTab(new IndexerSettingTab(this.app, this));
		this.addCommand({
			id: "capability-check",
			name: "Check runtime capability",
			callback: () => {
				void runCapability(this.context());
			},
		});
		this.addCommand({
			id: "connect",
			name: "Connect to indexer",
			callback: () => {
				void runConnect(this.context());
			},
		});
		this.addCommand({
			id: "remove-credential",
			name: "Remove stored credential",
			callback: () => {
				void runRemoveCredential(this.context());
			},
		});
		this.addCommand({
			id: "upload-fixtures",
			name: "Upload fixtures and probe",
			callback: () => {
				void runUpload(this.context());
			},
		});
		this.addCommand({
			id: "download-fixtures",
			name: "Download fixtures from receipt",
			callback: () => {
				void runDownload(this.context());
			},
		});
		this.addCommand({
			id: "enter-receipt",
			name: "Enter demo receipt",
			callback: () => {
				void runEnterReceipt(this.context());
			},
		});
		this.addCommand({
			id: "observe-events",
			name: "Observe object events",
			callback: () => {
				void runEvents(this.context());
			},
		});
		this.onloadMs = clock() - t0;
	}

	onunload(): void {
		this.session.discard();
	}

	async saveSettings(next: PluginSettings): Promise<void> {
		this.settings = next;
		await this.saveData(next);
	}

	context(): CommandContext {
		return {
			pluginVersion: this.manifest.version,
			platform: platformInfo(),
			session: this.session,
			secrets: secretStore(this.app.secretStorage),
			vault: vaultWriter(this.app.vault),
			settings: {
				get: () => this.settings,
				save: (next) => this.saveSettings(next),
			},
			redactor: this.redactor,
			notify: (text) => {
				new Notice(this.redactor.redact(text));
			},
			show: (title, text) => {
				new TextModal(this.app, title, this.redactor.redact(text)).open();
			},
			prompt: (title) =>
				new Promise<string | null>((resolve) => {
					new TextEntryModal(this.app, title, resolve).open();
				}),
			openExternal: (url) => {
				window.open(url);
			},
			clock,
			now,
			readInstalledMainJs: () => installedMainJs(this.app.vault, this.manifest.dir),
			onloadMs: this.onloadMs,
			jsHeapBytes,
		};
	}
}

function clock(): number {
	return performance.now();
}

function now(): Date {
	return new Date();
}

function settingsFrom(data: Partial<PluginSettings> | null): PluginSettings {
	const merged: PluginSettings = { ...DEFAULT_SETTINGS, ...data };
	if (typeof merged.indexerUrl !== "string" || !validateIndexerUrl(merged.indexerUrl).ok) {
		merged.indexerUrl = DEFAULT_SETTINGS.indexerUrl;
	}
	return merged;
}

function platformInfo(): PlatformInfo {
	const platformClass = classify(Platform);
	const { userAgent } = navigator;
	return {
		platformClass,
		osVersion: osVersionFromUa(platformClass, userAgent),
		obsidianApiVersion: apiVersion,
		uaString: userAgent,
		isSecureContext,
		webTransportType: typeof WebTransport,
	};
}

function secretStore(storage: SecretStorage): SecretStore {
	return {
		getSecret(id) {
			return storage.getSecret(id);
		},
		setSecret(id, secret) {
			storage.setSecret(id, secret);
		},
		listSecrets() {
			return storage.listSecrets();
		},
	};
}

function vaultWriter(vault: Vault): VaultWriter {
	return {
		async exists(path) {
			return vault.getAbstractFileByPath(path) !== null;
		},
		async isFolder(path) {
			return vault.getAbstractFileByPath(path) instanceof TFolder;
		},
		async createFolder(path) {
			await vault.createFolder(path);
		},
		async createText(path, text) {
			await vault.create(path, text);
		},
		async createBinary(path, bytes) {
			await vault.createBinary(path, copyOf(bytes));
		},
		async replaceText(path, text) {
			await vault.modify(fileAt(vault, path), text);
		},
		async replaceBinary(path, bytes) {
			await vault.modifyBinary(fileAt(vault, path), copyOf(bytes));
		},
	};
}

function fileAt(vault: Vault, path: string): TFile {
	const file = vault.getAbstractFileByPath(path);
	if (file instanceof TFile) {
		return file;
	}
	throw new Error(`No file at ${path}`);
}

function copyOf(bytes: Uint8Array): ArrayBuffer {
	return new Uint8Array(bytes).buffer;
}

async function installedMainJs(vault: Vault, dir: string | undefined): Promise<Uint8Array | null> {
	if (dir === undefined) {
		return null;
	}
	try {
		return new Uint8Array(await vault.adapter.readBinary(normalizePath(`${dir}/main.js`)));
	} catch {
		return null;
	}
}

function jsHeapBytes(): number | null {
	const { memory } = performance as Performance & { memory?: { usedJSHeapSize: number } };
	return memory?.usedJSHeapSize ?? null;
}
