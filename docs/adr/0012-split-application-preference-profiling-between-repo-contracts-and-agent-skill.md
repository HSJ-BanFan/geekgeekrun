# Split application preference profiling between repo contracts and agent skill

---
status: accepted
---

Application preference profiling will keep deterministic cleaning, Preference Evidence Package schema, Application Preference Profile schema, artifact persistence, CLI/sidecar commands, and tests inside the repository, while the agent skill owns the conversational Preference Clarification Session and user-facing interview strategy. This preserves reproducible, testable data contracts for future automation while still allowing an LLM-guided conversation to resolve sparse, noisy, or conflicting preference evidence.

**Considered Options**

- Implement the whole capability as an agent skill.
- Implement the whole capability as a static CLI report.
- Split stable data contracts into the repo and interactive preference clarification into a skill.

**Consequences**

The skill may orchestrate repo commands and explain or refine the resulting Application Preference Profile, but it must not become the only place where cleaning rules, schema shape, artifact safety, or profile persistence live. Repo commands remain responsible for redacted deterministic evidence packaging and testable profile output; the skill remains responsible for asking one targeted clarification question at a time and helping the user correct the profile.
