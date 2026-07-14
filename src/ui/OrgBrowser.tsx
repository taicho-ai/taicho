/** Plan 22 — the Org browser. One docked mode, two scopes (teams / agents), built on the exact shape the
 *  artifact browser proved: ALL UI state lives in App's `orgState` (passed as `st` + `onChange`) so a
 *  pending approval card can unmount and remount it losslessly; keys arrive via a browser-OWNED `keyRef`
 *  (App dispatches pending card → operation view → artifact browser → ORG → chat, a fixed order).
 *
 *  Surfaces:
 *   - SHELF: the list + a live preview, scope tabs, single-key verbs.
 *   - DETAIL (⏎): the whole team/agent on one screen; `o` opens its file in $EDITOR.
 *   - WIZARD (`a`): Team Add (id → charter → members → lead) or Hire Agent (id → role → identity → teams).
 *   - PICKER (`m`/`t`): a checkbox multi-select to (re)staff a team or (re)team an agent.
 *   - CONFIRM (`d`): a guarded delete.
 *  Mutations are App-provided async actions (they own the store wiring + roster refresh); the component
 *  drives them and shows the result on a transient `note` line. */
import { useEffect } from "react";
import { Box, Text } from "ink";
import { spawn } from "node:child_process";
import type { CardKeyHandler } from "./ProposalCard";
import { paths } from "../store/files";
import { teamRows, agentRows, isProtectedAgent, isProtectedTeam, clampSel, type OrgScope } from "./org-browser-model";

type WizardState =
  | { kind: "team"; step: 1 | 2 | 3; field: "id" | "charter"; id: string; charter: string; selected: string[]; cursor: number; lead: string | null; leadCursor: number }
  | { kind: "agent"; step: 1 | 2; field: "id" | "role" | "identity"; id: string; role: string; identity: string; selected: string[]; cursor: number };
type PickerState = { kind: "team-members" | "agent-teams"; targetId: string; options: string[]; selected: string[]; cursor: number };
type ConfirmState = { kind: "delete-team" | "delete-agent"; id: string };

export interface OrgUiState {
  scope: OrgScope;
  sel: number;
  reading: boolean;
  wizard: WizardState | null;
  picker: PickerState | null;
  confirm: ConfirmState | null;
  note?: string;
}

export function initialOrgUi(scope: OrgScope = "teams"): OrgUiState {
  return { scope, sel: 0, reading: false, wizard: null, picker: null, confirm: null };
}

export type OrgActionResult = { ok: boolean; error?: string };
export interface OrgActions {
  createTeam: (draft: { id: string; charter: string; lead?: string }, members: string[]) => Promise<OrgActionResult>;
  createAgent: (draft: { id: string; role: string; identity: string; teams: string[] }) => Promise<OrgActionResult>;
  deleteTeam: (id: string) => Promise<OrgActionResult>;
  deleteAgent: (id: string) => Promise<OrgActionResult>;
  setTeamMembers: (teamId: string, members: string[]) => Promise<OrgActionResult>;
  setAgentTeams: (agentId: string, teams: string[]) => Promise<OrgActionResult>;
}

const ID_RE = /^[a-z][a-z0-9-]*$/;

