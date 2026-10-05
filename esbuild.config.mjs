import esbuild from "esbuild";
import process from "node:process";
import builtins from "builtin-modules";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const sdkDir = "node_modules/@siafoundation/sia-storage";
const sumsFile = "fixtures/SHA256SUMS";

const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

const sdkVersion = JSON.parse(readFileSync(`${sdkDir}/package.json`, "utf8")).version;
const wasmSha256 = sha256Hex(readFileSync(`${sdkDir}/wasm/sia_storage_wasm_bg.wasm`));

const verifyFixtures = () => {
  const problems = [];
  readFileSync(sumsFile, "utf8").trimEnd().split("\n").forEach((line, index) => {
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    if (!match) {
      problems.push(`${sumsFile}:${index + 1}: malformed line`);
      return;
    }
    const [, expected, name] = match;
    const path = `fixtures/${name}`;
    if (!existsSync(path)) {
      problems.push(`${path}: missing`);
      return;
    }
    const actual = sha256Hex(readFileSync(path));
    if (actual !== expected) {
      problems.push(`${path}: expected ${expected}, got ${actual}`);
    }
  });
  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(problem);
    }
    process.exit(1);
  }
};

const buildOptions = (prod) => {
  const sha256SumsText = readFileSync(sumsFile, "utf8");
  return {
    banner: { js: "/* foliospindle-proof: bundled by esbuild; source at https://github.com/ojuschugh1/foliospindle-proof */" },
    entryPoints: ["src/main.ts"],
    bundle: true,
    format: "cjs",
    target: "es2021",
    platform: "browser",
    external: ["obsidian", "electron", "@codemirror/autocomplete", "@codemirror/collab", "@codemirror/commands", "@codemirror/language", "@codemirror/lint", "@codemirror/search", "@codemirror/state", "@codemirror/view", "@lezer/common", "@lezer/highlight", "@lezer/lr", ...builtins],
    loader: { ".wasm": "base64", ".md": "base64", ".bin": "base64" },
    define: {
      "import.meta.url": JSON.stringify("file:///main.js"),
      "__SDK_VERSION__": JSON.stringify(sdkVersion),
      "__SDK_WASM_SHA256__": JSON.stringify(wasmSha256),
      "__SHA256SUMS__": JSON.stringify(sha256SumsText),
    },
    minify: prod,
    sourcemap: prod ? false : "inline",
    legalComments: "none",
    treeShaking: true,
    logLevel: "info",
    outfile: "main.js",
  };
};

export { buildOptions };

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const prod = process.argv[2] === "production";
  verifyFixtures();
  const context = await esbuild.context(buildOptions(prod));
  if (prod) {
    await context.rebuild();
    await context.dispose();
  } else {
    await context.watch();
  }
}
