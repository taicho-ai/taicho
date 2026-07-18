import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const root = resolve(import.meta.dir, "..");
const packagesDir = join(root, "packages");

const allowedTaicho: Record<string, Set<string>> = {
  contracts: new Set(),
  telemetry: new Set(),
  agent: new Set(["contracts", "telemetry"]),
  graph: new Set(["contracts"]),
  framework: new Set(["agent", "contracts", "graph", "telemetry"]),
  cli: new Set(["agent", "contracts", "framework", "graph", "telemetry"]),
};

const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? files(path) : /\.(?:ts|tsx)$/.test(name) ? [path] : [];
});

const errors: string[] = [];
for (const [pkg, allowed] of Object.entries(allowedTaicho)) {
  const packageRoot = join(packagesDir, pkg);
  const sourceRoot = join(packageRoot, "src");
  for (const file of files(sourceRoot)) {
    const text = readFileSync(file, "utf8");
    const specs = [...text.matchAll(/(?:from\s+|import\s*\()["']([^"']+)["']/g)].map((m) => m[1]!);
    for (const spec of specs) {
      if (spec.startsWith(".")) {
        const target = resolve(dirname(file), spec);
        if (target !== packageRoot && !target.startsWith(packageRoot + sep))
          errors.push(`${relative(root, file)} escapes its package via ${spec}`);
        continue;
      }
      const match = /^@taicho\/([^/]+)/.exec(spec);
      if (match && !allowed.has(match[1]!))
        errors.push(`${relative(root, file)} may not depend on ${spec}`);
    }
  }
}

if (errors.length) {
  console.error("Package boundary violations:\n" + errors.map((e) => `- ${e}`).join("\n"));
  process.exit(1);
}
console.log("package boundaries: ok");
