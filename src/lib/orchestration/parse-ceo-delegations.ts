import { ceoDelegationEnvelopeSchema, type CeoDelegationEnvelope } from "./delegation-schema";

const FINAL_DELEGATION_BLOCK = /(?:\r?\n)?```company-delegations\s*\r?\n([\s\S]*?)\r?\n```\s*$/;

export type ParsedCeoResponse = {
  visibleText: string;
  delegation: CeoDelegationEnvelope;
};

/**
 * Only a final, explicitly labelled JSON fence is machine actionable. JSON-like
 * prose and any earlier code block remain inert owner-visible text.
 */
export function parseCeoDelegations(response: string): ParsedCeoResponse {
  const match = FINAL_DELEGATION_BLOCK.exec(response);
  const markerCount = response.split("```company-delegations").length - 1;
  if (!match) {
    if (markerCount > 0) throw new Error("CEO_DELEGATION_BLOCK_MISPLACED");
    const visibleText = response.trim();
    if (!visibleText) throw new Error("CEO_VISIBLE_RESPONSE_REQUIRED");
    return { visibleText, delegation: { version: 1, tasks: [] } };
  }
  if (markerCount !== 1) throw new Error("CEO_DELEGATION_BLOCK_DUPLICATED");

  let json: unknown;
  try {
    json = JSON.parse(match[1]);
  } catch {
    throw new Error("CEO_DELEGATION_JSON_INVALID");
  }
  const parsed = ceoDelegationEnvelopeSchema.safeParse(json);
  if (!parsed.success) throw new Error("CEO_DELEGATION_SCHEMA_INVALID", { cause: parsed.error });
  const visibleText = response.slice(0, match.index).trim();
  if (!visibleText) throw new Error("CEO_VISIBLE_RESPONSE_REQUIRED");
  return {
    visibleText,
    delegation: parsed.data,
  };
}
