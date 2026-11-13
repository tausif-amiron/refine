<!-- ai-sdlc:start -->

# Telemetry

Every agent run, interactive or headless, emits structured events. The orchestrator emits one `run`
event per agent run; hooks emit `tool_call` and `session_end` events so interactive sessions report too.

## Sinks

- **File (always on):** JSON lines appended to `.ai-sdlc/telemetry/events.jsonl` (path in `ai-sdlc.config.json`).
- **OTLP/HTTP (optional):** when `OTEL_EXPORTER_OTLP_ENDPOINT` is set, each event is also sent as an
  OpenTelemetry log record to `<endpoint>/v1/logs`. Headers come from `OTEL_EXPORTER_OTLP_HEADERS`
  (`k=v,k2=v2`). Failures to export never fail a run.

## event-schema

```json
{
  "schema": "ai-sdlc.event.v1",
  "event": "run | tool_call | session_end | escalation | gate | release | incident",
  "run_id": "run-2026-11-09-0142-ab12",
  "ticket": "JIRA-123",
  "unit": "unit-service-invoices",
  "agent": "dev-backend",
  "model": "sonnet",
  "attempt": 1,
  "started_at": "2026-11-09T10:00:00.000Z",
  "ended_at": "2026-11-09T10:04:12.000Z",
  "status": "pass | fail | escalated | blocked | error | info",
  "tokens_in": 0,
  "tokens_out": 0,
  "cost_usd": 0.0,
  "cost_source": "cli | sdk | unknown",
  "output_ref": "pr:123 | file:path | report:path",
  "detail": {}
}
```

Fields that do not apply are omitted, never invented. `cost_source: unknown` means the event came from a
hook without access to billing data; the orchestrator's `run` event for the same session carries the cost.

## Context propagation

The orchestrator sets `AI_SDLC_RUN_ID`, `AI_SDLC_TICKET`, `AI_SDLC_UNIT`, `AI_SDLC_AGENT`,
`AI_SDLC_ATTEMPT` in each agent's environment; hooks copy them into their events.

## Queries

`npm run report` answers "cost and cycle time per ticket this week" from the file sink.
`npm run dashboard` writes a static HTML view of the same data. With an OTLP store, the same
fields are attributes on each log record, so the equivalent query is a group-by on `ticket`.

<!-- ai-sdlc:end -->
