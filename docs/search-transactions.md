# Searching and filtering transactions

This guide describes how to find transactions with the MCP `search_transactions`
tool and the matching web/API filters, and how the All / Business / Personal
filter works in reports.

## Text filters

All text filters are case-insensitive and are combined with **AND**.

| Filter      | Matches                                                        |
|-------------|----------------------------------------------------------------|
| `payee`     | a substring of the payee field only                            |
| `note`      | a substring of the note only                                   |
| `search`    | payee **or** note **or** tags contain the text                 |
| `tags`      | a substring of the whole tag list                              |
| `tag_exact` | exactly one whole tag (`work` does not match `homework`)       |

Example: transactions from *Acme Coffee* whose note mentions "team":

```json
{ "payee": "acme coffee", "note": "team" }
```

Text filters run **after decryption** (payees, notes and tags are encrypted per
user), so they scan rows newest-first in pages. If the scan reaches its bound
before `limit` matches are found, the response carries `truncated: true`.
Narrow `start_date` / `end_date` or pass `account_id` to reach older rows.

## Amount and date filters

`min_amount` / `max_amount` compare the **signed** account amount. Expenses are
negative, so "spent between 500 and 1500" is:

```json
{ "min_amount": -1500, "max_amount": -500 }
```

## Business and personal rows

Each transaction has an `is_business` flag. A `NULL` flag counts as personal, so
Business + Personal always adds up to All.

- `business=true` — business rows only
- `business=false` — personal rows only
- `business=all` (default) — everything

The same parameter is accepted by `GET /api/transactions`, `GET /api/reports`,
`GET /api/reports/trends`, the bulk tools' shared filter, and the MCP
`get_income_statement` / `get_spending_trends` tools (which additionally accept
an exact `tag`). Every search result row includes `is_business`.

## Reports

The Reports page has a three-way **All / Business / Personal** control. `true`
is business-only, `false` is personal-only, and `all` (or no parameter) is every
transaction, so existing API callers see no change. The income statement's
`unrealized` block is holdings-based and is not affected by these filters.

## Bulk tools

The filter shared by `preview_bulk_update` / `execute_bulk_update`,
`preview_bulk_delete` / `execute_bulk_delete` and `*_categorize` supports
`payee_match`, `note_match`, `tag_exact`, `business` and signed
`min_amount` / `max_amount`.

Bulk text matching pages through the data instead of looking at one window. A
filter that matches more than **10,000** rows, or whose text scan stops after
**50,000** rows, returns `truncated: true` from the preview and **no
confirmation token**; execute refuses it. A bulk write therefore never lands on
a silently partial set.

## Limits at a glance

| Limit                                   | Value  |
|-----------------------------------------|--------|
| Rows decrypted per `search_transactions` call | 20,000 |
| Rows a bulk filter may match            | 10,000 |
| Rows a bulk text scan may read          | 50,000 |
