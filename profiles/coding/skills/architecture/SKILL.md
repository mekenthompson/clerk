---
name: architecture
description: Architecture planning, design discussions, and decision documentation.
---

# Architecture Planning

## When to Use
Run this skill when the user wants to design a new feature, plan a refactor, evaluate a technical approach, or document an architectural decision.

## Process

### For New Features / Systems

1. **Clarify requirements.** Before designing, confirm:
   - What problem are we solving?
   - What are the constraints (performance, timeline, team size, existing tech)?
   - What does success look like?

2. **Propose a design:**
   - **Overview**: One paragraph explaining the approach.
   - **Data model**: Key entities and their relationships.
   - **Components**: Major modules/services and their responsibilities.
   - **Interfaces**: How components communicate (APIs, events, shared state).
   - **Failure modes**: What can go wrong and how the system handles it.

3. **Present alternatives.** For non-trivial decisions, show at least 2 options with tradeoffs:
   - Option A: [approach] — Pros: [X, Y]. Cons: [Z].
   - Option B: [approach] — Pros: [X, Y]. Cons: [Z].
   - Recommendation: [which and why].

4. **Identify risks and open questions.** What don't we know yet? What assumptions are we making?

### For Refactors

1. **Document the current state.** What exists today and why is it a problem?
2. **Define the target state.** What should it look like after?
3. **Plan the migration.** How do we get from A to B incrementally? Can we do it without a big bang?
4. **Identify the blast radius.** What could break? How do we test the transition?

### Architecture Decision Records (ADRs)

When a significant decision is made, document it:

```
## ADR: [Title]
Date: [date]
Status: [proposed | accepted | deprecated]

### Context
[What situation prompted this decision?]

### Decision
[What did we decide?]

### Consequences
[What are the implications — positive and negative?]

### Alternatives Considered
[What else did we evaluate and why did we reject it?]
```

Save ADRs to memory so they can be referenced in future discussions.

## Principles
- Prefer boring, well-understood technology over novel approaches.
- Design for the team you have, not the team you wish you had.
- Optimize for changeability — most architectural decisions will need to evolve.
- Consider operational concerns from the start: monitoring, debugging, deployment, rollback.
- Don't over-design. Build for current needs with clear extension points, not speculative future requirements.
