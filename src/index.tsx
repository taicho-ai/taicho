#!/usr/bin/env bun
import { render } from "ink";
import { App } from "./ui/App";
import { ensureWorkspace } from "./store/files";
import { openDb } from "./store/db";
import { seedRoot, reindex, loadIndex } from "./store/roster";
import { resolveConfig, isMissing, loadConfig } from "./store/config";
import { buildModel, createModelResolver } from "./core/model";
import { pricerFor } from "./core/pricing";

const ws = process.cwd();
const config = await loadConfig(ws);
await ensureWorkspace(ws);
await seedRoot(ws, config.defaults);
const db = openDb(ws);
if (loadIndex(db).length === 0) await reindex(ws, db);

const cfg = resolveConfig();
const model = isMissing(cfg) ? null : buildModel(cfg);
// resolveModel is gated on global key presence (cfg); a per-agent provider whose key is absent
// still surfaces at call time as a failed run, not a boot error.
const resolveModel = isMissing(cfg) ? undefined : createModelResolver({ config, fallback: cfg }).resolveModel;
const roster = loadIndex(db);

render(
  <App
    ws={ws} db={db} model={model} resolveModel={resolveModel}
    configDefaults={config.defaults} roster={roster}
    cfg={isMissing(cfg) ? null : cfg}
    priceUsd={isMissing(cfg) ? undefined : pricerFor(cfg.model)}
  />,
);
