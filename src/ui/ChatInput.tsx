/** Plan 24: the REPL's message editor. Controlled (parent owns `value`), so the browser dock can unmount
 *  and remount it without losing the draft. Owns the cursor + history-nav state locally; maps each key to
 *  an action via classifyKey, applies it to the text buffer / history, and renders a bordered box with a
 *  block cursor. Enter submits (single logical line; it wraps visually). ↑/↓ browse history unless the
 *  slash-suggester is open, in which case the parent moves the menu highlight. */
import { useRef, type ReactNode } from "react";
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
  const cursor = useRef(props.value.length);
  const nav = useRef<HistNav>(histStart());
  const lastEmitted = useRef(props.value);
  // If the PARENT set `value` externally (submit clears it, accept-suggestion fills "/cmd "), move the
  // cursor to the end and reset history browsing — a controlled external set is a fresh line.
  if (props.value !== lastEmitted.current) {
    cursor.current = props.value.length;
    lastEmitted.current = props.value;
    nav.current = histStart();
  }
  if (cursor.current > props.value.length) cursor.current = props.value.length;

  // The ONE path that reports a value change upward; records it so the external-set check above doesn't
  // misfire on our own edit (parent re-renders with value === lastEmitted → no cursor reset).
  const emit = (value: string, cur: number) => { cursor.current = cur; lastEmitted.current = value; props.onChange(value); };
  const apply = (next: tb.Buf) => emit(next.value, next.cursor);
  const buf = (): tb.Buf => ({ value: props.value, cursor: cursor.current });

  useInput(
    (input, key) => {
      // Tab / ↑ / ↓ belong to the suggester while its menu is open.
      if (props.suggestOpen) {
        if (key.tab) { props.onSuggestAccept?.(); return; }
        if (key.upArrow) { props.onSuggestNav?.(-1); return; }
        if (key.downArrow) { props.onSuggestNav?.(1); return; }
      }
      const a = classifyKey(input, key);
      switch (a.kind) {
        case "insert": { apply(tb.insert(buf(), a.text)); nav.current = histStart(); return; }
        case "backspace": return apply(tb.backspace(buf()));
        case "del": return apply(tb.del(buf()));
        case "left": return apply(tb.left(buf()));
        case "right": return apply(tb.right(buf()));
        case "home": return apply(tb.home(buf()));
        case "end": return apply(tb.end(buf()));
        case "wordLeft": return apply(tb.wordLeft(buf()));
        case "wordRight": return apply(tb.wordRight(buf()));
        case "deleteWordBack": { apply(tb.deleteWordBack(buf())); nav.current = histStart(); return; }
        case "deleteWordForward": { apply(tb.deleteWordForward(buf())); nav.current = histStart(); return; }
        case "submit": {
          const v = props.value;
          nav.current = histStart();
          props.onSubmit(v);
          return;
        }
        case "historyPrev": {
          const r = histPrev(nav.current, props.history, props.value);
          if (r) { nav.current = r.nav; emit(r.value, r.value.length); }
          return;
        }
        case "historyNext": {
          const r = histNext(nav.current, props.history);
          if (r) { nav.current = r.nav; emit(r.value, r.value.length); }
          return;
        }
        case "noop": return;
      }
    },
    { isActive: props.isActive },
  );

  return (
    <Box borderStyle="round" borderColor={props.dimmed ? "gray" : "cyan"} paddingX={1} width={props.width}>
      <Text color={props.dimmed ? "gray" : "cyan"}>{props.busy ? "❯ " : "> "}</Text>
      <Text>{renderWithCursor(props.value, cursor.current, props.placeholder)}</Text>
    </Box>
  );
}

/** Render the value with a block cursor. An empty value shows the (dim) placeholder with the cursor at 0.
 *  The cursor is drawn as an inverse space at end-of-line, else an inverse of the char under it. */
function renderWithCursor(value: string, cursor: number, placeholder?: string): ReactNode {
  if (value.length === 0) {
    return (
      <>
        <Text inverse> </Text>
        {placeholder ? <Text dimColor>{placeholder}</Text> : null}
      </>
    );
  }
  const before = value.slice(0, cursor);
  const at = value.slice(cursor, cursor + 1);
  const after = value.slice(cursor + 1);
  return (
    <>
      <Text>{before}</Text>
      <Text inverse>{at || " "}</Text>
      <Text>{after}</Text>
    </>
  );
}
