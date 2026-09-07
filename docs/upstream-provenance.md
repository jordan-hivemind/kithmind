# Upstream provenance

Checked 2026-09-06 against `flippyhead/ai-brain` main at commit
`0534744fdb7f366d38e89e44c82f3da22ae4c958`.

Kith Mind derives from Peter Brown's ai-brain. The intended license for
original Kith Mind work is MIT. The local LICENSE retains upstream attribution.

The upstream [plugin manifest](https://github.com/flippyhead/ai-brain/blob/0534744fdb7f366d38e89e44c82f3da22ae4c958/plugins/ai-brain/.claude-plugin/plugin.json)
contains an MIT declaration. The inspected root tree has no LICENSE file, the
root package metadata has no license declaration, and GitHub's repository
metadata reports no detected license. This does not establish that permission
is absent; it leaves the repository-wide scope unconfirmed.

Before presenting all inherited code as covered by a confirmed MIT grant,
obtain a repository-level license or written scope confirmation from the
upstream author. The existing local LICENSE assertion is not independent
evidence of the upstream grant. No author contact has been sent by the agent.
[GitHub's licensing guidance](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository)
explains why public visibility and a reuse license are separate matters.

The current upstream also contains an exporter absent from this checkout:
[`scripts/export-brain.mjs`](https://github.com/flippyhead/ai-brain/blob/0534744fdb7f366d38e89e44c82f3da22ae4c958/scripts/export-brain.mjs),
its tests, and `packages/convex/convex/models/export/`. It exports JSON records
and a lossy GBrain-compatible Markdown view. Evaluate it before building a
parallel export path. Porting requires review of its operator-only access,
consistent snapshot behavior, historical-record defaults, and the new family,
evidence and revision tables. It is not yet a tested Kith Mind backup/restore
implementation, and no live account export was run during this review.
