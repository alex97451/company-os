const emailPattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const bearerPattern = /\bbearer\s+[A-Z0-9._~+/=-]{8,}/i;
const privateKeyPattern = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i;
const assignedSecretPattern = /\b(?:api[_ -]?key|access[_ -]?token|auth[_ -]?token|client[_ -]?secret|secret|password|passwd|pwd)\b\s*(?:=|:|is\s+)\s*["']?[^\s"']{4,}/i;
const providerTokenPattern = /\b(?:sk|pk)_(?:live|test)_[A-Z0-9]{8,}\b|\b(?:sk|rk)-[A-Z0-9_-]{12,}\b/i;
const commonCredentialPattern = /\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|ASIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/;
const jwtPattern = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/;

const quoteFieldPatterns = [
  /\b(?:quote|quotation|estimate|invoice|devis|facture)\s*(?:#|number|no\.?|n[°º])?/i,
  /\b(?:subtotal|sous-total|total due|amount due|solde dû|montant dû)\b/i,
  /\b(?:vat|tva|sales tax|tax total)\b/i,
  /\b(?:deposit|acompte)\b\s*(?:required|due|payable|requis|à payer|:)/i,
  /\b(?:unit price|prix unitaire|quantity|quantité|qty)\b/i,
  /(?:£|\$|€|GBP|USD|EUR)\s*\d[\d,.]*/i,
  /\b(?:vendor|supplier|prestataire)\s*(?:name|address|email|nom|adresse)?\s*:/i,
];

export type OwnerMessagePolicyViolation = "email" | "credential" | "customer_quote";

export function findOwnerMessagePolicyViolation(message: string): OwnerMessagePolicyViolation | null {
  if (emailPattern.test(message)) return "email";
  if (bearerPattern.test(message) || privateKeyPattern.test(message)
    || assignedSecretPattern.test(message) || providerTokenPattern.test(message)
    || commonCredentialPattern.test(message) || jwtPattern.test(message)) return "credential";
  const quoteSignals = quoteFieldPatterns.reduce((count, pattern) => count + Number(pattern.test(message)), 0);
  return quoteSignals >= 2 ? "customer_quote" : null;
}

export function assertSafeOwnerMessage(message: string): void {
  if (findOwnerMessagePolicyViolation(message)) throw new Error("OWNER_MESSAGE_SENSITIVE_DATA");
}
