# GeekGeekRun

GeekGeekRun is a desktop automation system for job-search and recruiting workflows on BOSS Zhipin. This glossary defines the domain language used when discussing automated job application decisions.

## Language

**Application Authorization**:
Permission for the job-seeker agent to perform a real application action, such as starting a chat or sending a greeting to a recruiter. Application Authorization must come from an LLM Apply Decision; deterministic rules may deny it but must not grant it.
_Avoid_: rule apply, keyword apply, auto-apply score

**LLM Apply Decision**:
A complete structured judgment that a job should be applied to after comparing the job description with the Candidate Profile and Target Role Intent. It may receive Recall Keyword metadata for traceability, but it must not depend on the keyword as a substitute for semantic job fit; malformed or incomplete LLM output is treated as uncertain rather than as authorization.
_Avoid_: keyword match, source keyword decision

**Rule Boundary**:
A deterministic policy boundary that blocks clearly out-of-scope job categories or explicit hard constraints, or records evidence for later judgment. A Rule Boundary may produce a skip decision for non-target occupation types, but it must not skip solely because of technology mentions, weak profile fit, or Recall Keyword mismatch.
_Avoid_: final apply rule, hard apply rule

**Recall Keyword**:
A search input used only to retrieve jobs into the candidate pool and preserve source traceability. After retrieval, Rule Boundaries and LLM Apply Decisions should rely on the candidate profile, target role intent, and job description rather than the Recall Keyword.
_Avoid_: decision keyword, keyword fit, source keyword decision

**Attention Technology**:
A technology mention that requires explicit LLM explanation because it may indicate a core stack mismatch. An Attention Technology is not a rejection rule; it only supports a skip decision when the job description makes it core or required and it does not fit the candidate profile or target role intent.
_Avoid_: rejected tech stack, hard reject keyword, blacklist technology

**Attention Technology Seed List**:
A small configured list of technology terms that forces an LLM explanation when encountered. The seed list is not exhaustive and is not the source of the Attention Technology judgment.
_Avoid_: complete tech blacklist, rejected stack list

**Target Role Intent**:
The candidate's stated direction for what kinds of roles they want to apply to. Target Role Intent defines the desired role direction, but it does not by itself prove that a job should be applied to.
_Avoid_: search keyword, job source, keyword intent

**Candidate Profile**:
The candidate facts used to judge whether a job fit is credible, including resume evidence, expected role, projects, experience, and relevant skills. Candidate Profile supports or weakens a Target Role Intent but is not a standalone application trigger.
_Avoid_: resume text dump, keyword profile, configured filter

**Decision Evidence**:
The non-secret information needed to explain why the agent skipped, deferred, or applied to a job. Decision Evidence includes job summaries, rule findings, LLM fit explanations, Attention Technology explanations, risk flags, and action outcomes.
_Avoid_: raw private data, opaque score

**Audit Record**:
A durable record of a job-agent run that preserves Decision Evidence and action outcomes without storing sensitive originals such as cookies, local storage, API keys, full resume text, greeting text, local resume image paths, or private local paths.
_Avoid_: raw browser state, full resume archive, secret log

**Job Match Guard**:
A verification step that ensures the browser job or chat target still matches the job that received Application Authorization. Fallback sending is allowed only when the guard can preserve that match.
_Avoid_: recent chat assumption, blind fallback send