export function OrgBrowser(props: {
  ws: string;
  db: import("bun:sqlite").Database;
  width: number;
  rows: number;
  bump?: number;
  st: OrgUiState;
  onChange: (next: OrgUiState | ((prev: OrgUiState) => OrgUiState)) => void;
  keyRef: React.MutableRefObject<CardKeyHandler | null>;
  onClose: () => void;
  actions: OrgActions;
}) {
  const { ws, db, st, onChange } = props;

  const teams = teamRows(ws, db);
  const agents = agentRows(db);
  const teamIds = teams.map((t) => t.id).filter((id) => !isProtectedTeam(id)); // wizards/pickers offer non-default teams
  const agentIds = agents.map((a) => a.id);

  const list = st.scope === "teams" ? teams : agents;
  const sel = clampSel(st.sel, list.length);
  const selTeam = st.scope === "teams" ? teams[sel] : undefined;
  const selAgent = st.scope === "agents" ? agents[sel] : undefined;

  const setNote = (note: string) => onChange((prev) => ({ ...prev, note }));
  const run = (p: Promise<OrgActionResult>, ok: string) =>
    void p.then((r) => onChange((prev) => ({ ...prev, note: r.ok ? ok : `⚠ ${r.error ?? "failed"}`, confirm: null, wizard: null, picker: null })));

  const openInEditor = (path: string) => {
    const editor = process.env.EDITOR || process.env.VISUAL;
    if (!editor) { setNote(`no $EDITOR — file: ${path}`); return; }
    const child = spawn(editor, [path], { detached: true, stdio: "ignore" });
    child.on("error", (e) => setNote(`$EDITOR failed (${e.message}) — file: ${path}`));
    child.unref();
    setNote(`↗ sent to $EDITOR (${editor}) — file: ${path}`);
  };

  // ── keyboard ──────────────────────────────────────────────────────────────────────────────────
  const handler: CardKeyHandler = (input, key) => {
    // WIZARD owns the keyboard while open.
    if (st.wizard) return handleWizard(input, key, st.wizard);
    // PICKER (checkbox multi-select).
    if (st.picker) return handlePicker(input, key, st.picker);
    // CONFIRM delete.
    if (st.confirm) {
      if (input === "y") {
        const c = st.confirm;
        if (c.kind === "delete-team") run(props.actions.deleteTeam(c.id), `✓ deleted team ${c.id}`);
        else run(props.actions.deleteAgent(c.id), `✓ retired ${c.id}`);
      } else if (key.escape || input === "n") onChange({ ...st, confirm: null });
      return;
    }
    // DETAIL.
    if (st.reading) {
      if (key.escape) { onChange({ ...st, reading: false }); return; }
      if (input === "o") {
        if (selTeam) openInEditor(paths.teamFile(ws, selTeam.id));
        else if (selAgent) openInEditor(paths.agentFile(ws, selAgent.id));
        return;
      }
      if (input === "m" && selTeam && !isProtectedTeam(selTeam.id)) return openMembers(selTeam.id, selTeam.members);
      if (input === "t" && selAgent) return openAgentTeams(selAgent.id, selAgent.teams);
      return;
    }
    // SHELF.
    if (key.escape) { props.onClose(); return; }
    if (key.tab || input === "1" || input === "2") {
      const scope: OrgScope = input === "1" ? "teams" : input === "2" ? "agents" : st.scope === "teams" ? "agents" : "teams";
      onChange({ ...st, scope, sel: 0, note: undefined });
      return;
    }
    if (key.upArrow) { onChange({ ...st, sel: clampSel(sel - 1, list.length) }); return; }
    if (key.downArrow) { onChange({ ...st, sel: clampSel(sel + 1, list.length) }); return; }
    if (key.return) { if (list.length) onChange({ ...st, reading: true, note: undefined }); return; }
    if (input === "a") { onChange({ ...st, wizard: freshWizard(st.scope), note: undefined }); return; }
    if (input === "o") { if (selTeam) openInEditor(paths.teamFile(ws, selTeam.id)); else if (selAgent) openInEditor(paths.agentFile(ws, selAgent.id)); return; }
    if (input === "m" && selTeam && !isProtectedTeam(selTeam.id)) return openMembers(selTeam.id, selTeam.members);
    if (input === "t" && selAgent) return openAgentTeams(selAgent.id, selAgent.teams);
    if (input === "d") {
      if (selTeam && !isProtectedTeam(selTeam.id)) onChange({ ...st, confirm: { kind: "delete-team", id: selTeam.id } });
      else if (selAgent && !isProtectedAgent(selAgent.id)) onChange({ ...st, confirm: { kind: "delete-agent", id: selAgent.id } });
      else setNote(selTeam ? "the default team can't be deleted" : "root and the librarian can't be retired");
      return;
    }
  };

  function freshWizard(scope: OrgScope): WizardState {
    return scope === "teams"
      ? { kind: "team", step: 1, field: "id", id: "", charter: "", selected: [], cursor: 0, lead: null, leadCursor: 0 }
      : { kind: "agent", step: 1, field: "id", id: "", role: "", identity: "", selected: [], cursor: 0 };
  }
  function openMembers(teamId: string, current: string[]) {
    onChange({ ...st, picker: { kind: "team-members", targetId: teamId, options: agentIds, selected: current.filter((m) => agentIds.includes(m)), cursor: 0 } });
  }
  function openAgentTeams(agentId: string, current: string[]) {
    onChange({ ...st, picker: { kind: "agent-teams", targetId: agentId, options: teamIds, selected: current.filter((t) => teamIds.includes(t)), cursor: 0 } });
  }

  function handlePicker(input: string, key: { escape?: boolean; upArrow?: boolean; downArrow?: boolean; return?: boolean }, p: PickerState) {
    if (key.escape) { onChange({ ...st, picker: null }); return; }
    if (key.upArrow) { onChange({ ...st, picker: { ...p, cursor: clampSel(p.cursor - 1, p.options.length) } }); return; }
    if (key.downArrow) { onChange({ ...st, picker: { ...p, cursor: clampSel(p.cursor + 1, p.options.length) } }); return; }
    if (input === " ") {
      const opt = p.options[p.cursor];
      if (!opt) return;
      const selected = p.selected.includes(opt) ? p.selected.filter((x) => x !== opt) : [...p.selected, opt];
      onChange({ ...st, picker: { ...p, selected } });
      return;
    }
    if (key.return) {
      if (p.kind === "team-members") run(props.actions.setTeamMembers(p.targetId, p.selected), `✓ ${p.targetId}: ${p.selected.length} member(s)`);
      else run(props.actions.setAgentTeams(p.targetId, p.selected), `✓ ${p.targetId}: ${p.selected.length} team(s)`);
      return;
    }
  }

  function handleWizard(input: string, key: { escape?: boolean; return?: boolean; backspace?: boolean; delete?: boolean; upArrow?: boolean; downArrow?: boolean; tab?: boolean; ctrl?: boolean; meta?: boolean }, w: WizardState) {
    const cancel = () => onChange({ ...st, wizard: null });
    const type = (cur: string) => {
      if (key.backspace || key.delete) return cur.slice(0, -1);
      if (input && !key.ctrl && !key.meta && !key.tab && !key.upArrow && !key.downArrow && !key.return) return cur + input;
      return cur;
    };
    if (w.kind === "team") {
      // step 1: identity (id → charter)
      if (w.step === 1) {
        if (key.escape) return cancel();
        if (key.return || key.tab) {
          if (w.field === "id") { onChange({ ...st, wizard: { ...w, field: "charter" } }); return; }
          if (!ID_RE.test(w.id)) { setNote("id must be lowercase letters/digits/-, starting with a letter"); return; }
          onChange({ ...st, wizard: { ...w, step: 2, cursor: 0 } });
          return;
        }
        onChange({ ...st, wizard: { ...w, [w.field]: type(w.field === "id" ? w.id : w.charter) } as WizardState });
        return;
      }
      // step 2: members (checkbox over agents)
      if (w.step === 2) {
        if (key.escape) { onChange({ ...st, wizard: { ...w, step: 1, field: "charter" } }); return; }
        if (key.upArrow) { onChange({ ...st, wizard: { ...w, cursor: clampSel(w.cursor - 1, agentIds.length) } }); return; }
        if (key.downArrow) { onChange({ ...st, wizard: { ...w, cursor: clampSel(w.cursor + 1, agentIds.length) } }); return; }
        if (input === " ") {
          const a = agentIds[w.cursor];
          if (a) onChange({ ...st, wizard: { ...w, selected: w.selected.includes(a) ? w.selected.filter((x) => x !== a) : [...w.selected, a] } });
          return;
        }
        if (input === "a") { onChange({ ...st, wizard: { ...w, selected: [...agentIds] } }); return; }
        if (input === "n") { onChange({ ...st, wizard: { ...w, selected: [] } }); return; }
        if (key.return) { onChange({ ...st, wizard: { ...w, step: 3, leadCursor: 0 } }); return; }
        return;
      }
      // step 3: lead (leadless + each selected member)
      const leadChoices = [null, ...w.selected];
      if (key.escape) { onChange({ ...st, wizard: { ...w, step: 2 } }); return; }
      if (key.upArrow) { onChange({ ...st, wizard: { ...w, leadCursor: clampSel(w.leadCursor - 1, leadChoices.length) } }); return; }
      if (key.downArrow) { onChange({ ...st, wizard: { ...w, leadCursor: clampSel(w.leadCursor + 1, leadChoices.length) } }); return; }
      if (key.return) {
        const lead = leadChoices[clampSel(w.leadCursor, leadChoices.length)] ?? undefined;
        run(props.actions.createTeam({ id: w.id, charter: w.charter || w.id, lead: lead ?? undefined }, w.selected), `✓ created team ${w.id}`);
        return;
      }
      return;
    }
    // AGENT wizard
    if (w.step === 1) {
      if (key.escape) return cancel();
      const order: ("id" | "role" | "identity")[] = ["id", "role", "identity"];
      if (key.return || key.tab) {
        const i = order.indexOf(w.field);
        if (i < order.length - 1) { onChange({ ...st, wizard: { ...w, field: order[i + 1]! } }); return; }
        if (!ID_RE.test(w.id)) { setNote("id must be lowercase letters/digits/-, starting with a letter"); return; }
        if (!w.role.trim() || !w.identity.trim()) { setNote("role and identity are required"); return; }
        onChange({ ...st, wizard: { ...w, step: 2, cursor: 0 } });
        return;
      }
      onChange({ ...st, wizard: { ...w, [w.field]: type(w[w.field]) } as WizardState });
      return;
    }
    // step 2: teams (checkbox over non-default teams)
    if (key.escape) { onChange({ ...st, wizard: { ...w, step: 1, field: "identity" } }); return; }
    if (key.upArrow) { onChange({ ...st, wizard: { ...w, cursor: clampSel(w.cursor - 1, teamIds.length) } }); return; }
    if (key.downArrow) { onChange({ ...st, wizard: { ...w, cursor: clampSel(w.cursor + 1, teamIds.length) } }); return; }
    if (input === " ") {
      const t = teamIds[w.cursor];
      if (t) onChange({ ...st, wizard: { ...w, selected: w.selected.includes(t) ? w.selected.filter((x) => x !== t) : [...w.selected, t] } });
      return;
    }
    if (key.return) { run(props.actions.createAgent({ id: w.id, role: w.role, identity: w.identity, teams: w.selected }), `✓ hired ${w.id}`); return; }
  }

  // Publish the handler DURING render (the ink registration race the artifact browser/ProposalCard fixed).
  props.keyRef.current = handler;
  useEffect(() => () => { props.keyRef.current = null; }, []);

  // ── render ──────────────────────────────────────────────────────────────────────────────────────
  if (st.wizard) return <Wizard w={st.wizard} agentIds={agentIds} teamIds={teamIds} width={props.width} note={st.note} />;
  if (st.picker) return <Picker p={st.picker} width={props.width} note={st.note} />;

  const border = (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} width={props.width} marginTop={1}>
      <Box>
        <Text color="cyan" bold>ORG </Text>
        <Text color={st.scope === "teams" ? "cyan" : "gray"} bold={st.scope === "teams"} inverse={st.scope === "teams"}>{" 1 teams "}</Text>
        <Text> </Text>
        <Text color={st.scope === "agents" ? "cyan" : "gray"} bold={st.scope === "agents"} inverse={st.scope === "agents"}>{" 2 agents "}</Text>
        <Text dimColor>   {st.scope === "teams" ? `${teams.length} team${teams.length === 1 ? "" : "s"}` : `${agents.length} agent${agents.length === 1 ? "" : "s"}`}</Text>
      </Box>
      {st.confirm && (
        <Text color="yellow">
          {st.confirm.kind === "delete-team" ? `delete team ${st.confirm.id}? it detaches every member` : `retire ${st.confirm.id}? this removes the agent`} — y / n
        </Text>
      )}
      {st.note && <Text color={st.note.startsWith("⚠") ? "red" : "green"}>{st.note}</Text>}
      <Text> </Text>
      {st.reading ? renderDetail() : renderShelf()}
      <Text> </Text>
      <Text dimColor>{footer()}</Text>
    </Box>
  );
  return border;

  function footer(): string {
    if (st.reading) return "esc back · o $EDITOR" + (st.scope === "teams" ? " · m members" : " · t teams");
    const common = "↑↓ move · ⏎ open · tab/1·2 scope · a add · d delete · o $EDITOR · esc chat";
    return st.scope === "teams" ? "↑↓ · ⏎ open · tab scope · a add team · m members · d delete · o edit · esc" : "↑↓ · ⏎ open · tab scope · a hire · t teams · d retire · o edit · esc";
  }

  function renderShelf() {
    if (!list.length) return <Text dimColor>  (nothing here yet — press `a` to add)</Text>;
    return (
      <Box>
        <Box flexDirection="column" width={Math.floor(props.width * 0.5)}>
          {list.map((row, i) => {
            const on = i === sel;
            if (st.scope === "teams") {
              const t = row as (typeof teams)[number];
              return <Text key={t.id} color={on ? "cyan" : undefined} bold={on}>{on ? "▸ " : "  "}{t.id}  <Text dimColor>{t.members.length} · {t.lead ? `lead ${t.lead}` : "by capability"}</Text></Text>;
            }
            const a = row as (typeof agents)[number];
            return <Text key={a.id} color={on ? "cyan" : undefined} bold={on}>{on ? "▸ " : "  "}{a.isRoot ? "*" : " "}{a.id}  <Text dimColor>{a.teams.length ? a.teams.join(" · ") : "—"}</Text></Text>;
          })}
        </Box>
        <Box flexDirection="column" marginLeft={2} flexGrow={1}>{renderPreview()}</Box>
      </Box>
    );
  }

  function renderPreview() {
    if (selTeam) return [
      <Text key="c" color="cyan">{selTeam.id}</Text>,
      <Text key="ch" wrap="truncate">{selTeam.charter}</Text>,
      <Text key="l" dimColor>{selTeam.lead ? `lead: ${selTeam.lead}` : "routed by capability"}</Text>,
      <Text key="m" dimColor wrap="truncate">members: {selTeam.members.join(", ") || "(none)"}</Text>,
    ];
    if (selAgent) return [
      <Text key="c" color="cyan">{selAgent.id}{selAgent.isRoot ? " *" : ""}</Text>,
      <Text key="r" wrap="truncate">{selAgent.role}</Text>,
      <Text key="t" dimColor wrap="truncate">teams: {selAgent.teams.length ? selAgent.teams.join(", ") : "default only"}</Text>,
    ];
    return [<Text key="e" dimColor>—</Text>];
  }

  function renderDetail() {
    if (selTeam) {
      const t = selTeam;
      return (
        <Box flexDirection="column">
          <Text color="cyan" bold>{t.id} · {t.charter}</Text>
          <Text> </Text>
          <Text color="cyan">ROUTING</Text>
          <Text>  {t.lead ? `lead: ${t.lead}` : "leadless — routed to the best-ranked member"}</Text>
          <Text> </Text>
          <Text color="cyan">MEMBERS ({t.members.length})</Text>
          {t.members.length ? t.members.map((m) => <Text key={m}>  {m === t.lead ? "* " : "- "}{m}</Text>) : <Text dimColor>  (none — press m to staff)</Text>}
        </Box>
      );
    }
    if (selAgent) {
      const a = selAgent;
      return (
        <Box flexDirection="column">
          <Text color="cyan" bold>{a.id} · {a.role}</Text>
          <Text> </Text>
          <Text color="cyan">TEAMS</Text>
          <Text>  {a.teams.length ? ["default", ...a.teams].join(" · ") : "default (only)"}</Text>
          <Text> </Text>
          <Text dimColor>open the agent.md in $EDITOR (o) to edit its persona, tools, and budgets</Text>
        </Box>
      );
    }
    return <Text dimColor>—</Text>;
  }
}

