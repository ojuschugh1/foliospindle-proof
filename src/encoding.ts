const HEX_PATTERN = /^[0-9a-fA-F]*$/;
const BASE64_URL_PATTERN = /^[A-Za-z0-9_-]*={0,2}$/;

export function toHex(bytes: Uint8Array): string {
	let text = "";
	for (const byte of bytes) {
		text += byte.toString(16).padStart(2, "0");
	}
	return text;
}

export function fromHex(text: string): Uint8Array | null {
	if (text.length % 2 !== 0 || !HEX_PATTERN.test(text)) {
		return null;
	}
	const bytes = new Uint8Array(text.length / 2);
	for (let i = 0; i < bytes.length; i++) {
		bytes[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
	}
	return bytes;
}

export function toBase64(bytes: Uint8Array, padded: boolean): string {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	const text = btoa(binary);
	return padded ? text : text.replaceAll("=", "");
}

export function toBase64Url(bytes: Uint8Array, padded: boolean): string {
	return toBase64(bytes, padded).replaceAll("+", "-").replaceAll("/", "_");
}

export function fromBase64Url(text: string): Uint8Array | null {
	if (!BASE64_URL_PATTERN.test(text)) {
		return null;
	}
	const body = text.replaceAll("=", "");
	const remainder = body.length % 4;
	if (remainder === 1) {
		return null;
	}
	const padding = remainder === 0 ? "" : "=".repeat(4 - remainder);
	if (text.length !== body.length && text.length !== body.length + padding.length) {
		return null;
	}
	const standard = body.replaceAll("-", "+").replaceAll("_", "/") + padding;
	try {
		return decodeBase64(standard);
	} catch {
		return null;
	}
}

export function decodeBase64(text: string): Uint8Array {
	const binary = atob(text);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

export function utf8Encode(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

export function utf8Decode(bytes: Uint8Array): string | null {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return null;
	}
}
