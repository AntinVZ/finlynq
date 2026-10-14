/**
 * @vitest-environment jsdom
 *
 * «Словники і пакети» → country packs (P8 stage 7): packs with their counts,
 * an imported pack is previewed before it is saved, and a requisite check
 * shows the matching ID types.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PacksCard } from "@/app/(app)/merchants/_components/packs-card";

const PL = readFileSync(join(__dirname, "..", "fixtures", "pack-pl.json"), "utf8");
const row = (over: Record<string, unknown>) => ({
  id: "ua", name: "Україна", country: "UA", locale: "uk", builtin: true, active: true,
  typeWords: 40, bankOperations: 10, channels: 8, merchantTypes: 22, mcc: 30,
  idTypes: [{ id: "ua_ipn", label: "ІПН / РНОКПП", known: true }], transliteration: [{ id: "cyrl-uk", available: true }], unknownTypeCodes: [],
  ...over,
});
const DATA = {
  packs: [row({}), row({ id: "eu", name: "EU / generic", country: "EU", locale: "en", active: false, idTypes: [{ id: "eu_vat", label: "VAT", known: true }], transliteration: [] })],
  idTypes: [{ id: "pl_nip", label: "NIP", country: "PL", person: false, example: "000-000-00-00" }],
  translit: [{ id: "cyrl-uk", script: "Cyrl", matching: true }],
};

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function setup() {
  const posts: Array<Record<string, unknown>> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/settings/locale") return { ok: true, json: async () => ({ language: "en", preference: { language: "auto" } }) };
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      posts.push(body);
      if (body.action === "import") {
        const preview = row({ id: "pl-test", name: "Polska (test)", country: "PL", locale: "pl", builtin: false, typeWords: 6, bankOperations: 2, channels: 3, merchantTypes: 0, mcc: 1, idTypes: [{ id: "pl_nip", label: "NIP", known: true }], transliteration: [] });
        return { ok: true, json: async () => (body.dryRun ? { preview, replaces: false } : { saved: preview, replaces: false }) };
      }
      if (body.action === "check") return { ok: true, json: async () => ({ matches: [{ id: "pl_nip", label: "NIP", country: "PL", person: false, check: { ok: true }, masked: "5261040828" }] }) };
      return { ok: true, json: async () => ({ ok: true }) };
    }
    return { ok: true, status: 200, json: async () => DATA };
  }));
  const onChanged = vi.fn();
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <PacksCard onChanged={onChanged} />
    </SWRConfig>,
  );
  return { posts, onChanged };
}

describe("PacksCard", () => {
  it("lists packs with what they bring; UA is always on, EU can be turned on", async () => {
    const { posts, onChanged } = setup();
    await waitFor(() => expect(screen.getByTestId("packs").textContent).toContain("EU / generic"));
    expect(screen.getByTestId("packs").textContent).toContain("Україна");
    fireEvent.click(screen.getAllByRole("button").find((b) => /turn on|увімкнути/i.test(b.textContent ?? ""))!);
    await waitFor(() => expect(posts).toContainEqual({ action: "enable", id: "eu" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(screen.getByTestId("id-registry").textContent).toContain("NIP");
  });

  it("previews an imported pack before saving it", async () => {
    const { posts } = setup();
    await waitFor(() => screen.getByTestId("packs"));
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File([PL], "pack-pl.json", { type: "application/json" });
    Object.defineProperty(file, "text", { value: async () => PL });
    fireEvent.change(input, { target: { files: [file] } });
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Polska (test)");
    expect(posts.at(-1)).toMatchObject({ action: "import", dryRun: true });
    fireEvent.click(screen.getAllByRole("button").find((b) => b.closest('[role="dialog"]') && !/cancel|скасувати/i.test(b.textContent ?? ""))!);
    await waitFor(() => expect(posts.at(-1)).toMatchObject({ action: "import" }));
    expect(posts.at(-1)?.dryRun).toBeUndefined();
  });

  it("checks a requisite against the packs in force", async () => {
    const { posts } = setup();
    await waitFor(() => screen.getByTestId("packs"));
    fireEvent.change(document.getElementById("pack-check")!, { target: { value: "526-104-08-28" } });
    fireEvent.keyDown(document.getElementById("pack-check")!, { key: "Enter" });
    await waitFor(() => expect(screen.getByTestId("id-matches").textContent).toContain("NIP"));
    expect(posts).toContainEqual({ action: "check", value: "526-104-08-28" });
  });
});
