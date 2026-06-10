import { Box, Text, useInput } from "ink";

/** The one interaction grammar: propose -> approve. Used for agent creation,
 *  coaching notes, exemplar promotion. */
export interface CardField { label: string; value: string; }

export function ProposalCard(props: {
  title: string;
  fields: CardField[];
  supersedes?: string;          // "this replaces: ..." line
  onDecision: (d: "approve" | "reject" | "edit") => void;
}) {
  useInput((input) => {
    if (input === "y") props.onDecision("approve");
    else if (input === "n") props.onDecision("reject");
    else if (input === "e") props.onDecision("edit");
  });
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
