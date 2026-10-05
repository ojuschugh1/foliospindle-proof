import { toHex } from "./encoding.ts";

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
	return toHex(new Uint8Array(digest));
}
