# Contributing to Kith Mind

Kith Mind welcomes focused, reviewable contributions. Start from a public
issue or an adopted document in `docs/plans/`; public clones do not need any
private tracker or owner account.

1. Create a branch named `task/<id>` or `codex/<topic>`.
2. Keep the change small and explain the user-visible behavior in the pull
   request.
3. Use only synthetic data in tests, examples, screenshots, and commits. Do
   not add personal, family, health, financial, account, credential, or
   production data.
4. Run the relevant checks. Run all of these before requesting review for code
   changes:

   ```
   pnpm lint
   pnpm check-types
   pnpm test:once
   pnpm build
   ```

5. Update the public plan when implementation changes an adopted design.

Changes to MCP authentication or authorization paths need a second-model
review. See [AGENTS.md](./AGENTS.md) for the affected paths and model-tier
guidance.

The inherited plugin publishing workflow is disabled outside the upstream
`flippyhead/ai-brain` repository. A Kith Mind release needs its own deliberate
distribution configuration before a plugin can be published.
