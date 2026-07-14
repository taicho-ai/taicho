/** Plan 24: map one Ink keypress to a semantic editing action. This is the ONE place the cross-platform
 *  key detection lives. Ink 7.1.0 normalizes Option/Alt into `key.meta` (via ESC-prefix like `\x1b\x7f`,
 *  and via the kitty keyboard protocol). We also bind Ctrl+W → delete-word-back, the readline-universal
 *  fallback that works even on macOS Terminal.app/iTerm2 when "Use Option as Meta" is OFF. Word MOVE is
 *  bound to meta+arrow and meta+b / meta+f; word DELETE to meta+backspace / meta+delete, Alt+d, Ctrl+W. */
import type { Key } from "ink";

export type InputAction =
  | { kind: "insert"; text: string }
  | { kind: "backspace" } | { kind: "del" }
  | { kind: "left" } | { kind: "right" } | { kind: "home" } | { kind: "end" }
  | { kind: "wordLeft" } | { kind: "wordRight" } | { kind: "deleteWordBack" } | { kind: "deleteWordForward" }
  | { kind: "submit" } | { kind: "historyPrev" } | { kind: "historyNext" } | { kind: "noop" };

export function classifyKey(input: string, key: Key): InputAction {
  if (key.return) return { kind: "submit" };
  if (key.tab || key.escape) return { kind: "noop" }; // owned by the suggester / higher dispatch

  // Word DELETE (check before plain backspace/delete).
  if (key.ctrl && (input === "w" || input === "\x17")) return { kind: "deleteWordBack" }; // Ctrl+W
  if (key.meta && key.backspace) return { kind: "deleteWordBack" };
  if (key.meta && key.delete) return { kind: "deleteWordForward" };
  if (key.meta && input === "d") return { kind: "deleteWordForward" };

  // Word MOVE (check before plain arrows).
  if (key.meta && key.leftArrow) return { kind: "wordLeft" };
  if (key.meta && key.rightArrow) return { kind: "wordRight" };
  if (key.meta && input === "b") return { kind: "wordLeft" };
  if (key.meta && input === "f") return { kind: "wordRight" };

  // Plain motions + deletes.
  if (key.backspace) return { kind: "backspace" };
  if (key.delete) return { kind: "del" };
  if (key.leftArrow) return { kind: "left" };
  if (key.rightArrow) return { kind: "right" };
  if (key.home || (key.ctrl && input === "a")) return { kind: "home" };
  if (key.end || (key.ctrl && input === "e")) return { kind: "end" };
  if (key.upArrow) return { kind: "historyPrev" };
  if (key.downArrow) return { kind: "historyNext" };

  // Any remaining ctrl/meta combo is a shortcut we don't own — never insert control chars.
  if (key.ctrl || key.meta) return { kind: "noop" };
  // Printable text (Ink hands a paste as one multi-char `input`).
  if (input && input !== "\r" && input !== "\n") return { kind: "insert", text: input };
  return { kind: "noop" };
}
