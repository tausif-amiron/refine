// An LLM gateway (LiteLLM, or anything that serves the Anthropic Messages API) in front of every agent run.
// config: "gateway": { "url", "keys": { "<agent>" | "default": "<ENV VAR NAME>" }, "headers": { name: template } }
// Each agent class gets its own key (and so its own budget and spend at the gateway); the provider key is blanked so
// it never reaches the gateway; headers tag each call with {ticket}, {agent}, {unit} and {run}. No url: runs go
// straight to the provider as before. The review agent can still be sent elsewhere with REVIEW_BASE_URL.
import type { Config } from "./config.ts";
import type { AgentRunRequest, AgentRunner } from "./runner.ts";

export function gatewayKeyVar(cfg: Config, agent: string): string | undefined {
  return cfg.gateway?.keys?.[agent] ?? cfg.gateway?.keys?.default;
}

export function gatewayEnv(cfg: Config, req: AgentRunRequest, env: NodeJS.ProcessEnv): Record<string, string> {
  if (req.agent === "review" && env.REVIEW_BASE_URL) {
    return { ANTHROPIC_BASE_URL: env.REVIEW_BASE_URL, ANTHROPIC_AUTH_TOKEN: env.REVIEW_API_KEY ?? "", ANTHROPIC_API_KEY: "" };
  }
  const url = cfg.gateway?.url;
  if (!url) return {};
  const keyVar = gatewayKeyVar(cfg, req.agent);
  const token = keyVar ? env[keyVar] : undefined;
  if (!keyVar || !token) throw new Error(`The gateway needs a key for the ${req.agent} agent: set ${keyVar ?? "gateway.keys.default in ai-sdlc.config.json"}.`);
  const vars: Record<string, string> = { ticket: req.env?.AI_SDLC_TICKET ?? "", agent: req.agent, unit: req.env?.AI_SDLC_UNIT ?? "", run: req.env?.AI_SDLC_RUN_ID ?? "" };
  const headers = Object.entries(cfg.gateway?.headers ?? {})
    .map(([name, template]) => `${name}: ${template.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? "")}`)
    .join("\n");
  return {
    ANTHROPIC_BASE_URL: url.replace(/\/$/, ""),
    ANTHROPIC_AUTH_TOKEN: token,
    ANTHROPIC_API_KEY: "",
    ...(headers ? { ANTHROPIC_CUSTOM_HEADERS: headers } : {}),
  };
}

export function withGateway(inner: AgentRunner, cfg: Config, env: NodeJS.ProcessEnv = process.env): AgentRunner {
  return { run: (req) => inner.run({ ...req, env: { ...req.env, ...gatewayEnv(cfg, req, env) } }) };
}
