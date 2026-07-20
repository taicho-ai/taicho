// Stamp every workspace package to one lockstep version.
// Cross-deps stay `workspace:*` in-repo; `bun pm pack` rewrites them to the
// stamped version at pack time. Used by .github/workflows/publish.yml.
import { readdirSync } from "node:fs";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version ?? "")) {
  console.error("usage: bun scripts/set-packages-version.ts <semver>");
  process.exit(1);
}

for (const dir of readdirSync("packages")) {
  const path = `packages/${dir}/package.json`;
  const pkg = await Bun.file(path).json();
  pkg.version = version;
  await Bun.write(path, JSON.stringify(pkg, null, 2) + "\n");
  console.log(`${pkg.name}@${version}`);
}
