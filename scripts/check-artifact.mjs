import esbuild from "esbuild";
import process from "node:process";
import { existsSync, readFileSync } from "node:fs";
import { buildOptions } from "../esbuild.config.mjs";

const artifact = "main.js";
const maxBytes = 5242880;
const wasmFile = "node_modules/@siafoundation/sia-storage/wasm/sia_storage_wasm_bg.wasm";
const sumsFile = "fixtures/SHA256SUMS";
const forbidden = ["sourceMappingURL", "import.meta", "check-relay.sia.storage", "navigator.serviceWorker", "stream-worker", "initSia"];
const inputRoots = ["src/", "fixtures/", "node_modules/"];

if (!existsSync(artifact)) {
  console.log(`${artifact}: missing, run npm run build first`);
  process.exit(1);
}

const findings = [];
const bytes = readFileSync(artifact);
const text = bytes.toString("utf8");
const options = buildOptions(true);

if (bytes.length > maxBytes) {
  findings.push(`${artifact}: ${bytes.length} bytes exceeds the ${maxBytes} byte limit`);
}
if (!text.includes(options.banner.js)) {
  findings.push(`${artifact}: banner missing`);
}
for (const literal of forbidden) {
  if (text.includes(literal)) {
    findings.push(`${artifact}: contains ${literal}`);
  }
}

const embedded = [wasmFile];
readFileSync(sumsFile, "utf8").trimEnd().split("\n").forEach((line, index) => {
  const match = /^[0-9a-f]{64}  (.+)$/.exec(line);
  if (match) {
    embedded.push(`fixtures/${match[1]}`);
  } else {
    findings.push(`${sumsFile}:${index + 1}: malformed line`);
  }
});
for (const path of embedded) {
  if (!text.includes(readFileSync(path).toString("base64"))) {
    findings.push(`${artifact}: base64 of ${path} not embedded`);
  }
}

const result = await esbuild.build({ ...options, write: false, metafile: true, logLevel: "warning" });
if (result.outputFiles.length !== 1) {
  findings.push(`rebuild: ${result.outputFiles.length} output files, expected 1`);
} else if (!bytes.equals(result.outputFiles[0].contents)) {
  findings.push(`${artifact}: differs from a fresh production build`);
}
for (const input of Object.keys(result.metafile.inputs)) {
  if (!inputRoots.some((root) => input.startsWith(root))) {
    findings.push(`rebuild: input ${input} lies outside ${inputRoots.join(", ")}`);
  }
}

for (const finding of findings) {
  console.log(finding);
}
if (findings.length > 0) {
  process.exitCode = 1;
}
