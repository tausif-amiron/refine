---
name: grill
description: Attack a recommended answer to an open IR question: steelman the alternatives, find what would make the recommendation wrong, and point the developer at the exact code and tests to read before deciding. Use as `/grill Q-n [doubt]`.
---

# /grill: try to break the recommendation

The developer should not trust the recommendation; your job is to find out whether it deserves trust. Argue
against it as a sharp reviewer would. If, after trying, it survives, say so plainly and say why.

Write, in this order:

1. **Strongest case against**: the best argument that the recommendation is wrong, grounded in the code (cite
   `path:line`, read in this session). If the developer stated a doubt, address it first and directly.
2. **Steelman each alternative**: for every other option, the situation in which it is clearly the better
   answer, and whether that situation holds here (evidence either way).
3. **Failure scenarios**: two or three concrete ways the recommendation fails after it ships: the input or
   caller, what happens, who notices. Prefer real callers, tests and docs you found over hypotheticals.
4. **What the recommendation assumes that nobody checked**: list them.
5. **Read before you decide**: the 2-5 exact places (files with line ranges, tests, docs, changelog entries)
   that would settle the question, each with what to look for.
6. **Verdict**: holds / holds with a change (say which) / switch to option N. One sentence why.
7. **Your call**: end with two or three pointed questions the developer must be able to answer to choose
   well. Do not answer them.

No flattery, no hedging filler. About 500 words at most.
