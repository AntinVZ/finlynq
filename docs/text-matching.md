# Text matching

Everywhere Finlynq compares text you type with stored data (search filters,
category and account names, rules, tags) it normalises both sides first, so
formatting differences do not hide matches.

## Normalisation rules

`normalizeForMatch` (`src/lib/text-normalize.ts`) applies, in order:

1. Unicode **NFC** composition
2. `toLowerCase()`
3. every apostrophe variant (`'` `’` `ʼ` `‘` `` ` `` `´`) → `'`
4. every dash U+2010–U+2015 and the minus sign U+2212 → `-`
5. runs of whitespace → one space; zero-width characters removed
6. trim

It deliberately does **not** fold between alphabets (Latin `C` and Cyrillic `С`
stay different) and does not strip diacritics.

## Examples

| You search for | Also matches                                   |
|----------------|------------------------------------------------|
| `o'brien`      | `O’Brien` (typographic apostrophe)             |
| `acme-coffee`  | `ACME–Coffee` (en dash, different letter case) |
| `café`         | `café` stored as `e` + a combining accent      |

Whitespace runs collapse to one space, but a space is not a dash: `Acme Coffee`
and `acme-coffee` remain different.

## Where it is used

MCP text filters (`search_transactions` and the bulk tools), whole-tag
matching, `GET /api/transactions` text filters, rule `contains` / `exact`
conditions, category suggestions from payee history, and the account / category
/ holding name resolvers. Regular-expression rule conditions are unchanged.

## Encrypted names

Name lookups use a stored hash. Stored hashes and `normalizeForLookup` are
**unchanged**; reads that look a name up by hash now check a small set of
candidate hashes (the canonical one plus apostrophe and NFC/NFD spellings), and
writes are unchanged.
