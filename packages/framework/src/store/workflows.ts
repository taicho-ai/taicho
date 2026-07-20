/** Plan 23: a team's WORKFLOW — how work moves through it, and what each seat does. Optional, captain-
 *  authored, sits at teams/<id>/workflow.md next to team.md. It is CANON and STABLE: a file, not a
 *  model-generated plan, so the process is byte-identical on every invocation (the opposite of a Plan 18
 *  plan, which regenerates per goal). The lead INSTANTIATES it against the input; it never re-invents it.
 *
 *  The file is MEMBER-KEYED: markdown headings name the seats. A heading whose text is a member's agent
 *  id is that member's LANE ("when work reaches you, do this"); the reserved heading `orchestration` is
 *  the LEAD's slice (the sequence + hand-offs). At run time (run.ts) a member executing UNDER this team
 *  gets its lane injected as a context-tier section; the lead additionally gets the orchestration slice.
 *
 *  SPARSE + OPTIONAL by construction: no workflow.md → the team runs exactly as it did before Plan 23;
 *  a workflow.md with no section for a given member → that member just runs on the agentic brief (its
 *  identity + charter + task). Assigning someone to a team can therefore never break — a workflow only
 *  ADDS structure at the seats you have actually authored. */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { YAML } from "bun";
import { paths } from "./files";
import { loadWorkflowDefText, parseWorkflowDef, type WorkflowDef } from "@taicho-ai/graph";

/** The reserved seat name for the lead's orchestration slice. An agent literally named `orchestration`
 *  would collide with it — deliberately reserved, and documented, so the seat is unambiguous. */
export const ORCHESTRATION_KEY = "orchestration";

const FRONTMATTER = /^---\n[\s\S]*?\n---\n?([\s\S]*)$/;
// Seats are LEVEL-2 headings (`## <seat>`). A level-1 `# Title` is a document title (ignored), and
// deeper `### …` headings live INSIDE a lane as its content — so an author can structure a lane freely.
const HEADING = /^##\s+(.+?)\s*$/;

export interface TeamWorkflow {
  /** seat name (lowercased heading text: a member agent id, or `orchestration`) → that section's body. */
  sections: Map<string, string>;
}

/** Parse a workflow.md into its seat sections. Any YAML frontmatter is stripped (reserved for a future
 *  structured `steps:` form — the file stays forward-compatible). Content before the first heading is a
 *  preamble and is ignored; the format is heading-delimited. */
export function parseWorkflow(text: string): TeamWorkflow {
  const body = FRONTMATTER.test(text) ? (FRONTMATTER.exec(text)![1] ?? "") : text;
  const sections = new Map<string, string>();
  let key: string | null = null;
  let buf: string[] = [];
  const flush = () => { if (key !== null) sections.set(key, buf.join("\n").trim()); };
  for (const line of body.split("\n")) {
    const m = HEADING.exec(line);
    if (m) { flush(); key = m[1].toLowerCase().trim(); buf = []; }
    else if (key !== null) buf.push(line);
  }
  flush();
  return { sections };
}

export function loadWorkflow(ws: string, teamId: string): TeamWorkflow | null {
  const file = paths.teamWorkflowFile(ws, teamId);
  if (!existsSync(file)) return null;
  return parseWorkflow(readFileSync(file, "utf8"));
}

/** Plan 25: the STRUCTURED workflow definition (the `steps:` frontmatter) for a team, or null when the
 *  team has no workflow.md or the file is a Plan 23 prose-only workflow (no `steps:`). The team id is
 *  injected from the file location — one source of truth, like membership. */
export function loadWorkflowDef(ws: string, teamId: string): WorkflowDef | null {
  const file = paths.teamWorkflowFile(ws, teamId);
  if (!existsSync(file)) return null;
  return loadWorkflowDefText(readFileSync(file, "utf8"), teamId);
}

/** Plan 25: write the structured `steps:` frontmatter into a team's workflow.md. The ENGINE calls this
 *  (via ctx.proposeWorkflow) only after the captain approves a root proposal — the model never writes
 *  workflow canon directly (Plan 23's rule). Validates first (an invalid workflow is never written), and
 *  PRESERVES any existing prose lanes (the markdown body below the frontmatter). Version defaults to the
 *  next number after any existing structured version, or 1. */
