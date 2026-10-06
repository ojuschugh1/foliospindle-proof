import type { Receipt } from "./receipt.ts";

export interface PluginSettings {
	indexerUrl: string;
	receipt: Receipt | null;
}

export const DEFAULT_SETTINGS: PluginSettings = { indexerUrl: "https://sia.storage", receipt: null };

export function validateIndexerUrl(value: string): { ok: true; url: string } | { ok: false; reason: string } {
	const trimmed = value.trim();
	if (trimmed === "") {
		return { ok: false, reason: "empty" };
	}
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return { ok: false, reason: "not an absolute URL" };
	}
	if (url.protocol !== "https:") {
		return { ok: false, reason: "only https URLs are accepted" };
	}
	if (url.hostname === "") {
		return { ok: false, reason: "missing host" };
	}
	return { ok: true, url: trimmed };
}
