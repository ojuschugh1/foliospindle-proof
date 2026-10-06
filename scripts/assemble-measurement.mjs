import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const usage = "usage: node scripts/assemble-measurement.mjs --records <dir> --label <platform-label> --device <model> --os <version> --date YYYY-MM-DD [--tag emulator] [--tag secondary] [--entered <receipt.json>]";
const commands = ["capability", "connect", "remove-credential", "upload", "download", "enter-receipt", "events"];
const sdkCommands = ["upload", "download", "events"];
const receiptNames = ["fixture-a.md", "fixture-b.md", "attachment.bin", "probe"];
const fixtureNames = ["fixture-a.md", "fixture-b.md", "attachment.bin"];
const passNames = ["create", "update", "deletion", "incremental"];
const authoritySteps = ["objectFetch", "updateObjectMetadata", "deleteObject"];
const eventsDescription = "coalesced current-state feed";
const forbiddenPhrases = ["audit log", "audit history", "version history"];
const forbiddenCharacter = /[\u2013\u2014\p{Extended_Pictographic}]/u;
const labelForm = /^[a-z0-9][a-z0-9-]*$/;
const dateForm = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const sha256Form = /^[0-9a-f]{64}$/;
const objectIdForm = /^[0-9a-fA-F]+$/;
const pathToken = /\[[^\]]*\]|[^.[\]]+/g;
const findings = [];

const report = (finding) => {
  findings.push(finding);
};

const usageError = (message) => {
  console.error(message);
  console.error(usage);
  process.exit(1);
};

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === "string" && value.length > 0;
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
const present = (value) => value !== undefined && value !== null && value !== "";

const valueAt = (object, path) =>
  (path.match(pathToken) ?? []).reduce((current, token) => {
    if (token.startsWith("[")) {
      const name = token.slice(1, -1);
      return Array.isArray(current) ? current.find((entry) => isObject(entry) && entry.name === name) : undefined;
    }
    return isObject(current) ? current[token] : undefined;
  }, object);

const receiptProblems = (receipt) => {
  if (!isObject(receipt)) {
    return ["not an object"];
  }
  const problems = [];
  if (receipt.formatVersion !== 1) {
    problems.push("formatVersion is not 1");
  }
  if (!isNonEmptyString(receipt.sdkVersion)) {
    problems.push("sdkVersion is not a non-empty string");
  }
  if (!isNonEmptyString(receipt.platformLabel)) {
    problems.push("platformLabel is not a non-empty string");
  }
  if (!isNonEmptyString(receipt.uploadedAt) || Number.isNaN(Date.parse(receipt.uploadedAt))) {
    problems.push("uploadedAt is not a timestamp");
  }
  if (!Array.isArray(receipt.objects)) {
    problems.push("objects is not an array");
    return problems;
  }
  if (receipt.objects.length !== receiptNames.length) {
    problems.push(`objects has ${receipt.objects.length} entries, expected ${receiptNames.length}`);
  }
  for (const name of receiptNames) {
    const entry = receipt.objects.find((object) => isObject(object) && object.name === name);
    if (entry === undefined) {
      problems.push(`objects has no entry for ${name}`);
      continue;
    }
    if (!isCount(entry.bytes)) {
      problems.push(`objects[${name}].bytes is not a non-negative integer`);
    }
    if (typeof entry.sha256 !== "string" || !sha256Form.test(entry.sha256)) {
      problems.push(`objects[${name}].sha256 is not 64 lowercase hex characters`);
    }
    if (typeof entry.objectId !== "string" || !objectIdForm.test(entry.objectId)) {
      problems.push(`objects[${name}].objectId is not hex`);
    }
    if (!isCount(entry.uploadMs)) {
      problems.push(`objects[${name}].uploadMs is not a non-negative integer`);
    }
  }
  return problems;
};

