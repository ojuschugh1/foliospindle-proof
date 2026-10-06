import process from "node:process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { findMatches } from "./boundary-lib.mjs";

const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));
const denylistFile = fileURLToPath(new URL("boundary-denylist.txt", import.meta.url));

const collectFiles = (directory, prefix) => {
  const files = [];
  for (const name of readdirSync(directory).sort()) {
    const full = join(directory, name);
    const path = `${prefix}${name}`;
    if (statSync(full).isDirectory()) {
      files.push(...collectFiles(full, `${path}/`));
    } else {
      files.push({ path, text: readFileSync(full, "utf8") });
    }
  }
  return files;
};

const literals = readFileSync(denylistFile, "utf8").split(/\r?\n/).filter((literal) => literal.length > 0);
const matches = findMatches(collectFiles(sourceRoot, "src/"), literals);
for (const { path, line, literal } of matches) {
  console.log(`${path}:${line}: ${literal}`);
}
if (matches.length > 0) {
  process.exit(1);
}
