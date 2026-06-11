import { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import type { ApprovalDecision } from "../core/run";

/** The one interaction grammar: propose -> approve. Used for agent creation,
 *  coaching notes, exemplar promotion. */
export interface CardField { label: string; value: string; }

export function ProposalCard(props: {
  title: string;
  fields: CardField[];
  supersedes?: string;          // "this replaces: ..." line
  onDecision: (d: ApprovalDecision) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editValues, setEditValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(props.fields.map((f) => [f.label, f.value]))
  );
  const [fieldIndex, setFieldIndex] = useState(0);

  useInput((input, key) => {
    if (editing) {
      // Esc from edit mode returns to y/n/e prompt
      if (key.escape) { setEditing(false); setFieldIndex(0); }
      return;
    }
    if (input === "y") props.onDecision({ type: "approve" });
    else if (input === "n") props.onDecision({ type: "reject" });
    else if (input === "e") { setEditing(true); setFieldIndex(0); }
  }, { isActive: true });

  if (editing) {
    const currentField = props.fields[fieldIndex];
    const isLast = fieldIndex === props.fields.length - 1;

    const handleSubmit = (value: string) => {
      const updated = { ...editValues, [currentField.label]: value };
      setEditValues(updated);
      if (isLast) {
        // Collect only changed fields (non-empty overrides)
        const changed: Record<string, string> = {};
        for (const f of props.fields) {
          if (updated[f.label] !== f.value && updated[f.label] !== "") {
            changed[f.label] = updated[f.label];
          }
        }
        props.onDecision({ type: "edit", draft: changed });
      } else {
        setFieldIndex(fieldIndex + 1);
      }
    };

    return (
      <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
        <Text color="yellow" bold>Editing — Tab/Enter to advance, Esc to cancel</Text>
        {props.fields.map((f, i) => (
          <Box key={f.label}>
            <Text color="gray">{f.label.padEnd(7)}</Text>
            {i === fieldIndex ? (
              <TextInput
                value={editValues[f.label]}
                onChange={(v) => setEditValues({ ...editValues, [f.label]: v })}
                onSubmit={handleSubmit}
              />
            ) : (
              <Text>{editValues[f.label]}</Text>
            )}
          </Box>
        ))}
        <Text color="gray">field {fieldIndex + 1}/{props.fields.length} — Enter to advance, Enter on last to submit</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text color="cyan" bold>{props.title}</Text>
      {props.fields.map((f) => (
        <Text key={f.label}>
          <Text color="gray">{f.label.padEnd(7)}</Text>{f.value}
        </Text>
      ))}
      {props.supersedes && <Text color="yellow">replaces: {props.supersedes}</Text>}
      <Text color="gray">approve? [y]es [n]o [e]dit</Text>
    </Box>
  );
}