const options = {
  records: { type: "string" },
  label: { type: "string" },
  device: { type: "string" },
  os: { type: "string" },
  date: { type: "string" },
  tag: { type: "string", multiple: true },
  entered: { type: "string" },
};
let values;
try {
  ({ values } = parseArgs({ options, strict: true, allowPositionals: false }));
} catch (error) {
  usageError(error.message);
}
for (const name of ["records", "label", "device", "os", "date"]) {
  if (!isNonEmptyString(values[name])) {
    usageError(`--${name} is required`);
  }
}
const tags = values.tag ?? [];
for (const value of [values.label, ...tags]) {
  if (!labelForm.test(value)) {
    usageError(`${JSON.stringify(value)} is not a label of lowercase letters, digits and hyphens`);
  }
}
const dateMs = Date.parse(`${values.date}T00:00:00Z`);
if (!dateForm.test(values.date) || Number.isNaN(dateMs) || new Date(dateMs).toISOString().slice(0, 10) !== values.date) {
  usageError(`--date ${JSON.stringify(values.date)} is not a calendar date in YYYY-MM-DD form`);
}
const recordsDir = resolve(values.records);
if (!existsSync(recordsDir) || !statSync(recordsDir).isDirectory()) {
  usageError(`--records ${JSON.stringify(values.records)} is not a directory`);
}

let entered = null;
let enteredName = null;
let enteredValid = false;
if (values.entered !== undefined) {
  enteredName = basename(values.entered);
  try {
    entered = JSON.parse(readFileSync(values.entered, "utf8"));
  } catch (error) {
    usageError(`--entered ${JSON.stringify(values.entered)}: ${error.message}`);
  }
  const problems = receiptProblems(entered);
  for (const problem of problems) {
    report(`${enteredName}: ${problem}`);
  }
  enteredValid = problems.length === 0;
}

const records = [];
for (const name of readdirSync(recordsDir).sort()) {
  if (!name.endsWith(".json")) {
    continue;
  }
  let record;
  try {
    record = JSON.parse(readFileSync(join(recordsDir, name), "utf8"));
  } catch (error) {
    report(`${name}: ${error.message}`);
    continue;
  }
  if (!isObject(record) || record.formatVersion !== 1 || !commands.includes(record.command) || !isObject(record.result)) {
    report(`${name}: not a command record`);
    continue;
  }
  records.push({ name, record, time: Date.parse(record.startedAt) });
}
if (records.length === 0) {
  report(`${values.records}: no command records`);
}

const later = (a, b) => {
  if (!Number.isNaN(a.time) && !Number.isNaN(b.time) && a.time !== b.time) {
    return a.time > b.time ? a : b;
  }
  return a.name > b.name ? a : b;
};
const latest = (entries) => entries.reduce((best, entry) => (best === null ? entry : later(best, entry)), null);
const ofCommand = (command, accept = () => true) => records.filter((entry) => entry.record.command === command && accept(entry.record));
const latestWith = (command, accept) => latest(ofCommand(command, accept)) ?? latest(ofCommand(command));

const capabilityEntry = latest(ofCommand("capability"));
const connectEntry = latest(ofCommand("connect"));
const removalEntry = latest(ofCommand("remove-credential"));
const uploadEntry = latestWith("upload", (record) => isObject(record.result.receipt));
const ownEntry = latest(ofCommand("download", (record) => record.result.crossInstallation === false));
const crossEntry = latest(ofCommand("download", (record) => record.result.crossInstallation === true));
const eventsEntry = latestWith("events", (record) => isObject(record.result.authority));
const reconnectEntry = latest(records.filter((entry) => sdkCommands.includes(entry.record.command) && isObject(entry.record.reconnect) && entry.record.reconnect.method === "connected"));
const authority = eventsEntry !== null && isObject(eventsEntry.record.result.authority) ? eventsEntry.record.result.authority : null;

const agreement = new Map();
const agree = (key, value, source) => {
  if (!present(value)) {
    return;
  }
  const seen = agreement.get(key) ?? [];
  if (!seen.some((entry) => entry.value === value)) {
    seen.push({ value, source });
  }
  agreement.set(key, seen);
};
for (const { name, record } of records) {
  agree("pluginVersion", record.pluginVersion, name);
  agree("sdkVersion", record.sdkVersion, name);
  if (isObject(record.init)) {
    agree("wasmSha256", record.init.wasmSha256, name);
  }
  if (record.command === "capability") {
    agree("pluginVersion", record.result.pluginVersion, `${name} result`);
    agree("sdkVersion", record.result.sdkVersion, `${name} result`);
    if (isObject(record.result.mainJs)) {
      agree("mainJsSha256", record.result.mainJs.sha256, name);
    }
  }
  if (record.command === "upload" && isObject(record.result.receipt)) {
    agree("sdkVersion", record.result.receipt.sdkVersion, `${name} receipt`);
  }
}
if (enteredValid) {
  agree("sdkVersion", entered.sdkVersion, enteredName);
}
for (const [key, seen] of agreement) {
  if (seen.length > 1) {
    report(`disagree: ${key}: ${seen.map((entry) => `${JSON.stringify(entry.value)} (${entry.source})`).join(", ")}`);
  }
}
const agreed = (key) => agreement.get(key)?.[0]?.value ?? null;

