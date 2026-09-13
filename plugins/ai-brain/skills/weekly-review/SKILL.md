---
name: weekly-review
description: Weekly synthesis of your brain thoughts and facts. Surfaces themes, open loops, and recommendations. Every claim is cited back to its source.
---

# Weekly Review

A weekly synthesis that cross-references the week's thoughts against what your
brain already holds, to surface what you'd miss reading either one alone.

Every claim in the output must be grounded in a source — cite structured facts as `fact:<id>` and thoughts as `thought:<id>`.

## Workflow

### Step 1: Establish the Week's Time Window

Compute the start of the week as an epoch-ms timestamp.

- "This week" = from 7 days ago at 00:00 local time to now.
- Convert to epoch ms: `Date.now() - 7 * 24 * 60 * 60 * 1000` (rounded down to the start of the day).

Call this `weekStartMs`.

### Step 2: Pull the Week's Timeline

Call `mcp__ai-brain__timeline_thoughts` with:

- `aroundMs`: `weekStartMs`
- `before`: `0`
- `after`: `50`

This returns up to 50 compact index rows in chronological order for thoughts captured since the start of the week.

If the array is empty, tell the user: "Your brain has no thoughts captured this week. Try capturing some thoughts, or run `/brain-init` if your brain is empty." Then stop.

### Step 3: Hydrate Noteworthy Thoughts

From the week's timeline (Step 2), select up to 10 thoughts that look most substantive (by `summary` + `snippet` + `topics`) — the ones you'll want to cite in the synthesis.

Call `mcp__ai-brain__get_thoughts` with `ids: [<up to 10 ids>]`. Only these hydrated results can be quoted or paraphrased in the synthesis. The rest of the timeline is still referenceable by `thought:<id>` + summary.

### Step 4: Produce the Review

Generate a report with these 4 sections. Each section should be concise — the entire review should be scannable in 2 minutes. **Every factual claim must cite its source.**

---

**This Week in 30 Seconds**

2-3 sentence headline summary. What was the dominant theme? What stands out?

Cite 2-3 anchor thoughts: `thought:<id>`.

---

**Knowledge Captured**

Review the themes from saved thoughts this week. Cite each theme to an anchor thought.

Highlight:

- Repeated thought topics — building momentum on a theme — cite 2-3 `thought:<id>` examples.
- Cross-domain connections — thoughts from different contexts that might be related — cite the connected thoughts.

---

**Open Loops**

Aggregate unfinished threads from the week's thoughts:

- Decisions mentioned in thoughts that lack clear resolution — cite the `thought:<id>` where the decision was raised.
- Commitments captured without a recorded outcome — cite the `thought:<id>`.

---

**Next Week**

2-3 specific, actionable recommendations based on the above. Be forward-looking, not retrospective. Reference specific projects, people, or decisions — with citations — when possible.

---

### Step 5: Offer to Save

After presenting the review, ask:
"Want me to save a summary of this review to your brain? This helps track trends across weeks."

If yes, save a condensed version via `mcp__ai-brain__capture_thought` with format:
"Weekly review (week of [ISO date]): [2-3 sentence summary of key themes and the top recommendation]. Grounded in: thought:<id1>, thought:<id2>."

Pass `sourceType: user_confirmed`. Keep the review to one coherent weekly retrospective rather than adding unrelated personal facts.

Return the new `thought:<id>` to the user so they can find this review later via `/brain-thread` or `/brain-context`.
