---
description: Run the blind score observation for a ticket and open the judging template
argument-hint: <TICKET> <app url>
allowed-tools: Bash(npm run score:probe*), Bash(npm run score:finalize*), Read
---

Arguments: $ARGUMENTS (ticket, then the URL of the running build).

1. Run `npm run score:probe -- <TICKET> --url <url>`.
2. Open `.ai-sdlc/reports/<TICKET>/score-judging.md` and show it. Explain: the person judging writes `same` or
   `different` for each probe against the ticket and design; unreached probes are already `different`.
3. Do not fill in verdicts yourself. When the person says they are done, run
   `npm run score:finalize -- <TICKET>` and report the count.
