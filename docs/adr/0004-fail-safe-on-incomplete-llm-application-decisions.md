# Fail safe on incomplete LLM application decisions

The job-seeker agent treats malformed, missing, or incomplete LLM output as `uncertain` and does not perform a real application action. A real application requires a complete LLM Apply Decision, including the requested fit explanations and technology-stack assessment when relevant.

This may cause the agent to skip or defer some valid opportunities when the LLM response is poor, but it prevents malformed JSON, missing fields, or shallow reasoning from being interpreted as Application Authorization.
