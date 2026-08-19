# fork-automation

Default branch of `navarrotech/phase`, holding one workflow and nothing else.

`main` is a pure mirror of `phase-rs/phase@main` and never carries local
commits, so the weekly sync stays a true fast-forward. GitHub schedules
workflows only from a repository's default branch, so the automation lives
here instead.

| Branch            | Contents                                                    |
|-------------------|-------------------------------------------------------------|
| `fork-automation` | This README and `.github/workflows/sync-upstream.yml`.       |
| `main`            | Byte-identical to `phase-rs/phase@main`. Branch PRs off it.  |

The sync runs Mondays at 07:17 UTC and on demand:

    gh workflow run sync-upstream.yml --repo navarrotech/phase --ref fork-automation
