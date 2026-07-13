/** Plan 21 — the artifact browser. Two surfaces, one component:
 *   - the SHELF, docked over the (still visible) chat scrollback: artifact list + live preview,
 *     scope control, filter chips, `/` search, mode line. Runs END here (App auto-docks on completed
 *     artifact-producing turns).
 *   - the READER, full-screen (captain-decided): markdown body + the VERBS — `a` annotate, `y`
 *     approve, `v` versions, `o` $EDITOR. The shelf's `g` (all-runs scope) previews GC with a dry
 *     run before archiving.
 *
 *  ALL UI state lives in App's `browserState` (passed as `st` + `onChange`) so a pending approval
 *  card can UNMOUNT the browser outright and remount it losslessly — spec §1's suspension rule.
 *  Keys arrive via `keyRef` (a browser-OWNED ref, never cardKeyRef): App's useInput dispatches
 *  pending card → operation view → browser → chat, so ownership is fixed order, not last-writer-wins. */
import { useEffect } from "react";
import { Box, Text } from "ink";
import { spawn } from "node:child_process";
import { type Artifact, artifactHandle } from "../schemas/artifact";
import { readArtifactBody, artifactBodyPath, artifactVersions, readArtifact, type GcReport } from "../store/artifacts";
import { listAnnotations, annotateArtifact } from "../store/annotations";
import { renderMarkdown } from "./markdown";
import type { CardKeyHandler } from "./ProposalCard";
import { MIN_PANE_COLS, MIN_PANE_ROWS } from "./SquadPanes";
import {
  type BrowserScope, type BrowserSort, type BrowserFilters, type ShelfRow,
  resolveScope, applyFilters, shelfRows, artifactRows, countLine, ageLabel,
} from "./browser-model";

export interface BrowserUiState {
  scope: BrowserScope;
  sort: BrowserSort;
  filters: BrowserFilters;
  sel: number;                  // indexes the ARTIFACT rows (headers are never selectable)
  reading: boolean;
  scroll: number;
  search: string | null;        // "/" live query; null = closed
  filterOpen: boolean;          // the `f` chip row
  filterField: number;          // which chip ←/→ is on
  feedback: string | null;      // the `a` inline input; null = closed
  versionsOpen: boolean;        // the `v` jump list
  versionSel: number;
  versionOverride: string | null; // reader shows this exact handle instead of the row's latest
  gcPreview: string[] | null;   // the `g` dry-run would-archive list awaiting confirm
  note?: string;                // transient verb result line (approved / opened / gc report)
  hint?: string;                // background-settle scope hint (Phase 2)
}

export function initialBrowserUi(): BrowserUiState {
  return {
    scope: "run", sort: "run", filters: {}, sel: 0, reading: false, scroll: 0,
    search: null, filterOpen: false, filterField: 0,
    feedback: null, versionsOpen: false, versionSel: 0, versionOverride: null, gcPreview: null,
  };
}

const SCOPES: { key: BrowserScope; label: string }[] = [
  { key: "run", label: "1 this run" },
  { key: "conversation", label: "2 conversation" },
  { key: "all", label: "3 all runs" },
];

const READER_LINES = 40;
const SHELF_LIST_LINES = 10;

/** The `f` chip row: each field cycles a small closed value set with ↑↓. producer/type values are
 *  derived from the artifacts IN SCOPE (plus "any"), so the chips never offer a dead value. */
const FILTER_FIELDS = ["producer", "type", "feedback", "verdict", "since"] as const;
type FilterField = (typeof FILTER_FIELDS)[number];
function fieldValues(field: FilterField, inScope: Artifact[]): (string | undefined)[] {
  if (field === "producer") return [undefined, ...new Set(inScope.map((a) => a.producer))];
  if (field === "type") return [undefined, ...new Set(inScope.map((a) => a.type))];
  if (field === "feedback") return [undefined, "open"];
  if (field === "verdict") return [undefined, "pass", "fail"];
  return [undefined, "24h", "7d", "30d"];  // since ("all" is the undefined chip)
}
function cycleFilter(f: BrowserFilters, field: FilterField, dir: 1 | -1, inScope: Artifact[]): BrowserFilters {
  const values = fieldValues(field, inScope);
  const cur = values.indexOf(f[field] as string | undefined);
  const next = values[(cur + dir + values.length) % values.length];
  return { ...f, [field]: next };
}

