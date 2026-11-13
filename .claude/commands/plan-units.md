---
description: Generate (or explain) the unit plan and contracts for a ticket
argument-hint: <TICKET>
allowed-tools: Bash(npm run plan*), Read, Grep, Glob
---

Run `npm run plan -- $ARGUMENTS`, then explain the plan from `ir/$ARGUMENTS.plan.json`: units in order with
dependencies, which can run in parallel (same level), each unit's SCOPE and the contracts it owns. Flag any IR
issue that makes the plan look wrong; fixes go into the IR, then re-plan. Do not edit the plan or contracts.
