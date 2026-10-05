import type { PlatformClass, PlatformInfo } from "./context.ts";

export type Decision = "supported" | "unsupported";
export const MINIMUM_PLATFORMS = "iOS 26.4 or later; a Chromium WebView with WebTransport on Android; a desktop Obsidian build with WebTransport";
export const PRIVATE_RELAY_HINT = "If iCloud Private Relay is on, turn it off before a transfer. The SDK's WebTransport connections do not work through it.";

const TRANSPORT_ERROR_MARKERS = ["transport", "webtransport", "quic", "network", "failed to fetch", "load failed", "connection"];

export function decideCapability(isSecureContext: boolean, webTransportType: string): Decision {
	return isSecureContext && webTransportType === "function" ? "supported" : "unsupported";
}

export function missingCapabilities(isSecureContext: boolean, webTransportType: string): string[] {
	const missing: string[] = [];
	if (!isSecureContext) {
		missing.push("secure context (isSecureContext is false)");
	}
	if (webTransportType !== "function") {
		missing.push(`WebTransport (typeof WebTransport is "${webTransportType}")`);
	}
	return missing;
}

export function gate(info: PlatformInfo): { ok: true } | { ok: false; message: string } {
	const missing = missingCapabilities(info.isSecureContext, info.webTransportType);
	if (missing.length === 0) {
		return { ok: true };
	}
	return { ok: false, message: `Missing: ${missing.join("; ")}. Minimum supported platforms: ${MINIMUM_PLATFORMS}.` };
}

export function privateRelayHint(cls: PlatformClass): string | null {
	return cls === "ios" || cls === "macos" ? PRIVATE_RELAY_HINT : null;
}

export function isTransportError(message: string): boolean {
	const lower = message.toLowerCase();
	return TRANSPORT_ERROR_MARKERS.some((marker) => lower.includes(marker));
}

export function failureText(prefix: string, cls: PlatformClass, message: string): string {
	const text = `${prefix}: ${message}`;
	const hint = privateRelayHint(cls);
	return hint !== null && isTransportError(message) ? `${text} ${hint}` : text;
}
