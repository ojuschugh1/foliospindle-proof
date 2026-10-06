import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const findings = [];

const report = (finding) => {
  findings.push(finding);
};

const forbiddenCharacter = /[\u2013\u2014\p{Extended_Pictographic}]/u;
const requiredPhrase = "coalesced current-state feed";
const forbiddenPhrases = ["audit log", "audit history", "version history"];

const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter((path) => path.length > 0);
for (const path of tracked) {
  const bytes = readFileSync(join(root, path));
  if (bytes.includes(0)) {
    continue;
  }
  bytes.toString("utf8").split(/\r?\n/).forEach((line, index) => {
    if (forbiddenCharacter.test(line)) {
      report(`${path}:${index + 1}`);
    }
  });
}

const checkPhrases = (file) => {
  const text = readFileSync(join(root, file), "utf8");
  if (!text.includes(requiredPhrase)) {
    report(`${file}: does not contain ${JSON.stringify(requiredPhrase)}`);
  }
  text.split(/\r?\n/).forEach((line, index) => {
    const lower = line.toLowerCase();
    for (const phrase of forbiddenPhrases) {
      if (lower.includes(phrase)) {
        report(`${file}:${index + 1}: contains ${JSON.stringify(phrase)}`);
      }
    }
  });
};

if (existsSync(join(root, "README.md"))) {
  checkPhrases("README.md");
} else {
  report("README.md: missing");
}

if (existsSync(join(root, "measurements"))) {
  for (const name of readdirSync(join(root, "measurements")).sort()) {
    if (name.endsWith(".json")) {
      checkPhrases(`measurements/${name}`);
    }
  }
}

for (const finding of findings) {
  console.error(finding);
}
if (findings.length > 0) {
  process.exitCode = 1;
}
