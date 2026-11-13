---
paths:
  - "**/test/**"
  - "**/e2e/**"
  - "**/*.test.ts"
  - "**/*.test.tsx"
---

# Test rules

- Write tests from the contract and the IR slice, before the implementation. They must fail first.
- Assert what the contract and acceptance criteria say, not what the code currently does.
- One behaviour per test; the test name states the behaviour in plain words.
- No snapshot-only tests for logic. No sleeping; use fake timers.
- A test that has never been seen red does not count (docs/TESTING.md#seen-red).
