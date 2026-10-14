# Merchants: extending and using it

How to add a language, a country pack or an ID type to the Merchants section,
the action palette its buttons use, and recipes for asking Claude (through
the Finlynq MCP connector) to help with the directory.

Everything here is data or one small file. None of it needs a migration, and
none of it changes payee encryption, `import_hash`, `normalizeForLookup` or
the stored matching keys.

## Add an interface language

1. Copy `src/lib/i18n/locales/en.ts` to `src/lib/i18n/locales/<code>.ts`
   (BCP 47 code, e.g. `pl`). Set `meta`:
   `{ code: "pl", name: "Polish", nativeName: "Polski", dir: "ltr" }`
   (`dir: "rtl"` for right-to-left scripts).
2. Translate `messages`. The format is a small ICU subset
   (`src/lib/i18n/format-message.ts`):
   - `{name}` inserts a variable.
   - `{n, plural, =0 {…} one {…} few {…} many {…} other {…}}` uses the
     language's CLDR plural categories; `#` is `n` formatted for the language.
   Keep the same variables as English in every key. Plural branches must not
   introduce variables the English text does not have.
3. Import it in `src/lib/i18n/registry.ts` and add it to `REAL`.
4. Run `npm run lint:i18n` and `npx vitest run tests/i18n-locales.test.ts`.
   They fail on a missing key, a different set of variables or plurals, or a
   key no code uses.

Before translating, check long strings and RTL layout with the pseudo
locales `en-XA` (stretched) and `ar-XB` (mirrored). Outside production they
are in the language picker, or in production with `NEXT_PUBLIC_I18N_PSEUDO=1`.

Server texts (MCP answers, reasons, CSV headers) use the same files with the
`srv.` prefix. The request's language comes from `resolveUiLocale`: the user's
choice, then `Accept-Language`, then English.

## Add a country pack

A country pack holds what is specific to a country, as data:
- type words, with the merchant type each one suggests;
- the bank's own operations;
- payment channels;
- the merchant-type starting set;
- MCC codes;
- the ID types in use;
- the transliteration it relies on.

The code is in `src/lib/payees/packs/`.

Packs stack in this order, and later ones win:
1. **UA**: the built-in behaviour, always on.
2. Built-in packs the person turns on, such as **EU / generic**.
3. Packs the person imported (up to 5).
4. The person's own words in the Studio settings.

There are two ways to add a pack:
- **As a person (no code):** go to Merchants → «Словники і пакети» → Country
  packs → «Import a pack…», pick a JSON file, check the preview and confirm.
  The pack is saved in the person's Payee Studio settings. Export works for
  any pack.
- **Built in:** add a file next to `packs/eu.ts` that exports a
  `CountryPack`, then list it in `BUILTIN_PACKS` in `packs/index.ts`.
  Built-in packs other than UA are off until the person turns them on.

The format, validated by `countryPackSchema`:

```json
{
  "format": "finlynq-country-pack",
  "version": 1,
  "id": "pl-basic",
  "country": "PL",
  "locale": "pl",
  "name": "Polska",
  "typeWords": [{ "word": "stacja paliw", "type": "fuel" }, { "word": "piekarnia" }],
  "bankOperations": ["prowizja*"],
  "channels": ["BLIK", "PayU"],
  "merchantTypes": [{ "group": "Paliwo", "code": "fuel" }],
  "mcc": { "5411": "grocery" },
  "idTypes": ["pl_nip", "pl_regon", "eu_vat", "iban", "card_last4"],
  "transliteration": []
}
```

Field notes:
- `type` and `mcc` values are merchant-type codes from
  `DEFAULT_MERCHANT_TYPES` (`grocery`, `fuel`, `cafe`, `restaurant`,
  `pharmacy` and so on). A word with an unknown code still counts as a type
  word without a type, and the import preview lists it.
- A `*` at the end of a bank operation matches any ending.
- `idTypes` are ids from the ID registry (next section).

A pack never carries personal data. The format has no place for names of
people, amounts, dates or notes, and unknown keys are dropped on import.

`tests/fixtures/pack-pl.json` is a working example, and
`tests/payees-p8-stage7.test.ts` shows it in use.

Known limits:
- `channels` are shown and exported, but channel detection (`channelOf`)
  still uses the fixed UA list.
- `merchantTypes` from a pack are shown, not seeded. The starting set is
  still the built-in one.

## Add an ID type

