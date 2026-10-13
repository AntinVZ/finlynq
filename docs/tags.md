# Tags

Tags are free-text labels on transactions, stored as a comma-separated list
(`work,trip`). Slash-separated tags form a hierarchy (`team/alex` sits under
`team`).

## How tags are compared

Tags are one tag when they match after text normalisation: case, apostrophe
style, Unicode form, dash style and surrounding whitespace are ignored. `Acme`,
`acme ` and `ACME` are the same tag; the first spelling is kept. Matching is
always on **whole tags**, never substrings: `work` does not match `homework`.

See [text-matching.md](text-matching.md) for the exact rules.

## Filtering by several tags

Four optional filters are combined with every other filter by AND. Values are a
comma list or an array.

| Filter      | Meaning                                         |
|-------------|-------------------------------------------------|
| `tags_all`  | the transaction has **every** listed tag        |
| `tags_any`  | the transaction has **at least one** listed tag |
| `tags_none` | the transaction has **none** of the listed tags |
| `untagged`  | `true` = no tags at all                         |

Available on MCP `search_transactions`, the bulk filter, `get_income_statement`,
`get_spending_trends`, and `GET /api/transactions` as query parameters (a
parameter may repeat). Tags are matched after decryption, so the usual scan
limits and `truncated` flag apply.

## Adding or removing a tag in bulk

In the Transactions bulk bar, **Add tag** and **Remove tag** edit selected rows
without replacing their other tags (a new tag goes at the end).

```http
POST /api/transactions/bulk
{ "action": "add_tag", "ids": [101, 102], "tag": "reimbursable" }
```

`remove_tag` works the same way. At most 10,000 ids per request; a blank tag is
a `400`. In MCP, `preview_bulk_update` / `execute_bulk_update` accept
`changes.add_tags` and `changes.remove_tags` next to `changes.tags`; combining
`tags` with either is refused.

## Managing tags

**Settings → Tags** lists every tag with its transaction count, signed total in
your display currency, and first and last date. You can search, sort, and:

- **Rename** a tag. Renaming onto an existing tag merges the two.
- **Merge** several tags into one.
- **Delete** a tag. Transactions keep everything else; only the tag is removed.

A dialog states how many transactions will change before anything is written.
Operations over 10,000 transactions are refused with `409`.

```http
GET  /api/tags?business=all
POST /api/tags   { "op": "rename", "tag": "trip", "newName": "travel", "dryRun": true }
```

MCP exposes the same through `manage_tags` (`op: list | rename | merge |
delete`). Rename, merge and delete preview first and return a
`confirmationToken` that must be passed to execute.
