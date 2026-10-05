import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { load } from "./asset-hooks.ts";

const sdkDir = new URL("../node_modules/@siafoundation/sia-storage/", import.meta.url);
const sdkPackage = JSON.parse(readFileSync(new URL("package.json", sdkDir), "utf8")) as { version: string };
const wasmBytes = readFileSync(new URL("wasm/sia_storage_wasm_bg.wasm", sdkDir));

Object.assign(globalThis, {
	__SDK_VERSION__: sdkPackage.version,
	__SDK_WASM_SHA256__: createHash("sha256").update(wasmBytes).digest("hex"),
	__SHA256SUMS__: readFileSync(new URL("../fixtures/SHA256SUMS", import.meta.url), "utf8"),
});

registerHooks({ load });