function badgeText(r: Extract<ShelfRow, { kind: "artifact" }>): { text: string; color?: string } | null {
  if (r.badges.openFeedback > 0) return { text: `⚑ ${r.badges.openFeedback} open`, color: "yellow" };
  if (r.badges.verdict === "fail") return { text: "✗ fail", color: "red" };
  if (r.badges.approved || r.badges.verdict === "pass") return { text: "✓", color: "green" };
  return null;
}

/** Open feedback the reader shows: actionable annotations only — approvals are state, not feedback. */
function openFeedback(ws: string, handle: string) {
  return listAnnotations(ws, handle, { status: "open" }).filter((an) => an.kind !== "approval");
}

export function ArtifactBrowser(props: {
  ws: string;
  width: number;
  rows: number;
  rootRunId?: string;
  st: BrowserUiState;
  onChange: (next: BrowserUiState) => void;
  keyRef: React.MutableRefObject<CardKeyHandler | null>;
  onClose: () => void;
  /** App-owned GC (it computes the protected refs from traces + task refs); dryRun previews. */
  gcRun?: (dryRun: boolean) => GcReport;
  onSubmitChat?: (text: string) => void;   // Phase 5: the reader's `r` verb
}) {
  const { ws, st, onChange } = props;

  // Data pipeline — pure, recomputed per render (the stores are cheap file/manifest reads at squad
  // scale, and the shelf re-renders only on state changes or a settle-triggered bump).
  const inScope = resolveScope(ws, st.scope, { rootRunId: props.rootRunId });
  const filters: BrowserFilters = st.search != null ? { ...st.filters, q: st.search } : st.filters;
  const matched = applyFilters(ws, inScope, filters);
  const rows = shelfRows(ws, matched, st.scope, st.sort);
  const arts = artifactRows(rows);
  const sel = Math.min(st.sel, Math.max(0, arts.length - 1));
  const rowArtifact: Artifact | undefined = arts[sel]?.artifact;
  // The reader may be pinned to an exact version via `v`; the shelf always shows latest-per-id.
  const current: Artifact | undefined = st.reading && st.versionOverride
    ? readArtifact(ws, st.versionOverride) ?? rowArtifact
    : rowArtifact;

  const handler: CardKeyHandler = (input, key) => {
    if (st.reading) {
      // `a` inline feedback input owns printable keys while open.
      if (st.feedback != null) {
        if (key.escape) { onChange({ ...st, feedback: null }); return; }
        if (key.return) {
          const body = st.feedback.trim();
          if (body && current) {
            const an = annotateArtifact(ws, { target: artifactHandle(current), author: "human", body, kind: "feedback" });
            onChange({ ...st, feedback: null, note: `✎ feedback on ${an.target}` });
          } else onChange({ ...st, feedback: null });
          return;
        }
        if (key.backspace || key.delete) { onChange({ ...st, feedback: st.feedback.slice(0, -1) }); return; }
        if (input && !key.ctrl && !key.meta && !key.upArrow && !key.downArrow && !key.tab) {
          onChange({ ...st, feedback: st.feedback + input });
          return;
        }
        return;
      }
      // `v` versions jump list.
      if (st.versionsOpen && current) {
        const versions = artifactVersions(ws, current.id);
        if (key.escape) { onChange({ ...st, versionsOpen: false }); return; }
        if (key.upArrow) { onChange({ ...st, versionSel: Math.max(0, st.versionSel - 1) }); return; }
        if (key.downArrow) { onChange({ ...st, versionSel: Math.min(versions.length - 1, st.versionSel + 1) }); return; }
        if (key.return) {
          const v = versions[st.versionSel];
          onChange({ ...st, versionsOpen: false, versionOverride: v ? `${current.id}@v${v}` : null, scroll: 0 });
          return;
        }
        return;
      }
      if (key.escape) { onChange({ ...st, reading: false, scroll: 0, versionOverride: null, note: undefined }); return; }
      if (key.upArrow) { onChange({ ...st, scroll: Math.max(0, st.scroll - 1) }); return; }
      if (key.downArrow) { onChange({ ...st, scroll: st.scroll + 1 }); return; }   // clamped at render
      if (key.leftArrow) { onChange({ ...st, sel: Math.max(0, sel - 1), scroll: 0, versionOverride: null, note: undefined }); return; }
      if (key.rightArrow) { onChange({ ...st, sel: Math.min(arts.length - 1, sel + 1), scroll: 0, versionOverride: null, note: undefined }); return; }
      if (input === "a") { onChange({ ...st, feedback: "" }); return; }
      if (input === "y" && current) {
        const an = annotateArtifact(ws, { target: artifactHandle(current), author: "human", body: "approved by captain", kind: "approval" });
        onChange({ ...st, note: `✓ approved ${an.target}` });
        return;
      }
      if (input === "v" && current) { onChange({ ...st, versionsOpen: true, versionSel: Math.max(0, artifactVersions(ws, current.id).length - 1) }); return; }
      // `r` request revision (Phase 5): composes and submits a NORMAL chat turn — root plans/delegates
      // it, approvals apply, and the revision run's completion re-docks the browser with the new
      // version on top. One key, not a new run type; the money it spends goes through the same gates
      // a typed request would.
      if (input === "r" && current && props.onSubmitChat) {
        const fb = openFeedback(ws, artifactHandle(current)).map((an) => an.body).join("; ");
        props.onSubmitChat(`revise ${artifactHandle(current)}: ${fb || "the captain requests a revision"}`);
        return;
      }
      if (input === "o" && current) {
        const path = artifactBodyPath(ws, artifactHandle(current));
        if (!path) {
          const uri = current.location.kind === "external" ? current.location.uri : "(no local file)";
          onChange({ ...st, note: `external — no local file: ${uri}` });
          return;
        }
        const editor = process.env.EDITOR || process.env.VISUAL;
        if (editor) {
          try {
            spawn(editor, [path], { detached: true, stdio: "ignore" }).unref();
            onChange({ ...st, note: `opened in ${editor}: ${path}` });
          } catch (e) {
            onChange({ ...st, note: `open failed (${e instanceof Error ? e.message : String(e)}): ${path}` });
          }
        } else onChange({ ...st, note: `no $EDITOR — body file: ${path}` });
        return;
      }
      return; // reader consumes everything else
    }
    // ── shelf ──
    // `g` dry-run preview awaiting confirm.
    if (st.gcPreview) {
      if (key.return && props.gcRun) {
        const r = props.gcRun(false);
        onChange({ ...st, gcPreview: null, note: `gc: archived ${r.archived.length} version(s), kept ${r.kept}` });
        return;
      }
      if (key.escape) { onChange({ ...st, gcPreview: null }); return; }
      return;
    }
    // "/" search owns printable keys while open: type to narrow, ⏎ keeps the query, esc clears it.
    if (st.search != null) {
      if (key.escape) { onChange({ ...st, search: null }); return; }
      if (key.return) { onChange({ ...st, search: st.search || null }); return; }
      if (key.backspace || key.delete) { onChange({ ...st, search: st.search.slice(0, -1) }); return; }
      if (input && !key.ctrl && !key.meta && !key.upArrow && !key.downArrow && !key.tab) {
        onChange({ ...st, search: st.search + input, sel: 0 });
        return;
      }
      return;
    }
    // the `f` chip row: ←/→ field, ↑↓ value (applies LIVE), x clear all, ⏎/esc close.
    if (st.filterOpen) {
      const field = FILTER_FIELDS[st.filterField]!;
      if (key.escape || key.return) { onChange({ ...st, filterOpen: false }); return; }
      if (key.leftArrow) { onChange({ ...st, filterField: (st.filterField + FILTER_FIELDS.length - 1) % FILTER_FIELDS.length }); return; }
      if (key.rightArrow) { onChange({ ...st, filterField: (st.filterField + 1) % FILTER_FIELDS.length }); return; }
      if (key.upArrow) { onChange({ ...st, filters: cycleFilter(st.filters, field, -1, inScope), sel: 0 }); return; }
      if (key.downArrow) { onChange({ ...st, filters: cycleFilter(st.filters, field, 1, inScope), sel: 0 }); return; }
      if (input === "x") { onChange({ ...st, filters: {}, sel: 0 }); return; }
      return;
    }
    if (key.escape) { props.onClose(); return; }
    if (input === "/") { onChange({ ...st, search: "" }); return; }
    if (input === "f") { onChange({ ...st, filterOpen: true, filterField: 0 }); return; }
    if (input === "g" && st.scope === "all" && props.gcRun) {
      const dry = props.gcRun(true);
      onChange({ ...st, gcPreview: dry.archived, note: undefined });
      return;
    }
    if (key.upArrow) { onChange({ ...st, sel: Math.max(0, sel - 1) }); return; }
    if (key.downArrow) { onChange({ ...st, sel: Math.min(Math.max(0, arts.length - 1), sel + 1) }); return; }
    if (key.return) { if (rowArtifact) onChange({ ...st, reading: true, scroll: 0, note: undefined }); return; }
    if (key.tab) {
      const i = SCOPES.findIndex((s) => s.key === st.scope);
      onChange({ ...st, scope: SCOPES[(i + 1) % SCOPES.length]!.key, sel: 0, hint: undefined });
      return;
    }
    if (input === "1" || input === "2" || input === "3") {
      onChange({ ...st, scope: SCOPES[Number(input) - 1]!.key, sel: 0, hint: undefined });
      return;
    }
    if (input === "s" && st.scope === "all") {
      const order: BrowserSort[] = ["run", "time", "producer"];
      onChange({ ...st, sort: order[(order.indexOf(st.sort) + 1) % order.length]! });
      return;
    }
    // consume everything else — the browser owns the keyboard while docked
  };

  // Publish the key handler DURING RENDER, not in an effect — the boot-registered useInput in App
  // forwards the very next keystroke here, and an effect lands a beat after the frame that shows the
  // dock, dropping that first key (the exact ink registration race ProposalCard solved; a ⏎ typed
  // right after "ARTIFACTS" appears must already find the handler). Cleanup runs on unmount only.
  props.keyRef.current = handler;
  useEffect(() => () => { props.keyRef.current = null; }, []);

  // ── READER (full-screen) ──────────────────────────────────────────────────────────────────────
  if (st.reading && current) {
    const handle = artifactHandle(current);
    const body = readArtifactBody(ws, handle)?.toString("utf8") ?? "";
    const bodyLines = body.split("\n");
    const visible = Math.min(READER_LINES, bodyLines.length);
    const maxScroll = Math.max(0, bodyLines.length - visible);
    const scroll = Math.min(st.scroll, maxScroll);
    const open = openFeedback(ws, handle);
    const versions = artifactVersions(ws, current.id);

    if (st.versionsOpen) {
      return (
        <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} width={props.width}>
          <Text color="cyan" bold>Versions of {current.id} (↑↓ move · ⏎ open · esc back)</Text>
          <Text> </Text>
          {versions.map((v, i) => {
            const on = i === st.versionSel;
            return <Text key={v} color={on ? "cyan" : undefined} bold={on}>{on ? "▸ " : "  "}{current.id}@v{v}</Text>;
          })}
        </Box>
      );
    }

    return (
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} width={props.width}>
        <Text dimColor>← esc   / {current.title}</Text>
        <Text color="cyan" bold>{handle} · {current.producer} · {ageLabel(current.created)} ago · {sel + 1}/{arts.length} · {current.runId}</Text>
        <Text> </Text>
        {bodyLines.slice(scroll, scroll + visible).map((line, i) => (
          <Text key={i}>{renderMarkdown(line, props.width - 4)}</Text>
        ))}
        {maxScroll > 0 && <Text dimColor>  ↑↓ scroll · {bodyLines.length - visible - scroll} more lines</Text>}
        {open.length > 0 && <Text> </Text>}
        {open.length > 0 && <Text color="yellow">⚑ open feedback ({open.length})</Text>}
        {open.slice(0, 3).map((an) => (
          <Text key={an.id} color="yellow">  {an.author} — {an.body.slice(0, props.width - 12)}</Text>
        ))}
        {st.note && <Text color="green">{st.note}</Text>}
        <Text> </Text>
        {st.feedback != null ? (
          <Text><Text dimColor>feedback ▸ </Text>{st.feedback}<Text color="cyan">▏</Text><Text dimColor>  (⏎ save · esc cancel)</Text></Text>
        ) : (
          <Text dimColor>a annotate · y approve · r revise · v versions · o $EDITOR · ←/→ prev/next · ↑/↓ scroll · esc shelf</Text>
        )}
      </Box>
    );
  }

  // ── SHELF (docked) ────────────────────────────────────────────────────────────────────────────
  const twoPane = props.width >= MIN_PANE_COLS * 2 && props.rows >= MIN_PANE_ROWS;
  const scopeTabs = SCOPES.map((s) => {
    const on = s.key === st.scope;
    return (
      <Text key={s.key} color={on ? "cyan" : "gray"} bold={on} inverse={on}>{` ${s.label} `}</Text>
    );
  });

  // Visible list window around the selection.
  let firstArtifactRowIndex = 0;
  const selRowIndex = rows.findIndex((r) => r.kind === "artifact" && r.artifact === rowArtifact);
  if (selRowIndex > SHELF_LIST_LINES - 2) firstArtifactRowIndex = selRowIndex - (SHELF_LIST_LINES - 2);
  const visibleRows = rows.slice(firstArtifactRowIndex, firstArtifactRowIndex + SHELF_LIST_LINES);

  const previewLines: string[] = [];
  if (rowArtifact) {
    const body = readArtifactBody(ws, artifactHandle(rowArtifact))?.toString("utf8") ?? "";
    previewLines.push(...body.split("\n").slice(0, SHELF_LIST_LINES - 2));
  }

  const list = (
    <Box flexDirection="column" width={twoPane ? Math.floor(props.width * 0.47) : undefined}>
      {visibleRows.map((r, i) => {
        if (r.kind === "header") return <Text key={`h${i}`} dimColor>{r.label}</Text>;
        const selected = r.artifact === rowArtifact;
        const badge = badgeText(r);
        return (
          <Text key={artifactHandle(r.artifact)} color={selected ? "cyan" : undefined} bold={selected}>
            {selected ? "▸ " : "  "}{artifactHandle(r.artifact)}  {r.artifact.producer}  {ageLabel(r.artifact.created)}
            {badge ? "  " : ""}{badge && <Text color={badge.color}>{badge.text}</Text>}
          </Text>
        );
      })}
      {rows.length === 0 && <Text dimColor>  (no artifacts in this scope)</Text>}
    </Box>
  );

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} width={props.width} marginTop={1}>
      <Box>
        <Text color="cyan" bold>ARTIFACTS </Text>
        {scopeTabs}
        <Text dimColor>   </Text>
        <Text color={matched.length === inScope.length ? undefined : "yellow"} dimColor={matched.length === inScope.length}>
          {countLine(matched.length, inScope.length)}
        </Text>
        {st.hint && <Text color="yellow"> · {st.hint}</Text>}
      </Box>
      {st.filterOpen && (
        <Box>
          <Text color="cyan" bold>FILTER  </Text>
          {FILTER_FIELDS.map((field, i) => {
            const on = i === st.filterField;
            const value = (st.filters[field] as string | undefined) ?? "any";
            return (
              <Text key={field} color={on ? "cyan" : "gray"} bold={on}>
                {field} <Text color={value === "any" ? "gray" : "yellow"}>{value}</Text>{i < FILTER_FIELDS.length - 1 ? " · " : ""}
              </Text>
            );
          })}
        </Box>
      )}
      {st.filterOpen && <Text dimColor>        ←/→ field · ↑↓ value (live) · x clear · ⏎/esc close</Text>}
      {st.search != null && (
        <Text><Text dimColor>/</Text>{st.search}<Text color="cyan">▏</Text><Text dimColor>  searching title + summary… (⏎ keep · esc clear)</Text></Text>
      )}
      {st.gcPreview && (
        <Box flexDirection="column">
          <Text color="yellow">gc would archive {st.gcPreview.length} version(s){st.gcPreview.length ? `: ${st.gcPreview.slice(0, 6).join(", ")}${st.gcPreview.length > 6 ? "…" : ""}` : " (nothing to collect)"}</Text>
          <Text dimColor>        ⏎ archive them · esc cancel</Text>
        </Box>
      )}
      {st.note && <Text color="green">{st.note}</Text>}
      <Text> </Text>
      {twoPane ? (
        <Box>
          {list}
          <Box flexDirection="column" marginLeft={2} flexGrow={1}>
            {rowArtifact && <Text color="cyan">{artifactHandle(rowArtifact)} · {rowArtifact.producer} · {ageLabel(rowArtifact.created)} · {sel + 1}/{arts.length}</Text>}
            {previewLines.map((l, i) => <Text key={i} wrap="truncate">{l}</Text>)}
          </Box>
        </Box>
      ) : list}
      <Text> </Text>
      <Text dimColor>↑↓ move · ⏎ read · tab/1·2·3 scope · f filter · / search{st.scope === "all" ? " · s sort · g gc" : ""} · esc chat</Text>
    </Box>
  );
}
