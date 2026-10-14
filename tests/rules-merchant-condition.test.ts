/**
 * P8 stage 10 (pure): `merchant` / `merchant_type` rule conditions, the
 * payment-channel marker, and the editor defaults.
 */
import { describe, it, expect } from "vitest";
import { evalCondition, matchesRule } from "@/lib/auto-categorize";
import { Condition, defaultConditionForField } from "@/lib/rules/schema";
import { rulesUseMerchant } from "@/lib/rules/merchant-context";
import { channelOf } from "@/lib/payees/type-words";
import { payeeMatchKey } from "@/lib/payees/match-key";

describe("merchant conditions", () => {
  it("parse, and default in the editor", () => {
    expect(Condition.safeParse({ field: "merchant", op: "is", entityId: 5 }).success).toBe(true);
    expect(Condition.safeParse({ field: "merchant_type", op: "is_not", typeId: 2 }).success).toBe(true);
    expect(Condition.safeParse({ field: "merchant", op: "contains", entityId: 5 }).success).toBe(false);
    expect(defaultConditionForField("merchant", 7)).toEqual({ field: "merchant", op: "is", entityId: 7 });
    expect(defaultConditionForField("merchant_type", 3)).toEqual({ field: "merchant_type", op: "is", typeId: 3 });
  });

  it("match a resolved payee; an unresolved one matches neither is nor is_not", () => {
    const is = { field: "merchant", op: "is", entityId: 5 } as const;
    const isNot = { field: "merchant", op: "is_not", entityId: 5 } as const;
    expect(evalCondition({ merchantEntityId: 5 }, is)).toBe(true);
    expect(evalCondition({ merchantEntityId: 6 }, isNot)).toBe(true);
    expect(evalCondition({}, is)).toBe(false);
    expect(evalCondition({ merchantEntityId: null }, isNot)).toBe(false);
    expect(evalCondition({ merchantTypeId: 2 }, { field: "merchant_type", op: "is", typeId: 2 })).toBe(true);
    const rule = { id: 1, name: "r", isActive: true, priority: 0, actions: [], conditions: { all: [is, { field: "amount", op: "lt", value: 0 } as const] } };
    expect(matchesRule({ merchantEntityId: 5, amount: -10 }, rule)).toBe(true);
    expect(matchesRule({ merchantEntityId: 5, amount: 10 }, rule)).toBe(false);
    expect(rulesUseMerchant([rule])).toBe(true);
    expect(rulesUseMerchant([{ conditions: { all: [{ field: "payee" }] } }])).toBe(false);
  });
});

describe("payment channels", () => {
  it("a payee that is only a channel is marked; a channel in front of a name is dropped from the key", () => {
    expect(channelOf("OTPC2C")).toBe("OTPC2C");
    expect(channelOf("P24 12345")).toBe("P24");
    expect(channelOf("MONODirect")).toBe("MONODirect");
    expect(channelOf("monodirect *1234")).toBe("MONODirect");
    expect(channelOf("P24 SILPO")).toBeNull();
    expect(channelOf("Сільпо")).toBeNull();
    expect(payeeMatchKey("P24 SILPO")).toBe(payeeMatchKey("SILPO"));
    expect(payeeMatchKey("MONODirect Rozetka")).toBe(payeeMatchKey("Rozetka"));
  });
});
