# Separate recall keywords from application decisions

Recall Keywords are used only to retrieve jobs into the candidate pool and preserve source traceability. After retrieval, Rule Boundaries and LLM Apply Decisions must evaluate the candidate profile, target role intent, and job description directly instead of treating the recall keyword as target-fit evidence.

This prevents a search query such as `Python backend internship` from making an unrelated or mismatched job look eligible just because it was retrieved by that query. The trade-off is that the agent may apply less aggressively, but real application decisions remain tied to semantic fit rather than brittle sourcing metadata.