if (enteredValid && crossEntry !== null) {
  const used = crossEntry.record.result;
  if (entered.platformLabel !== used.receiptPlatformLabel) {
    report(`${enteredName}: platformLabel ${JSON.stringify(entered.platformLabel)} differs from receiptPlatformLabel ${JSON.stringify(used.receiptPlatformLabel)} in ${crossEntry.name}`);
  }
  for (const object of Array.isArray(used.objects) ? used.objects : []) {
    const entry = entered.objects.find((candidate) => candidate.name === object.name);
    if (entry !== undefined && (entry.objectId !== object.objectId || entry.sha256 !== object.receiptSha256)) {
      report(`${enteredName}: objects[${object.name}] differs from the receipt used by ${crossEntry.name}`);
    }
  }
}
if (enteredValid && authority !== null) {
  const probe = entered.objects.find((candidate) => candidate.name === "probe");
  if (probe.objectId !== authority.receiptProbeId) {
    report(`${enteredName}: objects[probe].objectId differs from authority.receiptProbeId in ${eventsEntry.name}`);
  }
}

const withOutcome = (entry) => (entry === null ? null : { ...entry.record.result, outcome: entry.record.outcome });
const capabilityRecord = capabilityEntry === null ? null : capabilityEntry.record;
const init = capabilityRecord !== null && isObject(capabilityRecord.init) ? capabilityRecord.init : null;
const mainJs = capabilityRecord !== null && isObject(capabilityRecord.result.mainJs) && !("error" in capabilityRecord.result.mainJs) ? capabilityRecord.result.mainJs : null;
const measurement = {
  formatVersion: 1,
  platformLabel: values.label,
  labels: [values.label, ...tags],
  runDate: values.date,
  device: {
    model: values.device,
    osVersion: values.os,
    obsidianVersion: capabilityRecord === null ? null : (capabilityRecord.platform?.obsidianApiVersion ?? null),
    pluginVersion: agreed("pluginVersion"),
    sdkVersion: agreed("sdkVersion"),
  },
  artifact: {
    mainJsBytes: mainJs === null ? null : (mainJs.bytes ?? null),
    mainJsSha256: mainJs === null ? null : (mainJs.sha256 ?? null),
    wasmInitMs: init === null ? null : (init.durationMs ?? null),
    wasmSha256: init === null ? null : (init.wasmSha256 ?? null),
  },
  capability: capabilityRecord === null ? null : { ...capabilityRecord.result, platform: capabilityRecord.platform ?? null },
  connect: withOutcome(connectEntry),
  reconnectAfterRestart: reconnectEntry === null ? null : { command: reconnectEntry.record.command, ...reconnectEntry.record.reconnect },
  credentialRemoval: withOutcome(removalEntry),
  upload: uploadEntry === null ? null : { objects: uploadEntry.record.result.objects ?? null, memory: uploadEntry.record.result.memory ?? null },
  download: { own: withOutcome(ownEntry), cross: withOutcome(crossEntry) },
  events: eventsEntry === null ? null : { observations: eventsEntry.record.result.observations ?? null, authority, description: eventsDescription },
  receipts: { produced: uploadEntry === null ? null : (uploadEntry.record.result.receipt ?? null), entered },
  sources: [...new Set([capabilityEntry, connectEntry, removalEntry, uploadEntry, ownEntry, crossEntry, eventsEntry, reconnectEntry].filter((entry) => entry !== null).map((entry) => entry.name))].sort(),
};

