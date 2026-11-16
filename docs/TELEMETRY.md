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
  "tokens_cache_read": 0,
  "tokens_cache_write": 0,
  "models": {
    "claude-sonnet-5-5": {
      "in": 0,
      "out": 0,
      "cache_read": 0,
      "cache_write": 0,
      "cost_usd": 0.0
    }
  },
  "plan_window": {
    "five_hour": {
      "start": 6,
      "end": 9,
      "resets_at": "2026-11-16T19:10:00.000Z"
    },
    "seven_day": {
      "start": 22,
      "end": 23,
      "resets_at": "2026-11-17T04:00:00.000Z"
    }
  },
  "output_ref": "pr:123 | file:path | report:path",
  "detail": {}
}
```

`tokens_in` counts all input, cache reads and writes included; `tokens_cache_read` and `tokens_cache_write` say how
much of it was cache. `plan_window` is the Claude plan's usage, in percent, at the start and end of the run, as
headless Claude Code reports it (`rate_limit_event` in its stream-json output; whole percents). Subscriptions only:
with an API key there is no plan window and the field is absent. The extract event's `detail` carries the ticket's
`story_points` and `estimate_hours` from Jira (the field named "Story Points" or "Story point estimate", or
`JIRA_STORY_POINTS_FIELD`).

Fields that do not apply are omitted, never invented. `cost_source: unknown` means the event came from a
hook without access to billing data; the orchestrator's `run` event for the same session carries the cost.

## Context propagation

The orchestrator sets `AI_SDLC_RUN_ID`, `AI_SDLC_TICKET`, `AI_SDLC_UNIT`, `AI_SDLC_AGENT`,
`AI_SDLC_ATTEMPT` in each agent's environment; hooks copy them into their events.

## Queries

`npm run report` answers "cost and cycle time per ticket this week" from the file sink, and "how much of a
developer's plan does a story point take" (`ai-sdlc report [--since 30d] [--jira]`; `--jira` fills in story points and
estimates for tickets run before extract recorded them).

## plan-usage

The question is a developer's: on my Claude plan (a rolling 5-hour window and a weekly limit), how many story points
can the workflow deliver before I hit the limit? Per ticket, the report adds up what each of its runs moved the 5-hour
and 7-day windows (end minus start of the run; across a window reset, only the new window's part). Work in other
sessions _between_ runs is not counted; work in other sessions _during_ a run is, because the window is the
developer's, not the workflow's. Runs from before the window was recorded are estimated from cost, at the percent per
dollar of the measured runs, and marked `estimated`. Per story point: cost, tokens, agent minutes and percent of each
window; the projection is 100 divided by the 5-hour percent per point ("about N story points per 5-hour window if the
plan is used only by the workflow"). The figures are this developer's plan: a different plan (Pro, Max) has different
limits, so each developer's report speaks for their own plan.
`npm run dashboard` writes a static HTML view of the same data. With an OTLP store, the same
fields are attributes on each log record, so the equivalent query is a group-by on `ticket`.

<!-- ai-sdlc:end -->
