import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));

const run = (command, args, cwd, capture = false) => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status ?? result.signal} in ${cwd}`);
  }
  return result.stdout;
};

const dirs = [];

const buildClone = (label, head) => {
  const dir = mkdtempSync(join(tmpdir(), "foliospindle-proof-"));
  dirs.push(dir);
  console.log(`clone ${label}: ${dir}`);
  run("git", ["clone", "--quiet", "--no-checkout", repo, dir], repo);
  run("git", ["checkout", "--quiet", head], dir);
  run("npm", ["ci"], dir);
  run("npm", ["run", "build"], dir);
  return createHash("sha256").update(readFileSync(join(dir, "main.js"))).digest("hex");
};

try {
  const head = run("git", ["rev-parse", "HEAD"], repo, true).trim();
  const first = buildClone(1, head);
  const second = buildClone(2, head);
  console.log(`clone 1 main.js sha256 ${first}`);
  console.log(`clone 2 main.js sha256 ${second}`);
  if (first === second) {
    console.log(`reproducible: commit ${head} builds main.js ${first}`);
  } else {
    console.error(`not reproducible: commit ${head} built two different main.js files`);
    process.exitCode = 1;
  }
} catch (error) {
  console.error(String(error));
  process.exitCode = 1;
} finally {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
}
