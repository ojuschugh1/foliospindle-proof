import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const expectedAuthor = "Ojus Chugh <ojuschugh@gmail.com>";
const dash = /[\u2013\u2014]/;
const emoji = /\p{Extended_Pictographic}/u;
const findings = [];

const report = (hash, rule) => {
  findings.push(`${hash}: ${rule}`);
};

const log = execFileSync("git", ["log", "--no-merges", "--format=%H%x00%an <%ae>%x00%B%x00"], { cwd: root, encoding: "utf8" });
const records = log.split("\0\n").filter((record) => record.length > 0);

for (const record of records) {
  const [hash, author, body] = record.split("\0");
  const message = body.endsWith("\n") ? body.slice(0, -1) : body;
  const subject = message.split("\n")[0];
  if (message.length === 0) {
    report(hash, "message is empty");
  } else {
    if (message.includes("\n")) {
      report(hash, "message is not exactly one line");
    }
    if (!/^[A-Z]/.test(subject)) {
      report(hash, "subject does not start with A to Z");
    }
    if ([...subject].length > 72) {
      report(hash, "subject exceeds 72 characters");
    }
    if (subject.endsWith(".")) {
      report(hash, "subject ends with a period");
    }
    if (dash.test(message)) {
      report(hash, "message contains an en dash or em dash");
    }
    if (emoji.test(message)) {
      report(hash, "message contains an emoji");
    }
  }
  if (author !== expectedAuthor) {
    report(hash, `author is ${JSON.stringify(author)}, expected ${JSON.stringify(expectedAuthor)}`);
  }
}

for (const finding of findings) {
  console.error(finding);
}
if (findings.length > 0) {
  process.exitCode = 1;
}
