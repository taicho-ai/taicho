/** Plan 15 — the artifact viewer. A full-screen card that renders the selected artifact's body as
 *  markdown, scrollable. Header shows handle · producer · age · position · verdict. Browse with ←/→
 *  (prev/next artifact), tab opens the jump list, esc returns to chat.
 *
 *  Data source: the conversation's artifacts (gathered via gatherConversationArtifacts from the run
 *  tree), ordered latest-first. Opens on the newest artifact. Reuses the markdown render from
 *  App.tsx (renderMarkdown) — no second renderer. cardKeyRef-owned keyboard. */
import { useState, useEffect } from "react";
import { Box, Text } from "ink";
import type { Artifact } from "../schemas/artifact";
import { readArtifactBody } from "../store/artifacts";
import { renderMarkdown } from "./markdown";
import type { CardKeyHandler } from "./ProposalCard";

function ageLabel(created: string): string {
  const ms = Date.now() - Date.parse(created);
  if (isNaN(ms)) return "";
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function artifactHandle(a: Artifact): string {
  return `${a.id}@v${a.version}`;
}

export function ArtifactViewer({
  ws,
  artifacts,
  width,
  keyHandlerRef,
  onClose,
}: {
  ws: string;
  artifacts: Artifact[];
  width: number;
  keyHandlerRef: React.MutableRefObject<CardKeyHandler | null>;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(0);
  const [scroll, setScroll] = useState(0);
  const [showJumpList, setShowJumpList] = useState(false);

  const current = artifacts[index];
  const body = current ? readArtifactBody(ws, artifactHandle(current))?.toString("utf8") ?? "" : "";
  const bodyLines = body.split("\n");
  const visibleLines = Math.min(40, bodyLines.length);
  const maxScroll = Math.max(0, bodyLines.length - visibleLines);

  const handler = (input: string, key: { escape: boolean; upArrow: boolean; downArrow: boolean; leftArrow: boolean; rightArrow: boolean; tab?: boolean; return?: boolean }) => {
    if (showJumpList) {
      if (key.escape) { setShowJumpList(false); return; }
      if (key.upArrow) { setIndex((i) => Math.max(0, i - 1)); return; }
      if (key.downArrow) { setIndex((i) => Math.min(artifacts.length - 1, i + 1)); return; }
      if (key.return) { setShowJumpList(false); setScroll(0); return; }
      return;
    }
    if (key.escape) { onClose(); return; }
    if (key.leftArrow) { setIndex((i) => Math.max(0, i - 1)); setScroll(0); return; }
    if (key.rightArrow) { setIndex((i) => Math.min(artifacts.length - 1, i + 1)); setScroll(0); return; }
    if (key.upArrow) { setScroll((s) => Math.max(0, s - 1)); return; }
    if (key.downArrow) { setScroll((s) => Math.min(maxScroll, s + 1)); return; }
    if (key.tab) { setShowJumpList(true); return; }
  };

  useEffect(() => {
    keyHandlerRef.current = handler;
    return () => { if (keyHandlerRef.current === handler) keyHandlerRef.current = null; };
  }, [keyHandlerRef, maxScroll, showJumpList, artifacts.length]);

  if (!current) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
        <Text dimColor>no artifacts to view</Text>
        <Text dimColor>esc to close</Text>
      </Box>
    );
  }

  const handle = artifactHandle(current);
  const position = `${index + 1} / ${artifacts.length}`;
  const age = ageLabel(current.created);

  if (showJumpList) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} width={width}>
        <Text color="cyan" bold>Artifacts (↑↓ move · ⏎ open · esc back)</Text>
        <Text> </Text>
        {artifacts.map((a, i) => {
          const h = artifactHandle(a);
          const selected = i === index;
          return (
            <Text key={h} color={selected ? "cyan" : undefined} bold={selected}>
              {selected ? "▸ " : "  "}{a.title} · {h} · {a.producer} · {ageLabel(a.created)}
            </Text>
          );
        })}
      </Box>
    );
  }

  const visibleBody = bodyLines.slice(scroll, scroll + visibleLines);
  const moreLines = bodyLines.length - visibleLines;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} width={width}>
      <Text dimColor>← esc   / {current.title}</Text>
      <Text color="cyan" bold>{handle} · {current.producer} · {age} · {position}</Text>
      <Text> </Text>
      {visibleBody.map((line, i) => (
        <Text key={i}>{renderMarkdown(line, width - 4)}</Text>
      ))}
      {moreLines > 0 && <Text dimColor>  ↑↓ scroll · {moreLines} more lines</Text>}
      <Text> </Text>
      <Text dimColor>←/→ prev/next · ↑/↓ scroll · tab jump list · esc back</Text>
    </Box>
  );
}
