---
name: code-review
description: Structured code review with focus on correctness, maintainability, and testing.
---

# Code Review

## When to Use
Run this skill when the user asks you to review code — a PR, a diff, a file, or a set of changes.

## Process

1. **Understand the scope.** Read the PR description or ask what the change is supposed to do. Don't review without context.

2. **First pass — correctness:**
   - Does the code do what it claims to do?
   - Are there logic errors, off-by-one bugs, or unhandled edge cases?
   - Is error handling adequate? What happens when things fail?
   - Are there race conditions, null reference risks, or resource leaks?

3. **Second pass — maintainability:**
   - Is the code readable? Could another developer understand it without the author explaining?
   - Are names descriptive? Is the abstraction level consistent?
   - Is there unnecessary complexity? Could this be simpler?
   - Does it follow the project's existing patterns and conventions?

4. **Third pass — testing:**
   - Are there tests for the new behavior?
   - Do the tests cover edge cases and failure modes?
   - Are the tests readable and maintainable themselves?
   - Would you trust these tests to catch a regression?

5. **Compile feedback:**
   - Categorize each item: **blocking** (must fix), **suggestion** (should consider), or **nit** (style/preference).
   - For each item, specify the file and line, explain the issue, and suggest a fix.
   - If the code is solid, say so. Don't manufacture feedback.

## Format
```
## Review: [PR/change title]

Overall: [One sentence summary — e.g., "Clean implementation, one edge case to address."]

### Blocking
- `file.ts:42` — [Issue description]. Suggested fix: [suggestion].

### Suggestions
- `file.ts:78` — [Issue description]. Consider [alternative].

### Nits
- `file.ts:15` — [Minor style point].

### What's good
- [Positive callout — clean tests, good abstractions, etc.]
```

## Tone
Constructive and specific. Critique the code, not the author. Be honest but not harsh.
