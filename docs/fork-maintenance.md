# Maintaining a fork

How this fork stays current with `finlynq/finlynq` while carrying its own
features, and how those features are sent upstream. The process is generic and
works for any fork of a project that uses a `dev` integration branch.

## Branches

| Branch                      | Purpose                                                        |
|-----------------------------|----------------------------------------------------------------|
| `main`                      | mirrors upstream `main` (releases); never receives fork work   |
| `sync/upstream-<version>`   | upstream `dev` merged with **all** fork features; what you deploy |
| `claude/<topic>-<id>`       | one working branch per feature session (kept for history)      |
| `pr/<n>-<topic>`            | clean, stacked branches cut from upstream `dev` for pull requests |

Feature branches use conventional prefixes (`feat/`, `fix/`, `docs/`, `chore/`)
and commit messages follow `type(scope): summary`, as in `CONTRIBUTING.md`.

## Syncing with a new upstream release

1. `git fetch upstream dev main --tags`
2. `git checkout -b sync/upstream-<version> <deployed branch>`
3. `git merge upstream/dev` and resolve conflicts. Most are additive (both
   sides keep their lines); keep the MCP tool-count constants consistent with
   `npm install`'s catalog guard, which prints the derived counts on drift.
4. Run the checks below, then deploy from the sync branch.

## Checks to run before every merge or pull request

Mirror upstream CI (`.github/workflows/ci.yml`):

```bash
npx tsc --noEmit
npm run lint                  # 0 errors
npm run audit:invariants      # new API routes must use apiHandler
npm run lint:tool-descriptions# MCP descriptions <= 900 chars
npx vitest run
npm run build                 # needs network access for web fonts
```

## Sending features upstream

- One feature per pull request, targeting `dev`.
- Features that build on one another are sent as a **stack**: branch `pr/2`
  from `pr/1`, and so on. Open them in order and rebase the next onto `dev`
  after each merge. State the dependency in the description.
- Fix CI failures in the **commit that introduced them** (`git commit --fixup`
  then `git rebase -i --autosquash`) so every pull request is green on its own.
- Ship documentation with the feature, using neutral examples (fictional
  payees and tags), never real names, accounts or employers.
- Sign the CLA when the bot asks (see `CLA.md`) and read its terms first.