export function writeWorkflowSteps(
  ws: string,
  teamId: string,
  input: { name: string; version?: number; brief?: string; steps: unknown[] },
): void {
  const version = input.version ?? ((loadWorkflowDef(ws, teamId)?.version ?? 0) + 1);
  // Validate BEFORE writing — a bad workflow must never reach canon.
  parseWorkflowDef({ id: input.name, team: teamId, version, brief: input.brief, steps: input.steps });

  const file = paths.teamWorkflowFile(ws, teamId);
  let body = "";
  if (existsSync(file)) {
    const text = readFileSync(file, "utf8");
    const m = /^---\n[\s\S]*?\n---\n?([\s\S]*)$/.exec(text);
    body = (m ? m[1]! : text).trim(); // keep the lanes (body after any frontmatter, or the whole prose file)
  }
  const fm: Record<string, unknown> = { workflow: input.name, version };
  if (input.brief) fm.brief = input.brief;
  fm.steps = input.steps;
  const yaml = YAML.stringify(fm, null, 2).trimEnd();

  mkdirSync(paths.teamDir(ws, teamId), { recursive: true });
  writeFileSync(file, `---\n${yaml}\n---\n${body ? `\n${body}\n` : "\n"}`);
}

/** The lane a specific agent plays in this workflow — its own seat section, or undefined if it has none. */
export function laneFor(wf: TeamWorkflow, agentId: string): string | undefined {
  const s = wf.sections.get(agentId.toLowerCase());
  return s ? s : undefined;
}

/** The orchestration slice — the lead's view of the sequence and hand-offs. Undefined if the file has none. */
export function orchestrationSlice(wf: TeamWorkflow): string | undefined {
  const s = wf.sections.get(ORCHESTRATION_KEY);
  return s ? s : undefined;
}

/** Does this team have a workflow file at all? Cheap existence check for the Org browser's status line. */
export function hasWorkflow(ws: string, teamId: string): boolean {
  return existsSync(paths.teamWorkflowFile(ws, teamId));
}

/** The seat names a workflow defines, in file order, with `orchestration` marked. For the Org browser's
 *  summary line and the read_workflow tool. */
export function seatsOf(wf: TeamWorkflow): string[] {
  return [...wf.sections.keys()];
}

/** Write (or overwrite) a team's workflow.md. Captain-owned — the Org browser and hand-edits call this;
 *  the model never does. Ensures a trailing newline so the file is well-formed. */
export function writeWorkflow(ws: string, teamId: string, text: string): void {
  mkdirSync(paths.teamDir(ws, teamId), { recursive: true });
  writeFileSync(paths.teamWorkflowFile(ws, teamId), text.endsWith("\n") ? text : text + "\n");
}

/** Scaffold a STARTER workflow.md for a team from its current members — a template the captain then
 *  hand-edits into a real process. Refuses to clobber an existing file. Returns the text written. The
 *  header comment explains the two section kinds so an editor knows the shape without leaving the file. */
export function scaffoldWorkflow(ws: string, teamId: string, members: string[]): string {
  if (hasWorkflow(ws, teamId)) throw new Error(`team "${teamId}" already has a workflow`);
  const lanes = (members.length ? members : ["example-member"])
    .map((m) => `## ${m}\nWhat ${m} does when work reaches it.\n`)
    .join("\n");
  const text =
    `# ${teamId} workflow\n\n` +
    `<!-- Each "## <agent-id>" heading below is that member's LANE — what it does when work reaches it. -->\n` +
    `<!-- "## orchestration" is the lead's view: the sequence and the hand-offs. -->\n` +
    `<!-- Delete a seat you don't want scripted; an unlisted member just runs on the agentic brief. -->\n\n` +
    `## orchestration\nDescribe the order work moves in, and who hands to whom.\n\n` +
    lanes;
  writeWorkflow(ws, teamId, text);
  return text;
}
