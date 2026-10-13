# Business and personal views

Finlynq can separate business money from personal money without separate
accounts. A transaction is business when its `is_business` flag is set; a
`NULL` flag counts as personal.

## Usage mode

**Settings → Usage mode** asks one question: *Do you track business money too?*

- **Personal only** (default): business features stay out of the way.
- **Personal and business**: a switch at the top of every app page picks
  **All / Business / Personal**.

In personal mode the switch is hidden and the effective scope is always **All**,
so a scope left over from earlier can never hide transactions.

Both choices are per-user rows in the existing `settings` table
(`usage_mode` = `personal` | `business_too`; `view_scope` = `all` | `business`
| `personal`). No migration is needed.

```http
GET /api/settings/usage-mode        PUT /api/settings/usage-mode
GET /api/settings/view-scope        PUT /api/settings/view-scope
```

Any other value is rejected with `400`. MCP tools do **not** read `view_scope`;
they take an explicit `business` parameter.

## Per-page override

Reports and Transactions start on the global scope and follow it. Choosing a
different value on the page changes **only that page**: a "Scope changed on this
page" notice and a **Reset to global** button appear, and the override is never
saved. Choosing the global value again clears it.

Transactions sends `business=` to `GET /api/transactions` only when the scope is
not All, so other URLs are unchanged. The calendar's totals use the same scope
through an optional `business` parameter on `GET /api/transactions/calendar`.

## Dashboard

Widgets built from **transactions** follow the scope and carry a small label:
monthly income and expenses, budgets, savings rate, the weekly recap, spending
by category and similar.

Widgets built from **balances** do not, because an account is not business or
personal (single transactions are): net worth, net worth over time, financial
health and debt-to-income show an "All accounts" label with the reason while
the scope is not All.

`GET /api/dashboard`, `/api/recap`, `/api/health-score` and `/api/insights`
accept an optional `business=true|false|all` and echo what they applied. On
`/api/health-score` it only scopes the headline `savingsRatePct`; the score
itself stays whole-picture.

## Choosing a scope for a report

| You want to see…                         | Use          |
|------------------------------------------|--------------|
| Everything                               | All          |
| Only transactions flagged business       | Business     |
| Everything not flagged business          | Personal     |
