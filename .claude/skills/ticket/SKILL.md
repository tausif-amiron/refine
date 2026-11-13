---
name: ticket
description: Turn a business analyst's description into a Jira ticket in the company format (context, numbered testable acceptance criteria, roles, out of scope, design links). Use when someone asks to write, draft or improve a ticket.
---

# Writing a ticket

The acceptance criteria you write become the **sealed bar**: when the ticket reaches "In Progress"
they are copied into the IR, and the blind score runs against that copy. Write them so a person who has
never seen the product can check each one.

## Format (exact headings; the extractor parses them)

```
# <Title: what changes for whom, under 80 characters>

## Context
Why this matters, who asked, what exists today. 2–5 sentences.

## Acceptance criteria
1. <Role> can <action> <object> <condition>. <Observable result>.
2. ...

## Roles affected
- <Role>: <what changes for them>

## Out of scope
- <What this ticket deliberately does not do>

## Design links
- <Figma or doc link>, or "none"

## Files                      (only for code changes: a utility, a CLI flag, tooling)
- <path>: <what changes>      (existing paths must exist; mark new files "new file")
```

## Checklist before saving (every item must hold)

- [ ] Every criterion is numbered and testable: it names a role, an action, and an observable result.
      No "should be fast", "user-friendly", "etc.", "and so on".
- [ ] Every role mentioned in a criterion appears under Roles affected.
- [ ] Every screen, list, field and status a criterion depends on is named the same way each time.
- [ ] Error and empty cases are criteria too (what the user sees when there is nothing, or it fails).
- [ ] Limits are numbers: volumes, latency, retention ("loads 500 invoices in under 2 s").
- [ ] Out of scope is filled in, even if with "none".
- [ ] No implementation instructions (tables, frameworks) unless they are real constraints.

## Steps

1. Ask the BA for anything the checklist cannot be satisfied without. One round of questions, grouped.
2. Draft the ticket in the format. Show it and the checklist result.
3. On approval, create or update the issue with the Atlassian MCP tools (createJiraIssue / editJiraIssue),
   in the project the BA names. Do not move it to "In Progress"; the BA does that, and that move starts extraction.