const memory = valueAt(measurement, "upload.memory");
const heapNotMeasured = isObject(memory) && (memory.jsHeapBefore === "not measured" || memory.jsHeapAfter === "not measured");
const required = [
  "device.model",
  "device.osVersion",
  "device.obsidianVersion",
  "device.pluginVersion",
  "device.sdkVersion",
  "artifact.mainJsBytes",
  "artifact.mainJsSha256",
  "artifact.wasmInitMs",
  "artifact.wasmSha256",
  "capability.decision",
  "capability.minimumPlatforms",
  "capability.onloadMs",
  "capability.platform.platformClass",
  "capability.platform.isSecureContext",
  "capability.platform.webTransportType",
  "connect.outcome",
  "connect.publicKeyHex",
  "reconnectAfterRestart.command",
  "reconnectAfterRestart.method",
  "reconnectAfterRestart.outcome",
  "reconnectAfterRestart.durationMs",
  "credentialRemoval.outcome",
  "credentialRemoval.hadSeed",
  ...receiptNames.flatMap((name) => [`upload.objects[${name}].bytes`, `upload.objects[${name}].uploadMs`]),
  "upload.memory.jsHeapBefore",
  "upload.memory.jsHeapAfter",
  ...(heapNotMeasured ? ["upload.memory.jsHeapReason"] : []),
  "upload.memory.wasmMemoryBytesAfter",
  "download.own.outcome",
  ...fixtureNames.flatMap((name) => ["downloadMs", "downloadedSha256", "receiptSha256", "committedSha256", "match"].map((field) => `download.own.objects[${name}].${field}`)),
  "events.observations",
  "events.authority.receiptProbeId",
  ...authoritySteps.map((step) => `events.authority.${step}`),
  "receipts.produced",
  "runDate",
];
const missing = required.filter((path) => !present(valueAt(measurement, path)));
const crossEvidence = crossEntry ?? (authority === null ? null : eventsEntry);
if (entered === null && crossEvidence !== null) {
  missing.push(`receipts.entered (pass --entered <receipt.json> with the receipt used by ${crossEvidence.name})`);
}
for (const path of missing) {
  report(`missing: ${path}`);
}

const text = `${JSON.stringify(measurement, null, 2)}\n`;
const lower = text.toLowerCase();
for (const phrase of forbiddenPhrases) {
  if (lower.includes(phrase)) {
    report(`output contains ${JSON.stringify(phrase)}`);
  }
}
if (forbiddenCharacter.test(text)) {
  report("output contains an en dash, em dash or emoji");
}

const describeStep = (step) => {
  if (!isObject(step) || step.attempted !== true) {
    return "not attempted";
  }
  return step.ok === true ? `ok in ${step.durationMs ?? 0} ms` : "failed";
};

const gate = (id, title, checks) => {
  const status = checks.some((check) => check.ok === false) ? "fail" : checks.some((check) => check.ok === null) ? "unknown" : "pass";
  console.log(`${id} ${title}: ${status}; ${checks.map((check) => check.text).join("; ")}`);
};

