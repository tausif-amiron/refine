---
description: Extract (or review and answer questions on) the IR for a ticket
argument-hint: <TICKET>
allowed-tools: Bash(npm run extract*), Bash(npm run plan*), Read, Edit, Grep, Glob
---

Ticket: $ARGUMENTS

1. If `ir/$ARGUMENTS.ir.json` does not exist, run `npm run extract -- $ARGUMENTS` and report the result.
2. Show the IR summary: entities, roles, screens (with states), services (with operations), limits.
3. List open questions (with what each affects and what goes wrong if answered wrongly) and unplaced items.
4. As the developer answers, write each answer into `questions[].answer` and adjust the IR if needed
   (follow .claude/skills/ir/SKILL.md). Never edit sealed_acceptance_criteria.
5. When nothing is open, run `npm run plan -- $ARGUMENTS`.
