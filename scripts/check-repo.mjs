import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const findings = [];

const report = (finding) => {
  findings.push(finding);
};

const expectEqual = (file, field, actual, expected) => {
  if (actual !== expected) {
    report(`${file}: ${field} is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  }
};

const readLines = (file) => readFileSync(join(root, file), "utf8").split(/\r?\n/).map((line) => line.trim());

const readJson = (file) => {
  if (!existsSync(join(root, file))) {
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(join(root, file), "utf8"));
  } catch (error) {
    report(`${file}: ${error.message}`);
    return undefined;
  }
};

const requiredFiles = [
  "LICENSE",
  "README.md",
  "THIRD_PARTY_NOTICES.md",
  "manifest.json",
  "versions.json",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "esbuild.config.mjs",
  "eslint.config.mts",
  "fixtures/SHA256SUMS",
  ".gitignore",
];
const requiredDirectories = ["src", "tests", "fixtures", "measurements", ".github/workflows"];
const gitignoreEntries = ["node_modules/", "main.js", "data.json", ".obsidian/", ".env", "*.secret"];
const versionForm = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const exactVersion = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const excludedPackage = /qr|clipboard/i;
const categories = [
  ["source", /^src\/.+\.ts$/],
  ["tests", /^tests\/.+\.ts$/],
  ["fixtures", /^fixtures\/([^/]+\.(md|bin)|SHA256SUMS)$/],
  ["measurements", /^measurements\/([^/]+\.json|README\.md)$/],
  ["documentation", /^README\.md$/],
  ["build and lint configuration", /^(package\.json|package-lock\.json|tsconfig\.json|esbuild\.config\.mjs|version-bump\.mjs|eslint\.config\.mts|\.gitignore)$/],
  ["CI configuration", /^(\.github\/workflows\/[^/]+\.ya?ml|scripts\/[^/]+\.(mjs|txt)|dependency-allowlist\.txt)$/],
  ["license and notices", /^(LICENSE|THIRD_PARTY_NOTICES\.md)$/],
  ["plugin manifest and versions", /^(manifest\.json|versions\.json)$/],
];

for (const file of requiredFiles) {
  const full = join(root, file);
  if (!existsSync(full) || !statSync(full).isFile()) {
    report(`${file}: missing`);
  }
}
for (const directory of requiredDirectories) {
  const full = join(root, directory);
  if (!existsSync(full) || !statSync(full).isDirectory()) {
    report(`${directory}/: missing`);
  }
}

const manifest = readJson("manifest.json");
if (manifest !== undefined) {
  expectEqual("manifest.json", "id", manifest.id, "foliospindle-proof");
  expectEqual("manifest.json", "isDesktopOnly", manifest.isDesktopOnly, false);
  expectEqual("manifest.json", "author", manifest.author, "Ojus Chugh");
  if (typeof manifest.name !== "string") {
    report(`manifest.json: name is ${JSON.stringify(manifest.name)}, expected a string`);
  } else {
    for (const word of ["sia", "obsidian"]) {
      if (manifest.name.toLowerCase().includes(word)) {
        report(`manifest.json: name ${JSON.stringify(manifest.name)} contains ${JSON.stringify(word)}`);
      }
    }
  }
  if (typeof manifest.version !== "string" || !versionForm.test(manifest.version)) {
    report(`manifest.json: version is ${JSON.stringify(manifest.version)}, expected MAJOR.MINOR.PATCH`);
  }
  expectEqual("manifest.json", "minAppVersion", manifest.minAppVersion, "1.11.4");
}

const versions = readJson("versions.json");
if (versions !== undefined) {
  if (typeof versions !== "object" || versions === null || Array.isArray(versions)) {
    report("versions.json: expected an object mapping plugin versions to minimum app versions");
  } else if (manifest !== undefined && typeof manifest.version === "string") {
    expectEqual("versions.json", `entry ${JSON.stringify(manifest.version)}`, versions[manifest.version], manifest.minAppVersion);
  }
}

if (existsSync(join(root, ".gitignore"))) {
  const lines = readLines(".gitignore");
  for (const entry of gitignoreEntries) {
    if (!lines.includes(entry)) {
      report(`.gitignore: missing entry ${entry}`);
    }
  }
}

const allowlist = existsSync(join(root, "dependency-allowlist.txt")) ? readLines("dependency-allowlist.txt").filter((line) => line.length > 0) : undefined;
if (allowlist === undefined) {
  report("dependency-allowlist.txt: missing");
} else {
  for (const name of allowlist) {
    if (excludedPackage.test(name)) {
      report(`dependency-allowlist.txt: ${name} is a QR or clipboard package`);
    }
  }
}

const pkg = readJson("package.json");
if (pkg !== undefined) {
  for (const section of ["dependencies", "devDependencies"]) {
    for (const [name, version] of Object.entries(pkg[section] ?? {})) {
      if (typeof version !== "string" || !exactVersion.test(version)) {
        report(`package.json: ${section}.${name} is ${JSON.stringify(version)}, expected an exact version`);
      }
      if (allowlist !== undefined && !allowlist.includes(name)) {
        report(`package.json: ${section}.${name} is not in dependency-allowlist.txt`);
      }
      if (excludedPackage.test(name)) {
        report(`package.json: ${section}.${name} is a QR or clipboard package`);
      }
    }
  }
}

const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter((path) => path.length > 0);
for (const path of tracked) {
  if (!categories.some(([, pattern]) => pattern.test(path))) {
    report(`${path}: outside every tracked file category`);
  }
}

for (const finding of findings) {
  console.error(finding);
}
if (findings.length > 0) {
  process.exitCode = 1;
}
