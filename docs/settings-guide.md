# Settings guide: categories, tags and AI access

## Categorization

**Settings → Categorization** is split into **Expense / Income /
Reconciliation** tabs, each with a count. Every category shows how many
transactions use it and its note, and has a **⋯** menu:

- **Edit** — name, group, type, note
- **Move to group**
- **Merge into…**
- **Delete**

Each group header has **Rename group**, which relabels every category in the
group (renaming onto an existing group folds the two). Categories stay
two-level (group → category).

A category's **type can only change while no transactions or splits use it**,
because those rows were signed for the old type. `PUT /api/categories` answers
`409 category_in_use` otherwise; merge into a category of the other type
instead.

```http
GET  /api/categories?withCounts=1
POST /api/categories/merge   { "sourceId": 12, "targetId": 7, "dryRun": true }
```

A merge dry run returns per-type dependent counts, `budgetConflicts` and
`typeMismatch`. A merge is refused with `409` when both categories have a
budget for the same month, since budgets are unique per category and month.

## Tags

See [tags.md](tags.md) for filtering and bulk edits. **Settings → Tags** also
offers:

- a **List / Tree** switch; the tree reads `/` as a path and counts each
  transaction **once** per branch even when it carries several tags beneath it
- **Rename branch** — renames a prefix and every tag under it, and says first
  which renamed tags already exist (those merge)
- **Multiple spellings** — lists tags stored under several spellings, with
  **Normalize** / **Normalize all** to rewrite them to the most used one
- **Business** and **Personal** columns (a `NULL` flag counts as personal)

```http
GET  /api/tags?tree=1
POST /api/tags   { "op": "rename_prefix", "prefix": "team", "newPrefix": "staff", "dryRun": true }
POST /api/tags   { "op": "normalize" }
```

## AI & API access

**Settings → Integrations** keeps **Connected apps** (OAuth) and adds:

- **API key** — whether a key exists, when it was created, its last MCP
  activity, a warning when the key cannot read encrypted data, and
  **Regenerate** / **Create** (a new key is shown once).
- **AI activity** — the newest 100 MCP tool calls with an **Only writes**
  filter, plus per-client last activity and 7-day call/write counts. Clients are
  OAuth app names, "API key" or "Browser session".

The journal is stored in `mcp_activity_log`. **Tool arguments and decrypted data
are never stored**; `op` is kept only when it is a plain identifier. Logging is
fire-and-forget and can never change a tool call's result. Rows are removed with
the rest of the user's data when an account is deleted.
