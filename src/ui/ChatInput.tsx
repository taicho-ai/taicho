/** Plan 24: the REPL's message editor. Controlled (parent owns `value`), so the browser dock can unmount
 *  and remount it without losing the draft. The cursor is local STATE (not a ref) — a cursor-only move
 *  (←/→/word/home/end) changes no text, so `onChange` gets the same value and the parent bails out; only
 *  a `setCursor` re-render keeps the visible block cursor in sync with the logical position. Maps each key
 *  to an action via classifyKey, applies it to the text buffer / history, renders a bordered box that
 *  wraps as one paragraph. Enter submits; Shift+Enter / Ctrl+J insert a newline. ↑/↓ move by line inside a
 *  multi-line message, and only at the top/bottom edge do they drive the suggester menu or browse history. */
import { useRef, useReducer, type ReactNode } from "react";
import { Box, Text, useInput } from "ink";
import * as tb from "./text-buffer";
import { classifyKey } from "./input-keys";
import { histStart, histPrev, histNext, type HistNav } from "./input-history";

export interface ChatInputProps {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  history: string[];
  isActive: boolean;
  suggestOpen: boolean;
  onSuggestNav?: (dir: -1 | 1) => void;
  onSuggestAccept?: () => void;
  placeholder?: string;
  width: number;
  dimmed?: boolean;
  busy?: boolean; // a run is live → the prompt becomes ❯ (you can still type to steer)
}

export function ChatInput(props: ChatInputProps) {
  // The cursor is a REF, not state: two keys can arrive before React re-renders, and each must read the
  // LATEST cursor (state would be stale on the second, so "←←" would only move once). A `bump()` forces
  // the re-render that state would have given us — needed because a cursor-only move changes no text, so
  // onChange hands the parent the same value and it bails out (no repaint).
  const cursor = useRef(props.value.length);
  const lastValue = useRef(props.value);
  const nav = useRef<HistNav>(histStart());
  const [, bump] = useReducer((n: number) => n + 1, 0);

  // If the PARENT changed value out from under us (submit clears, accept-suggestion fills, a set), snap the
  // cursor to the end and reset history browsing.
  if (props.value !== lastValue.current) {
    lastValue.current = props.value;
    cursor.current = props.value.length;
    nav.current = histStart();
  }
  if (cursor.current > props.value.length) cursor.current = props.value.length; // defensive clamp
  const cur = cursor.current;

  // The ONE path that changes value/cursor. `bump()` re-renders even for a cursor-ONLY move (where the
  // parent bails on the same value) — that is what keeps the visible block cursor in sync.
  const commit = (value: string, nextCursor: number) => {
    cursor.current = nextCursor;
    lastValue.current = value;
    props.onChange(value);
    bump();
  };
  const apply = (next: tb.Buf) => commit(next.value, next.cursor);
  const buf = (): tb.Buf => ({ value: props.value, cursor: cursor.current });

  useInput(
    (input, key) => {
      // Tab accepts the highlighted command.
      if (props.suggestOpen && key.tab) { props.onSuggestAccept?.(); return; }

      // ↑/↓: move by LINE inside a multi-line message first; only at the top/bottom edge do they drive the
      // command menu (while typing a new command) or browse history. History is a STICKY mode — once you've
      // stepped into it (idx !== -1), ↑/↓ keep browsing even if a recalled "/command" re-opens the suggester.
      if (key.upArrow || key.downArrow) {
        const up = key.upArrow;
        const atEdge = up ? tb.isOnFirstLine(props.value, cursor.current) : tb.isOnLastLine(props.value, cursor.current);
        if (!atEdge) return apply(up ? tb.lineUp(buf()) : tb.lineDown(buf()));
        const browsingHistory = nav.current.idx !== -1;
        if (props.suggestOpen && !browsingHistory) { props.onSuggestNav?.(up ? -1 : 1); return; }
        const r = up ? histPrev(nav.current, props.history, props.value) : histNext(nav.current, props.history);
        if (r) { nav.current = r.nav; commit(r.value, r.value.length); }
        return;
      }

      const a = classifyKey(input, key);
      switch (a.kind) {
        case "newline": { nav.current = histStart(); return apply(tb.insert(buf(), "\n")); } // Shift+Enter / Ctrl+J
        case "insert": { nav.current = histStart(); return apply(tb.insert(buf(), a.text)); }
        case "backspace": return apply(tb.backspace(buf()));
        case "del": return apply(tb.del(buf()));
        case "left": return apply(tb.left(buf()));
        case "right": return apply(tb.right(buf()));
        case "home": return apply(tb.home(buf()));
        case "end": return apply(tb.end(buf()));
        case "wordLeft": return apply(tb.wordLeft(buf()));
        case "wordRight": return apply(tb.wordRight(buf()));
        case "deleteWordBack": { nav.current = histStart(); return apply(tb.deleteWordBack(buf())); }
        case "deleteWordForward": { nav.current = histStart(); return apply(tb.deleteWordForward(buf())); }
        case "submit": { nav.current = histStart(); props.onSubmit(props.value); return; }
        case "historyPrev": case "historyNext": return; // ↑/↓ handled above
        case "noop": return;
      }
    },
    { isActive: props.isActive },
  );

  // ONE Text node (prompt + content) so a long message WRAPS as a single clean paragraph inside the box.
  const accent = props.dimmed ? "gray" : "cyan";
  return (
    <Box borderStyle="round" borderColor={accent} paddingX={1} width={props.width}>
      <Text>
        <Text color={accent}>{props.busy ? "❯ " : "> "}</Text>
        {renderInner(props.value, cur, props.placeholder)}
      </Text>
    </Box>
  );
}

// Ink drops color/inverse styling when stdout is not a TTY (i.e. under the test harness), which makes an
// inverse block cursor invisible to tests. So off-TTY we render a VISIBLE caret (▏) at the cursor position
// — the block-cursor position becomes assertable, and this exact desync bug can never regress silently.
const CARET_VISIBLE = !process.stdout.isTTY;

/** The value with the cursor. Real terminal: an inverse block on the char under the cursor. Off-TTY
 *  (tests): a visible caret `▏` immediately BEFORE that char, so its position shows in a stripped frame. */
function renderInner(value: string, cursor: number, placeholder?: string): ReactNode {
  const before = value.slice(0, cursor);
  const at = value.slice(cursor, cursor + 1);
  const after = value.slice(cursor + 1);
  if (value.length === 0) {
    return (
      <>
        {CARET_VISIBLE ? <Text>▏</Text> : <Text inverse> </Text>}
        {placeholder ? <Text dimColor>{placeholder}</Text> : null}
      </>
    );
  }
  // Off-TTY: a bar caret `▏` immediately before the char under the cursor (position is assertable).
  if (CARET_VISIBLE) return (<>{before}<Text>▏</Text>{at}{after}</>);
  // On a real terminal: an inverse BLOCK on the char under the cursor. When that char is a newline (or the
  // cursor sits at end-of-text) highlight a space instead — an inverse `\n` renders oddly — then still emit
  // the line break so the following text stays on its own row.
  const onBreak = at === "" || at === "\n";
  return (
    <>
      {before}
      <Text inverse>{onBreak ? " " : at}</Text>
      {at === "\n" ? "\n" : null}
      {after}
    </>
  );
}
