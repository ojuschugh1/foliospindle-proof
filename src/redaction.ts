import { toBase64, toBase64Url, toHex } from "./encoding.ts";

const REPLACEMENT = "[redacted]";

export interface Redactor {
	add(seed: Uint8Array): void;
	redact(text: string): string;
}

export function encodingsOf(seed: Uint8Array): string[] {
	const hex = toHex(seed);
	return [hex, hex.toUpperCase(), ...base64Forms(seed)];
}

export function createRedactor(): Redactor {
	const added = new Set<string>();
	const patterns: (string | RegExp)[] = [];
	return {
		add(seed) {
			const hex = toHex(seed);
			if (hex.length === 0 || added.has(hex)) {
				return;
			}
			added.add(hex);
			patterns.push(new RegExp(hex, "gi"), ...base64Forms(seed));
			patterns.sort((a, b) => patternLength(b) - patternLength(a));
		},
		redact(text) {
			let result = text;
			for (const pattern of patterns) {
				result = result.replaceAll(pattern, REPLACEMENT);
			}
			return result;
		},
	};
}

function base64Forms(seed: Uint8Array): string[] {
	return [toBase64(seed, true), toBase64(seed, false), toBase64Url(seed, true), toBase64Url(seed, false)];
}

function patternLength(pattern: string | RegExp): number {
	return typeof pattern === "string" ? pattern.length : pattern.source.length;
}
