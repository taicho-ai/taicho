// Ink's reconciler dynamically imports ./devtools.js, which statically imports
// react-devtools-core. Bun's --compile inlines the dynamic import eagerly, so the
// optional package must resolve. Stub it with no-ops (we never run with DEV=true).
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
const dir = "node_modules/react-devtools-core";
if (!existsSync(dir + "/package.json")) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(dir + "/package.json", JSON.stringify({ name: "react-devtools-core", version: "0.0.0-stub", main: "index.js" }));
  writeFileSync(dir + "/index.js", "module.exports = { initialize(){}, connectToDevTools(){} };\n");
  console.log("stubbed react-devtools-core");
}
