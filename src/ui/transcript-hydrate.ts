/** Boot hydration: turn the replayed conversation thread — the SAME `rootThread` the model receives on
 *  startup — into visible scrollback, so a resumed session opens on its history instead of a blank
 *  screen. Pure + tested; App seeds `lines` from this at boot. What you SEE matches what the model
 *  REMEMBERS: the replay is compacted (Plan 05 Ph3), so folded older turns arrive as one condensed
 *  marker rather than verbatim. */
import type { ModelMessage } from "ai";
import type { Line } from "./slash";

// The pinned summary head the replay cache leads with once older turns were folded (see store/thread.ts).
const COMPACTION_HEAD_MARKER = "[CONVERSATION COMPACTION]";

/** Flatten a message's content to plain text. A replayed turn is usually a string; be defensive about
 *  the structured content-part form (extract the text parts, ignore the rest). */
function textOf(content: ModelMessage["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part && typeof (part as { text?: unknown }).text === "string") {
          return (part as { text: string }).text;
        }
        return "";
      })
      .join("");
  }
  return "";
}

/** Map the replay thread to scrollback lines: the compaction head becomes a "condensed" marker, user and
 *  assistant turns become their normal lines, bracketed by a `resumed` header and a closing rule so the
 *  prior conversation reads as clearly distinct from the live session below it. Empty in → empty out
 *  (a fresh conversation hydrates nothing). */
export function threadToLines(messages: ModelMessage[]): Line[] {
  const body: Line[] = [];
  let condensed = false;
  for (const m of messages) {
    const text = textOf(m.content).trim();
    if (!text) continue;
    if (m.role === "user") {
      if (text.startsWith(COMPACTION_HEAD_MARKER)) { condensed = true; continue; } // the pinned summary head
      body.push({ kind: "user", text });
    } else if (m.role === "assistant") {
      body.push({ kind: "agent", from: "root", text, rendered: true });
    }
    // system / tool roles were never part of the visible conversation — skip them
  }
  if (body.length === 0) return [];
  const header = condensed ? "  ↩ resumed conversation · earlier turns condensed" : "  ↩ resumed conversation";
  return [{ kind: "system", text: header }, ...body, { kind: "system", text: "  ───────────────" }];
}
