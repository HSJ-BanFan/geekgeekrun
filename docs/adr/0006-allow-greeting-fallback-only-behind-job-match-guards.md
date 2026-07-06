# Allow greeting fallback only behind job match guards

The job-seeker agent may fall back to a recent chat surface to send a greeting after a successful start-chat action, but only when a Job Match Guard can preserve the match between the chat target and the job that received Application Authorization. The agent must not send a greeting merely because a recent conversation exists.

This fallback improves delivery reliability across BOSS Zhipin page transitions, but it creates a wrong-recipient risk unless the authorized job and the chat target remain tied together.
