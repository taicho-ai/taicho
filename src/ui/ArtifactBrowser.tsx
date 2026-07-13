/** Plan 21 — the artifact browser. Two surfaces, one component:
 *   - the SHELF, docked over the (still visible) chat scrollback: artifact list + live preview,
 *     scope control, mode line. Runs END here (App auto-docks on completed artifact-producing turns).
 *   - the READER, full-screen (captain-decided): the old ArtifactViewer's render, entered with ⏎.
 *
 *  ALL UI state lives in App's `browserState` (passed as `st` + `onChange`) so a pending approval
 *  card can UNMOUNT the browser outright and remount it losslessly — spec §1's suspension rule.
 *  Keys arrive via `keyRef` (a browser-OWNED ref, never cardKeyRef): App's useInput dispatches
 *  pending card → operation view → browser → chat, so ownership is fixed order, not last-writer-wins. */
import { useEffect } from "react";
import { Box, Text } from "ink";
import { type Artifact, artifactHandle } from "../schemas/artifact";
import { readArtifactBody } from "../store/artifacts";
import { listAnnotations } from "../store/annotations";
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
  search: string | null;        // "/" live query; null = closed (Phase 3 opens it)
  hint?: string;                // background-settle scope hint (Phase 2)
}

export function initialBrowserUi(): BrowserUiState {
  return { scope: "run", sort: "run", filters: {}, sel: 0, reading: false, scroll: 0, search: null };
}

const SCOPES: { key: BrowserScope; label: string }[] = [
  { key: "run", label: "1 this run" },
  { key: "conversation", label: "2 conversation" },
  { key: "all", label: "3 all runs" },
];

const READER_LINES = 40;
const SHELF_LIST_LINES = 10;

function badgeText(r: Extract<ShelfRow, { kind: "artifact" }>): { text: string; color?: string } | null {
  if (r.badges.openFeedback > 0) return { text: `⚑ ${r.badges.openFeedback} open`, color: "yellow" };
  if (r.badges.verdict === "fail") return { text: "✗ fail", color: "red" };
  if (r.badges.approved || r.badges.verdict === "pass") return { text: "✓", color: "green" };
  return null;
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
  const current: Artifact | undefined = arts[sel]?.artifact;

  const handler: CardKeyHandler = (input, key) => {
    if (st.reading) {
      if (key.escape) { onChange({ ...st, reading: false, scroll: 0 }); return; }
      if (key.upArrow) { onChange({ ...st, scroll: Math.max(0, st.scroll - 1) }); return; }
      if (key.downArrow) { onChange({ ...st, scroll: st.scroll + 1 }); return; }   // clamped at render
      if (key.leftArrow) { onChange({ ...st, sel: Math.max(0, sel - 1), scroll: 0 }); return; }
      if (key.rightArrow) { onChange({ ...st, sel: Math.min(arts.length - 1, sel + 1), scroll: 0 }); return; }
      return; // reader consumes everything else (verbs arrive in Phase 4)
    }
    if (key.escape) { props.onClose(); return; }
    if (key.upArrow) { onChange({ ...st, sel: Math.max(0, sel - 1) }); return; }
    if (key.downArrow) { onChange({ ...st, sel: Math.min(Math.max(0, arts.length - 1), sel + 1) }); return; }
    if (key.return) { if (current) onChange({ ...st, reading: true, scroll: 0 }); return; }
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
    const open = listAnnotations(ws, handle, { status: "open" });
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
        <Text> </Text>
        <Text dimColor>←/→ prev/next · ↑/↓ scroll · esc shelf</Text>
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
  const selRowIndex = rows.findIndex((r) => r.kind === "artifact" && r.artifact === current);
  if (selRowIndex > SHELF_LIST_LINES - 2) firstArtifactRowIndex = selRowIndex - (SHELF_LIST_LINES - 2);
  const visibleRows = rows.slice(firstArtifactRowIndex, firstArtifactRowIndex + SHELF_LIST_LINES);

  const previewLines: string[] = [];
  if (current) {
    const body = readArtifactBody(ws, artifactHandle(current))?.toString("utf8") ?? "";
    previewLines.push(...body.split("\n").slice(0, SHELF_LIST_LINES - 2));
  }

  const list = (
    <Box flexDirection="column" width={twoPane ? Math.floor(props.width * 0.47) : undefined}>
      {visibleRows.map((r, i) => {
        if (r.kind === "header") return <Text key={`h${i}`} dimColor>{r.label}</Text>;
        const selected = r.artifact === current;
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
        <Text dimColor>   {countLine(matched.length, inScope.length)}{st.hint ? ` · ${st.hint}` : ""}</Text>
      </Box>
      <Text> </Text>
      {twoPane ? (
        <Box>
          {list}
          <Box flexDirection="column" marginLeft={2} flexGrow={1}>
            {current && <Text color="cyan">{artifactHandle(current)} · {current.producer} · {ageLabel(current.created)} · {sel + 1}/{arts.length}</Text>}
            {previewLines.map((l, i) => <Text key={i} wrap="truncate">{l}</Text>)}
          </Box>
        </Box>
      ) : list}
      <Text> </Text>
      <Text dimColor>↑↓ move · ⏎ read · tab/1·2·3 scope{st.scope === "all" ? " · s sort" : ""} · esc chat</Text>
    </Box>
  );
}
