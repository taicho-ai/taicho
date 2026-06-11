#!/usr/bin/env bun
import { render } from "ink";
import { App } from "./ui/App";
import { ensureWorkspace } from "./store/files";
import { openDb } from "./store/db";
import { seedRoot, reindex, loadIndex } from "./store/roster";
import { resolveConfig, isMissing } from "./store/config";
import { buildModel } from "./core/model";
import { pricerFor } from "./core/pricing";

const ws = process.cwd();
await ensureWorkspace(ws);
await seedRoot(ws);
const db = openDb(ws);
if (loadIndex(db).length === 0) await reindex(ws, db);

const cfg = resolveConfig();
const model = isMissing(cfg) ? null : buildModel(cfg);
const roster = loadIndex(db);

render(<App ws={ws} db={db} model={model} roster={roster} cfg={isMissing(cfg) ? null : cfg} priceUsd={isMissing(cfg) ? undefined : pricerFor(cfg.model)} />);
