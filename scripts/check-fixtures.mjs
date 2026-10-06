import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const dir = process.argv[2] ?? "fixtures";
const sumsPath = join(dir, "SHA256SUMS");
const sumsLine = /^([0-9a-f]{64})  (.+)$/;
const nonAscii = /[\u0080-\u{10ffff}]/u;
const decoder = new TextDecoder("utf-8", { fatal: true });

const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

const problems = [];
const markdown = [];
const binary = [];
const bytesOf = new Map();
let sumsPresent = false;

for (const name of readdirSync(dir).sort()) {
  const path = join(dir, name);
  if (!lstatSync(path).isFile()) {
    problems.push(`${path}: not a regular file`);
  } else if (name === "SHA256SUMS") {
    sumsPresent = true;
  } else if (name.endsWith(".md")) {
    markdown.push(name);
    bytesOf.set(name, readFileSync(path));
  } else if (name.endsWith(".bin")) {
    binary.push(name);
    bytesOf.set(name, readFileSync(path));
  } else {
    problems.push(`${path}: unexpected entry`);
  }
}

const checkSize = (name, min, max) => {
  const size = bytesOf.get(name).length;
  if (size < min || size > max) {
    problems.push(`${join(dir, name)}: ${size} bytes, expected ${min} to ${max}`);
  }
};

const decodeMarkdown = (name) => {
  try {
    return decoder.decode(bytesOf.get(name));
  } catch {
    problems.push(`${join(dir, name)}: not valid UTF-8`);
    return "";
  }
};

if (markdown.length !== 2) {
  problems.push(`${dir}: expected 2 .md fixtures, found ${markdown.length}`);
}
for (const name of markdown) {
  checkSize(name, 1024, 65536);
}
if (markdown.length === 2 && bytesOf.get(markdown[0]).length === bytesOf.get(markdown[1]).length) {
  problems.push(`${dir}: ${markdown[0]} and ${markdown[1]} have the same size`);
}
const multibyte = markdown.filter((name) => nonAscii.test(decodeMarkdown(name)));
if (markdown.length > 0 && multibyte.length === 0) {
  problems.push(`${dir}: no .md fixture contains a code point at or above U+0080`);
}

if (binary.length !== 1) {
  problems.push(`${dir}: expected 1 .bin fixture, found ${binary.length}`);
}
for (const name of binary) {
  checkSize(name, 131072, 1048576);
}

if (!sumsPresent) {
  problems.push(`${sumsPath}: missing`);
} else {
  const listed = new Map();
  const lines = readFileSync(sumsPath, "utf8").split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  lines.forEach((line, index) => {
    const match = sumsLine.exec(line);
    if (!match) {
      problems.push(`${sumsPath}:${index + 1}: malformed line`);
    } else if (listed.has(match[2])) {
      problems.push(`${sumsPath}:${index + 1}: duplicate line for ${match[2]}`);
    } else {
      listed.set(match[2], match[1]);
    }
  });
  for (const [name, expected] of listed) {
    if (!bytesOf.has(name)) {
      problems.push(`${sumsPath}: lists ${name}, which is ${existsSync(join(dir, name)) ? "not a fixture" : "missing"}`);
    } else {
      const actual = sha256Hex(bytesOf.get(name));
      if (actual !== expected) {
        problems.push(`${join(dir, name)}: expected ${expected}, got ${actual}`);
      }
    }
  }
  for (const name of bytesOf.keys()) {
    if (!listed.has(name)) {
      problems.push(`${sumsPath}: no line for ${name}`);
    }
  }
}

if (problems.length > 0) {
  for (const problem of problems) {
    console.error(problem);
  }
  process.exit(1);
}
