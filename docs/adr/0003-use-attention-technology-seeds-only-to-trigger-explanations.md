# Use attention technology seeds only to trigger explanations

The job-seeker agent keeps a small Attention Technology Seed List to force an LLM explanation when high-risk technology terms appear in a job description. The seed list is not exhaustive, is not a blacklist, and must not be treated as the source of the final Attention Technology judgment.

This preserves useful scrutiny for terms that have historically caused mismatches without attempting to enumerate every possible Attention Technology. The trade-off is that some unseeded Attention Technology mismatches rely entirely on the LLM's semantic reading of the job description, but the system avoids turning an open-ended judgment into brittle Recall Keyword policy.
