---
description: Run the QA phase for a ticket (integration checks, UI walk, API walk, verdict)
argument-hint: <TICKET>
allowed-tools: Bash(npm run qa*), Read
---

Run `npm run qa -- $ARGUMENTS`. Then summarise `.ai-sdlc/reports/$ARGUMENTS/qa.md`: integration result, walk
gates, verdict, flaky tests, and any fix briefs sent back to units or escalations. Quote the check output;
do not restate results the report does not contain.
