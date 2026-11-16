---
name: why
description: Lay out the full case behind a recommended answer to an open IR question (reasoning, code evidence, assumptions, weakest link), so a developer can check it instead of trusting it. Use as `/why Q-n` on a ticket's questions.
---

# /why: the case for a recommendation

The developer wants to see exactly why an answer was recommended, so they can check it. Show your work; do not
sell it.

Write, in this order:

1. **Recommendation**: the recommended answer in one sentence.
2. **Reasoning**: the chain from facts to the recommendation, as numbered steps. Each step is either a fact you
   read (cite `path:line` and quote the relevant line or two) or an inference (mark it _inference_). Read every
   file you cite in this session; do not cite from memory.
3. **Assumptions**: what must be true for the recommendation to hold that the code does not prove (for example
   "no external caller relies on `mapOperator` returning `\"\"`"). For each: how the developer can check it
   (a search, a test to run, a person to ask).
4. **Weakest link**: the one step or assumption most likely to be wrong, and what changes if it is.
5. **Versus the alternatives**: one line per other option: when it would be the better choice.
6. **Confidence**: high, medium or low, and the single fact that would change it.

Keep it under about 400 words. No preamble, no summary of the question back to the developer.
