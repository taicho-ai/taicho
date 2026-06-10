#!/usr/bin/env bun
import { render } from "ink";
import { App } from "./ui/App";
import { ensureWorkspace } from "./store/files";
import { openDb } from "./store/db";

const workspace = process.cwd();
await ensureWorkspace(workspace);
openDb(workspace);

const hasApiKey = Boolean(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY);
// TODO: real roster load from agents/*/agent.md
const rosterEmpty = true;

render(<App hasApiKey={hasApiKey} rosterEmpty={rosterEmpty} />);