The registry is `src/lib/payees/id-registry.ts`. Each `IdType` has:
- `id` (`pl_nip`);
- `country` (ISO code, `EU`, or `*` for every country);
- `label` (as people write it);
- `person` (`true` for a private person's number, masked and never shared);
- `example` (a shape for the field);
- `validate(raw)`, which returns `{ ok, normalized, reason?: "format" | "checksum" }`;
- `mask(normalized)`.

To add one:
1. Write the check function (with its check digit when the number has one)
   and add an entry to `ID_TYPES`.
2. Name the id in the `idTypes` of the packs that use it.
3. Add valid and invalid examples to `tests/payees-p8-stage7.test.ts`.

A number that has the right format but fails the check digit is reported as
`checksum`, never accepted. The «Check a requisite» field in «Словники і
пакети» tries every ID type of the packs in force. The value is not stored.

What the registry knows today:

| id | Country | Label | Person | Check |
|---|---|---|---|---|
| ua_ipn | UA | ІПН / РНОКПП | yes | 10 digits, check digit |
| ua_edrpou | UA | ЄДРПОУ | no | 8 digits, check digit |
| pl_nip | PL | NIP | no | 10 digits, weights 6‑5‑7‑2‑3‑4‑5‑6‑7, mod 11 |
| pl_regon | PL | REGON | no | 9 or 14 digits, mod 11 |
| de_ustid | DE | USt-IdNr. | no | DE + 9 digits, ISO 7064 MOD 11,10 |
| eu_vat | EU | VAT | no | country prefix + national shape; PL / DE / XI check digit |
| us_ein | US | EIN | no | 9 digits, a valid IRS prefix |
| gb_vat | GB | VAT | no | 9 / 12 digits mod 97 (old and new scheme), GD / HA |
| gb_utr | GB | UTR | yes | 10 digits, mod 11 |
| iban | * | IBAN | no | mod 97 |
| card_last4 | * | •••• 0000 | no | 4 digits only; a full card number is refused |

The directory's stored kinds map onto the registry without data changes:
`tax_id` → `ua_ipn`, `edrpou` → `ua_edrpou`, `iban`, `card_last4`
(`KIND_TO_ID_TYPE`).

### Transliteration

Transliteration plugins live in `src/lib/payees/translit.ts`. A plugin has an
`id`, a `script` (ISO 15924), a `detect` regex and `toLatin`. Matching keys
use only `MATCHING_CHAIN` (today `["cyrl-uk"]`, the old Ukrainian table,
unchanged). Changing the chain changes every stored key, so it needs a
migration. A new script is one plugin object; `grek-el` is the registered
starter.

## The action palette

Every decision button in Merchants is an `ActionButton`
(`src/components/actions/action-button.tsx`). The intent sets both the colour
and the icon, and a label is always required, so the meaning never rests on
colour alone.

| Intent | Colour | Icon | Use for |
|---|---|---|---|
| confirm | green | ✓ | accept, make canonical, add to the directory |
| reject | red | ✕ | reject, delete, undo |
| open | blue | ↗ | open a profile, a list, the transactions |
| caution | amber | ! | needs your decision, or a risky change |
| neutral | grey | none | anything secondary |

- `soft` gives an outlined variant for secondary actions in a row.
- `danger` (on reject or caution) shows `summary`, what will change, next to
  the button.
- `iconOnly` keeps the label as the accessible name and the tooltip.

The colours are CSS tokens (`--action-confirm`, `--action-reject` and so on)
in `src/app/globals.css`, with light and dark values checked for contrast.
Use the tokens, never raw colours. On touch screens every button is at least
44 × 44 px.

Keyboard shortcuts (desktop; turn them off in the shortcut help):

| Key | Action |
|---|---|
| Ctrl / Cmd + K | merchant search, anywhere in the app |
| J / K | next / previous item in a list |
| Enter | confirm the focused item |
| Backspace | reject the focused item |
| O | open the focused item |
| ? | show the shortcuts |

Mass changes always go preview → confirm → one batch that can be undone for
30 days (Merchants → Changes).

## Recipes for Claude

These run in Claude with the Finlynq connector. Claude only proposes
**drafts**: nothing changes until you accept them in Merchants → Queue →
Drafts. The same recipes are on the Merchants overview («Ask Claude»), ready
to copy in the interface language.

- **Sort out unrecognized payees.** "In Finlynq, call `manage_payees
  op=review compact=true`. Take the 20 biggest unrecognized payees by sum and
  propose directory entries for them in one `op=propose` call: a canonical
  name, the type, the exact spellings from review as aliases, a one-sentence
  reason and a confidence. Never group a private person with a merchant. Do
  not approve anything."
- **Find duplicates to merge.** "Call `manage_payees op=clusters
  compact=true`. Tell me which clusters are the same merchant and which are
  not (`op=explain` when unsure), then propose the merges as drafts with
  `op=propose`. Leave private persons and sole proprietors to me."
- **Give types to untyped merchants.** "Call `manage_payees op=list
  view=entities merchant_type=untyped compact=true` and `op=merchant_types`.
  Suggest a merchant type for each entry as a table. Preview with
  `op=set_merchant_type` only after I agree."
- **Check after an import.** "Call `manage_payees op=coverage period=30d` and
  `op=queue`, then `op=review compact=true`. Tell me what the last import
  added that is not in the directory and propose drafts."
- **Find ЄДРПОУ and websites.** "Call `manage_payees op=list view=entities
  compact=true`. For companies only, look up the official website and ЄДРПОУ
  and propose them as drafts with `op=propose`. Say where each one comes
  from."

Tips:
- Long lists come in pages. Pass the `next_cursor` from the answer as
  `cursor`, and `compact=true` keeps answers short. `truncated: true` means
  there is more.
- `record_transaction` and `update_transaction` answer with
  `payee_resolution`: `matched`, `ambiguous`, `channel`, `not_in_directory`
  or `unavailable`. On `ambiguous`, ask which entry is meant.
- The connector's Merchants schema version (`p8.9`) is shown in Settings →
  AI access. If Claude's answers use fields the server does not know, the
  versions differ.
