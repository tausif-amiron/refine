---
description: Draft a Jira ticket in the company format from a BA's description (ticket skill)
argument-hint: <description or existing ticket key>
---

Use the ticket skill (.claude/skills/ticket/SKILL.md) to write a ticket for:

$ARGUMENTS

Ask one grouped round of questions if the checklist cannot be met, show the draft with the checklist
result, and create or update it in Jira only after the BA approves.
