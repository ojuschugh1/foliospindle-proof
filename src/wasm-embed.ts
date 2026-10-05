import wasmBase64 from "@siafoundation/sia-storage/wasm/sia_storage_wasm_bg.wasm";
import { decodeBase64 } from "./encoding.ts";

let cache: Uint8Array | null = null;

export function embeddedWasmBase64Length(): number {
	return wasmBase64.length;
}

export function embeddedWasmBytes(): Uint8Array {
	if (cache === null) {
		cache = decodeBase64(wasmBase64);
	}
	return cache;
}
