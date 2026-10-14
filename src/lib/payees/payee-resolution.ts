/**
 * `payee_resolution` for MCP record / update (P8 stage 9): how the payee a
 * model wrote resolves in the Merchants directory, so it can tell the user
 * «saved as Епіцентр» or offer to add a new merchant — without a second
 * call. Read only: what is stored is decided by the import hint as before
 * (`makePayeeHinter`); this only reports it.
 */
import { matcherFor } from "./resolve-hint";
import { spellingOf, type PayeeExecutor } from "./scan";
import { channelOf } from "./type-words";

export type PayeeResolution =
  | { status: "matched"; entity_id: number; name: string; via: string; stored_as: string; renamed: boolean }
  | { status: "ambiguous"; entity_ids: number[]; names: string[]; stored_as: string }
  | { status: "channel"; channel: string; stored_as: string }
  | { status: "not_in_directory"; stored_as: string; hint: string }
  | { status: "unavailable"; stored_as: string };

export async function resolvePayeeForMcp(opts: {
  executor: PayeeExecutor;
  userId: string;
  dek: Buffer | null | undefined;
  payee: string;
  /** What was (or would be) stored after the import hint. */
  storedAs: string;
}): Promise<PayeeResolution | null> {
  const payee = opts.payee.trim();
  if (!payee) return null;
  if (!opts.dek) return { status: "unavailable", stored_as: opts.storedAs };
  try {
    const channel = channelOf(payee);
    const matcher = await matcherFor({ executor: opts.executor, userId: opts.userId, dek: opts.dek });
    const m = matcher.match(spellingOf(payee));
    if (m.kind === "match") return { status: "matched", entity_id: m.entityId, name: m.name, via: m.via, stored_as: opts.storedAs, renamed: opts.storedAs !== opts.payee };
    if (m.kind === "ambiguous") return { status: "ambiguous", entity_ids: m.entityIds, names: m.names, stored_as: opts.storedAs };
    if (channel) return { status: "channel", channel, stored_as: opts.storedAs };
    return {
      status: "not_in_directory",
      stored_as: opts.storedAs,
      hint: "Not in the Merchants directory. If the user wants it there: manage_payees op=create name=… (or op=alias_add to an existing entry).",
    };
  } catch {
    return { status: "unavailable", stored_as: opts.storedAs };
  }
}
