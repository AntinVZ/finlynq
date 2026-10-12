/**
 * @vitest-environment jsdom
 *
 * /settings/payees/[id] — P5c website + logo card.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock("next/navigation", () => ({ useParams: () => ({ id: "5" }), useRouter: () => ({ push: vi.fn() }) }));

import PayeeEntityPage from "@/app/(app)/settings/payees/[id]/page";

const entityResponse = (over: Record<string, unknown> = {}) => ({
  entity: {
    id: 5, name: "Епіцентр", type: "retail", note: null, defaultCategoryId: null, website: "https://epicentrk.ua", logo: null,
    aliases: [{ id: 1, pattern: "Епіцентр", mode: "exact", source: "canonical" }], identifiers: [], ...over,
  },
  spellings: [], pending: { total: 0, byTable: {}, changes: [] }, history: [], categories: [], currency: "UAH",
});

function renderEntityPage(response: unknown, settings: Record<string, unknown> = { advancedMode: false, identifierKinds: [] }) {
  const calls: Array<{ url: string; body: Record<string, unknown> | null }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { body?: string }) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url, body });
    if (url === "/api/payees/settings") return { ok: true, json: async () => settings };
    if (url === "/api/payees" && body) {
      return { ok: true, json: async () => ({ op: body.op, batchId: null, entity: null, created: false, aliasesAdded: [], aliasesRemoved: 0, identifiersAdded: [], identifiersRemoved: 0, entitiesRemoved: 0, rows: { total: 0, byTable: { transactions: 0, recurring: 0, staged: 0 }, changes: [], conflicts: [], truncated: false }, warnings: [], blocked: null }) };
    }
    return { ok: true, json: async () => response };
  }));
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <PayeeEntityPage />
    </SWRConfig>,
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("payee entity page — website and logo", () => {
  it("links the website safely and shows initials without a logo", async () => {
    renderEntityPage(entityResponse());
    const link = await screen.findByRole("link", { name: "epicentrk.ua" });
    expect(link.getAttribute("href")).toBe("https://epicentrk.ua");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer nofollow");
    expect(screen.getByText("Е")).toBeTruthy(); // initials avatar
  });

  it("refuses a logo over 20 KB or of the wrong type before sending it", async () => {
    const calls = renderEntityPage(entityResponse());
    await screen.findByRole("link", { name: "epicentrk.ua" });
    const input = screen.getByLabelText("Logo file") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File([new Uint8Array(30 * 1024)], "big.png", { type: "image/png" })] } });
    expect(await screen.findByText(/the limit is 20 KB/)).toBeTruthy();
    fireEvent.change(input, { target: { files: [new File(["<svg/>"], "x.svg", { type: "image/svg+xml" })] } });
    expect(await screen.findByText(/SVG is not allowed/)).toBeTruthy();
    expect(calls.some((c) => c.body && "logo" in c.body)).toBe(false);
  });

  it("saves a website after a preview", async () => {
    const calls = renderEntityPage(entityResponse({ website: null }));
    fireEvent.click(await screen.findByRole("button", { name: "Add" }));
    fireEvent.change(screen.getByLabelText("Website"), { target: { value: "silpo.ua" } });
    fireEvent.click(screen.getByRole("button", { name: "Save…" }));
    await waitFor(() => expect(calls.some((c) => c.body?.op === "update" && c.body.website === "silpo.ua" && c.body.dryRun === true)).toBe(true));
  });
});

describe("payee entity page — requisites (P5f)", () => {
  const settings = { advancedMode: true, identifierKinds: ["iban", "tax_id", "edrpou", "card_last4", "crypto_wallet"] };
  const cards = [
    { id: 1, kind: "card_last4", value: "1234", label: "Mono black", bank: "monobank", currency: "UAH", isPrimary: true, isActive: true },
    { id: 2, kind: "card_last4", value: "4321", label: "Privat", bank: null, currency: null, isPrimary: false, isActive: false },
    { id: 3, kind: "iban", value: "UA213223130000026007233566001", label: "rent", bank: null, currency: "UAH", isPrimary: false, isActive: true },
  ];

  it("groups several cards and accounts with labels, primary and inactive; offers only the kinds that fit a person", async () => {
    renderEntityPage(entityResponse({ type: "person", identifiers: cards }), settings);
    const cardsGroup = await screen.findByRole("region", { name: "Cards (last 4 digits)" });
    expect(cardsGroup.textContent).toMatch(/•••• 1234Mono blackmonobankUAHPrimary/);
    expect(cardsGroup.textContent).toMatch(/•••• 4321PrivatInactive/);
    expect(screen.getByRole("region", { name: "IBAN accounts" }).textContent).toMatch(/UA213223130000026007233566001rent/);
    const kinds = [...(screen.getByLabelText("Requisite kind") as HTMLSelectElement).options].map((o) => o.value);
    expect(kinds).toContain("tax_id");
    expect(kinds).not.toContain("edrpou");
  });

  it("hints when a code doesn't fit, and previews add / deactivate", async () => {
    const calls = renderEntityPage(entityResponse({ type: "person", identifiers: cards }), settings);
    await screen.findByRole("region", { name: "Cards (last 4 digits)" });
    fireEvent.change(screen.getByLabelText("Requisite kind"), { target: { value: "tax_id" } });
    fireEvent.change(screen.getByLabelText("Requisite value"), { target: { value: "14360570" } });
    expect(screen.getByText(/looks like an EDRPOU/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Requisite value"), { target: { value: "3123456789" } });
    fireEvent.change(screen.getByLabelText("New requisite label"), { target: { value: "ІПН" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Add…" }).at(-1)!);
    await waitFor(() => expect(calls.some((c) => c.body?.op === "identifiers" && (c.body.add as Array<{ kind: string; value: string; label: string }>)?.[0]?.value === "3123456789")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Deactivate" })[0]); // IBAN accounts come first for a person
    await waitFor(() => expect(calls.some((c) => c.body?.op === "identifiers" && JSON.stringify(c.body.deactivate) === "[3]")).toBe(true));
  });

  it("a company gets EDRPOU and no ІПН", async () => {
    renderEntityPage(entityResponse({ type: "company", identifiers: [] }), settings);
    await screen.findByText("Requisites");
    const kinds = [...(screen.getByLabelText("Requisite kind") as HTMLSelectElement).options].map((o) => o.value);
    expect(kinds).toContain("edrpou");
    expect(kinds).not.toContain("tax_id");
  });
});

