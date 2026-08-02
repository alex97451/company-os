import { z } from "zod";
import { SUPPORTED_APP_SERVER_PROTOCOLS } from "./contracts";

const loopbackHosts = new Set(["127.0.0.1", "[::1]", "::1", "localhost"]);

const loopbackUrlSchema = z.string().url().superRefine((value, context) => {
  const url = new URL(value);
  if (!loopbackHosts.has(url.hostname)) {
    context.addIssue({ code: "custom", message: "Codex bridge must bind to a loopback host" });
  }
  if (!new Set(["ws:", "wss:"]).has(url.protocol)) {
    context.addIssue({ code: "custom", message: "App-server transport requires WebSocket" });
  }
  if (url.username || url.password) {
    context.addIssue({ code: "custom", message: "Credentials must not be embedded in the bridge URL" });
  }
});

export const codexBridgeConfigSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("demo"), seed: z.string().min(1).max(64).default("company-os-test-double") }),
  z.object({
    mode: z.literal("app-server"),
    endpoint: loopbackUrlSchema,
    protocolVersion: z.enum(SUPPORTED_APP_SERVER_PROTOCOLS),
  }),
  z.object({ mode: z.literal("exec-resume"), executable: z.literal("codex"), localOnly: z.literal(true) }),
]);

export type CodexBridgeConfig = z.infer<typeof codexBridgeConfigSchema>;

export function parseCodexBridgeConfig(input: unknown): CodexBridgeConfig {
  return codexBridgeConfigSchema.parse(input);
}
