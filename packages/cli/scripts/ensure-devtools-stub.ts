// Bun eagerly resolves Ink's optional devtools import while bundling. The CLI never enables it,
// but a resolvable no-op module keeps standalone package builds deterministic.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const packageRoot = resolve(import.meta.dir, "..");
const candidates = [packageRoot, resolve(packageRoot, "../..")];
for (const root of candidates) {
  // The second candidate is the workspace root when developed in the monorepo. In a standalone
  // checkout it is ignored, so this helper does not write outside that repository.
  if (root !== packageRoot && !existsSync(join(root, "package.json"))) continue;
  const dir = join(root, "node_modules", "react-devtools-core");
  if (existsSync(join(dir, "package.json"))) continue;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: "react-devtools-core", version: "0.0.0-stub", main: "index.js",
  }));
  writeFileSync(join(dir, "index.js"), "module.exports = { initialize(){}, connectToDevTools(){} };\n");
}