const printGateSummary = () => {
  const { capability, connect, reconnectAfterRestart, credentialRemoval, upload, download, events } = measurement;
  const observations = events.observations;
  const wasmHashMatches = init.wasmSha256 === init.expectedWasmSha256;
  const matches = download.own.objects.filter((object) => object.match === true).length;
  const spanning = passNames.filter((pass) => isObject(observations.d) && observations.d[pass] === true);
  const refusalEntry = latest(records.filter((entry) => sdkCommands.includes(entry.record.command) && entry.time > removalEntry.time && isObject(entry.record.error) && entry.record.error.kind === "refusal" && entry.record.error.step === "credential"));
  console.log(`Advisory gate summary for ${values.label} ${values.date}, per platform; the README Gate_Report records the final pass or fail once the macOS and iOS records are committed.`);
  gate("G1", "Single-file packaging", [
    { ok: capability.decision === "supported", text: `capability decision ${capability.decision}${Array.isArray(capability.missing) && capability.missing.length > 0 ? ` (missing ${capability.missing.join("; ")})` : ""}` },
    { ok: capabilityEntry.record.outcome === "passed", text: `WASM init ${measurement.artifact.wasmInitMs} ms from the embedded bytes, first in its load: ${init.firstInThisLoad === true ? "yes" : "no"}` },
    { ok: wasmHashMatches, text: wasmHashMatches ? "decoded WASM hash matches the pinned SDK" : "decoded WASM hash differs from the pinned SDK" },
    { ok: capability.onloadMs <= 1000, text: `onload ${capability.onloadMs} ms` },
    { ok: true, text: `main.js ${measurement.artifact.mainJsBytes} bytes` },
  ]);
  gate("G2", "Direct authorization and transfer", [
    { ok: connect.outcome === "passed", text: `connect ${connect.outcome}, plan ${connect.plan}, reconnecting ${String(connect.reconnecting)}` },
    { ok: uploadEntry.record.outcome === "passed", text: `upload ${uploadEntry.record.outcome}` },
    { ok: download.own.outcome === "passed", text: `own download ${download.own.outcome}` },
    { ok: true, text: "the gate needs this result on macOS and on iOS" },
  ]);
  gate("G3", "Byte identity and mobile stability", [
    { ok: matches === fixtureNames.length, text: `${matches} of ${fixtureNames.length} fixtures match the receipt and SHA256SUMS` },
    { ok: uploadEntry.record.outcome === "passed" && download.own.outcome === "passed", text: "upload and download records were written, so the run completed without a crash" },
    { ok: true, text: `jsHeapAfter ${upload.memory.jsHeapAfter}${present(upload.memory.jsHeapReason) ? ` (${upload.memory.jsHeapReason})` : ""}, wasmMemoryBytesAfter ${upload.memory.wasmMemoryBytesAfter}` },
  ]);
  gate("G4", "Lifecycle behaviours", [
    { ok: reconnectAfterRestart.method === "connected" && reconnectAfterRestart.outcome === "ok", text: `restart reconnect ${reconnectAfterRestart.method} ${reconnectAfterRestart.outcome} in ${reconnectAfterRestart.durationMs} ms (${reconnectAfterRestart.command} record)` },
    { ok: credentialRemoval.outcome === "passed" && credentialRemoval.hadSeed === true, text: `credential removal ${credentialRemoval.outcome}, seed was ${credentialRemoval.hadSeed === true ? "" : "not "}stored` },
    { ok: refusalEntry === null ? null : true, text: refusalEntry === null ? "no refused SDK command recorded after the removal" : `refusal after removal recorded in ${refusalEntry.name}` },
    { ok: connect.outcome === "passed", text: `connect plan ${connect.plan}, phrase entry ${connect.entryOutcome ?? "not applicable"}` },
    { ok: download.cross === null ? null : download.cross.outcome === "passed", text: download.cross === null ? "no cross-installation download recorded" : `cross-installation download ${download.cross.outcome} with the ${download.cross.receiptPlatformLabel} receipt` },
    { ok: authoritySteps.every((step) => isObject(authority[step]) && authority[step].ok === true), text: `probe authority ${authoritySteps.map((step) => `${step} ${describeStep(authority[step])}`).join(", ")}` },
    { ok: capability.decision === "supported", text: `secure context ${String(capability.platform.isSecureContext)}, typeof WebTransport ${capability.platform.webTransportType}` },
    { ok: true, text: "compare connect.publicKeyHex with the other installation's record" },
  ]);
  gate("G5", "Live events", [
    { ok: observations.a?.createDistinct === 1, text: `${eventsDescription}: create pass distinct probe events ${observations.a?.createDistinct}` },
    { ok: observations.b?.updateDistinct === 1 && observations.b?.laterThanCreate === true, text: `update pass distinct probe events ${observations.b?.updateDistinct}, later than create ${String(observations.b?.laterThanCreate)}` },
    { ok: observations.c?.tombstoneSeen === true, text: `deletion pass distinct probe events ${observations.c?.deletionDistinct}, tombstone seen ${String(observations.c?.tombstoneSeen)}` },
    { ok: spanning.length === 0, text: `ids on more than one page: ${spanning.length === 0 ? "none" : spanning.join(", ")}` },
    { ok: observations.e?.allLaterThanDeletionCursor === true, text: `incremental pass distinct events ${observations.e?.incrementalDistinct}, all later than the deletion cursor ${String(observations.e?.allLaterThanDeletionCursor)}` },
  ]);
};

if (findings.length > 0) {
  for (const finding of findings) {
    console.error(finding);
  }
  process.exitCode = 1;
} else {
  const outputPath = join(root, "measurements", `${values.label}-${values.date}.json`);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, text);
  console.log(`wrote ${relative(root, outputPath)}`);
  printGateSummary();
}
