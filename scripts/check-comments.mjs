import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const findings = [];

const collectFiles = (directory, prefix) => {
  const files = [];
  for (const name of readdirSync(directory).sort()) {
    const full = join(directory, name);
    const path = `${prefix}${name}`;
    if (statSync(full).isDirectory()) {
      files.push(...collectFiles(full, `${path}/`));
    } else if (name.endsWith(".ts")) {
      files.push({ path, text: readFileSync(full, "utf8") });
    }
  }
  return files;
};

const isToken = (node) => node.kind <= ts.SyntaxKind.LastToken;
const isJSDoc = (node) => node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode;

const commentPositions = (sourceFile) => {
  const positions = new Set();
  const record = (pos) => {
    positions.add(pos);
  };
  const visit = (node) => {
    if (isJSDoc(node)) {
      return;
    }
    if (isToken(node)) {
      ts.forEachLeadingCommentRange(sourceFile.text, node.getFullStart(), record);
      ts.forEachTrailingCommentRange(sourceFile.text, node.getEnd(), record);
      return;
    }
    for (const child of node.getChildren(sourceFile)) {
      visit(child);
    }
  };
  visit(sourceFile);
  return [...positions].sort((a, b) => a - b);
};

const targets = process.argv.length > 2
  ? [[resolve(process.argv[2]), `${process.argv[2].replace(/\/+$/, "")}/`]]
  : [[join(root, "src"), "src/"], [join(root, "tests"), "tests/"]];

for (const [directory, prefix] of targets) {
  for (const { path, text } of collectFiles(directory, prefix)) {
    const sourceFile = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    for (const pos of commentPositions(sourceFile)) {
      findings.push(`${path}:${sourceFile.getLineAndCharacterOfPosition(pos).line + 1}`);
    }
  }
}

for (const finding of findings) {
  console.error(finding);
}
if (findings.length > 0) {
  process.exitCode = 1;
}
