# Require LLM authorization for real job applications

Real job applications must be authorized by an LLM Apply Decision. Deterministic rules may block clearly out-of-scope jobs and collect evidence, but they must not grant Application Authorization because keyword matches and fixed rule scores cannot reliably account for the candidate profile, target intent, keyword context, and job description together.

This trades speed and determinism for a stricter safety boundary around real recruiter contact. A job may remain uncertain without LLM output, but the agent avoids applying based only on brittle keyword or stack matches.
