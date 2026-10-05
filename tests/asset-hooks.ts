import { readFileSync } from "node:fs";
import type { LoadHookSync } from "node:module";

const ASSET_EXTENSIONS = [".md", ".bin", ".wasm"];

export const load: LoadHookSync = (url, context, nextLoad) => {
	if (!ASSET_EXTENSIONS.some((extension) => url.endsWith(extension))) {
		return nextLoad(url, context);
	}
	const base64 = readFileSync(new URL(url)).toString("base64");
	return {
		format: "module",
		shortCircuit: true,
		source: `export default ${JSON.stringify(base64)};`,
	};
};
