# The message editor (Plan 24)

The REPL's input is a bordered `ChatInput` (`src/ui/ChatInput.tsx`) over three pure, unit-tested modules —
`text-buffer.ts` (cursor + word boundaries), `input-history.ts` (↑/↓ nav + per-workspace persistence),
and `input-keys.ts` (the cross-platform key classifier). It replaced `@inkjs/ui`'s uncontrolled TextInput.

## Keys

- **History:** `↑` / `↓` recall previous messages (they move the menu instead while a `/command`
  suggester is open). History persists per-workspace in `.taicho-input-history` (gitignored).
- **Word motion:** `Option/Alt + ←` / `→` — also `Alt+b` / `Alt+f`.
- **Word delete:** `Option/Alt + Backspace`, `Alt+d` (forward), and **`Ctrl+W`** (delete previous word).
- **Line:** `Home` / `End` (or `Ctrl+A` / `Ctrl+E`); `Enter` sends; `Esc` cancels a run / quits.

## Terminal setup for the Option/word keys

The word keys need the terminal to send Option/Alt as **Meta**. Ink normalizes it two ways — the classic
`ESC`-prefixed sequence and the modern **kitty keyboard protocol** — so:

- **kitty-protocol terminals** (kitty, Ghostty, WezTerm) work out of the box.
- **macOS Terminal.app** — enable *Settings → Profiles → Keyboard → "Use Option as Meta key"*.
- **iTerm2** — set *Profiles → Keys → Left/Right Option key → `Esc+`*.

Don't want to change your terminal? **`Ctrl+W`** deletes the previous word everywhere, no setup required.

## Scope

One logical line that wraps; `Enter` sends. Multi-line editing (`Enter` for a newline, submit on
`Shift+Enter`) is a future extension — the text buffer already generalizes to it.