// ── wizard + picker sub-views (pure presentational) ─────────────────────────────────────────────────

function Wizard(props: { w: WizardState; agentIds: string[]; teamIds: string[]; width: number; note?: string }) {
  const { w } = props;
  const cursorMark = <Text color="cyan">▏</Text>;
  if (w.kind === "team") {
    if (w.step === 1)
      return (
        <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} width={props.width} marginTop={1}>
          <Text color="cyan" bold>NEW TEAM · step 1/3 — identity</Text>
          <Text> </Text>
          <Text><Text dimColor>id       </Text>{w.field === "id" ? <>{w.id}{cursorMark}</> : w.id || <Text dimColor>—</Text>}</Text>
          <Text><Text dimColor>charter  </Text>{w.field === "charter" ? <>{w.charter}{cursorMark}</> : w.charter || <Text dimColor>—</Text>}</Text>
          {props.note && <Text color="red">{props.note}</Text>}
          <Text> </Text>
          <Text dimColor>type · ⏎/tab next field · ⏎ on charter → members · esc cancel</Text>
        </Box>
      );
    if (w.step === 2)
      return (
        <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} width={props.width} marginTop={1}>
          <Text color="cyan" bold>NEW TEAM · step 2/3 — members (space toggles)</Text>
          <Text> </Text>
          {props.agentIds.length ? props.agentIds.map((a, i) => (
            <Text key={a} color={i === w.cursor ? "cyan" : undefined}>{i === w.cursor ? "▸ " : "  "}<Text color={w.selected.includes(a) ? "green" : undefined}>[{w.selected.includes(a) ? "x" : " "}]</Text> {a}</Text>
          )) : <Text dimColor>  (no agents yet — hire one first)</Text>}
          <Text> </Text>
          <Text dimColor>{w.selected.length} selected · space toggle · a all · n none · ⏎ next · esc back</Text>
        </Box>
      );
    const leadChoices = [null, ...w.selected];
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} width={props.width} marginTop={1}>
        <Text color="cyan" bold>NEW TEAM · step 3/3 — lead (optional)</Text>
        <Text> </Text>
        {leadChoices.map((c, i) => (
          <Text key={c ?? "__leadless"} color={i === w.leadCursor ? "cyan" : undefined}>{i === w.leadCursor ? "▸ " : "  "}{c === null ? <Text dimColor>leadless — routed by capability (default)</Text> : c}</Text>
        ))}
        <Text> </Text>
        <Text dimColor>writes teams/{w.id || "…"}/team.md + teams: on {w.selected.length} agent(s) · ↑↓ · ⏎ create · esc back</Text>
      </Box>
    );
  }
  // agent wizard
  if (w.step === 1)
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} width={props.width} marginTop={1}>
        <Text color="cyan" bold>HIRE AGENT · step 1/2 — identity</Text>
        <Text> </Text>
        <Text><Text dimColor>id        </Text>{w.field === "id" ? <>{w.id}{cursorMark}</> : w.id || <Text dimColor>—</Text>}</Text>
        <Text><Text dimColor>role      </Text>{w.field === "role" ? <>{w.role}{cursorMark}</> : w.role || <Text dimColor>—</Text>}</Text>
        <Text><Text dimColor>persona   </Text>{w.field === "identity" ? <>{w.identity}{cursorMark}</> : w.identity || <Text dimColor>—</Text>}</Text>
        {props.note && <Text color="red">{props.note}</Text>}
        <Text> </Text>
        <Text dimColor>type · ⏎/tab next field · ⏎ on persona → teams · esc cancel</Text>
      </Box>
    );
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} width={props.width} marginTop={1}>
      <Text color="cyan" bold>HIRE AGENT · step 2/2 — teams (space toggles; the artifact floor is always granted)</Text>
      <Text> </Text>
      {props.teamIds.length ? props.teamIds.map((t, i) => (
        <Text key={t} color={i === w.cursor ? "cyan" : undefined}>{i === w.cursor ? "▸ " : "  "}<Text color={w.selected.includes(t) ? "green" : undefined}>[{w.selected.includes(t) ? "x" : " "}]</Text> {t}</Text>
      )) : <Text dimColor>  (no teams yet — the agent will be default-only)</Text>}
      <Text> </Text>
      <Text dimColor>{w.selected.length} selected · space toggle · ⏎ hire · esc back</Text>
    </Box>
  );
}

function Picker(props: { p: PickerState; width: number; note?: string }) {
  const { p } = props;
  const title = p.kind === "team-members" ? `MEMBERS of ${p.targetId}` : `TEAMS for ${p.targetId}`;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} width={props.width} marginTop={1}>
      <Text color="cyan" bold>{title} (space toggles)</Text>
      <Text> </Text>
      {p.options.length ? p.options.map((o, i) => (
        <Text key={o} color={i === p.cursor ? "cyan" : undefined}>{i === p.cursor ? "▸ " : "  "}<Text color={p.selected.includes(o) ? "green" : undefined}>[{p.selected.includes(o) ? "x" : " "}]</Text> {o}</Text>
      )) : <Text dimColor>  (nothing to choose)</Text>}
      <Text> </Text>
      <Text dimColor>{p.selected.length} selected · space toggle · ↑↓ move · ⏎ save · esc cancel</Text>
    </Box>
  );
}
