/**
 * @vitest-environment jsdom
 *
 * Settings → Tags (S2): business / personal columns, the "Multiple spellings"
 * filter with Normalize, and the "/" tree with a branch rename preview.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";
import { render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/react";
import { SWRConfig } from "swr";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));

import TagsSettingsPage from "@/app/(app)/settings/tags/page";

const tags = [
  {
    tag: "Agrotrade", key: "agrotrade", count: 3, firstDate: "2026-01-01", lastDate: "2026-03-01",
    spellings: [{ spelling: "Agrotrade", count: 2 }, { spelling: "agrotrade", count: 1 }],
    hasVariants: true, businessCount: 1, personalCount: 2, total: -20,
  },
  {
    tag: "колега/Шляхов", key: "колега/шляхов", count: 2, firstDate: null, lastDate: null,
    spellings: [{ spelling: "колега/Шляхов", count: 2 }], hasVariants: false, businessCount: 0, personalCount: 2, total: -5,
  },
];
const tree = [
  { path: "Agrotrade", key: "agrotrade", name: "Agrotrade", depth: 0, parentKey: null, isTag: true, count: 3, ownCount: 3, businessCount: 1, personalCount: 2, tagCount: 1, childCount: 0, total: -20 },
  { path: "колега", key: "колега", name: "колега", depth: 0, parentKey: null, isTag: false, count: 2, ownCount: 0, businessCount: 0, personalCount: 2, tagCount: 1, childCount: 1, total: -5 },
  { path: "колега/Шляхов", key: "колега/шляхов", name: "Шляхов", depth: 1, parentKey: "колега", isTag: true, count: 2, ownCount: 2, businessCount: 0, personalCount: 2, tagCount: 1, childCount: 0, total: -5 },
];

function setup() {
  const calls: Array<{ url: string; body: Record<string, unknown> | null }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { body?: string }) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url, body });
    if (url.startsWith("/api/tags?")) return { ok: true, json: async () => ({ tags, tree, currency: "CAD", truncated: false }) };
    if (body?.op === "rename_prefix") return { ok: true, json: async () => ({ affected: 2, tagCount: 1, collisions: [], tooLarge: false, truncated: false }) };
    if (body?.op === "normalize") return { ok: true, json: async () => ({ affected: 1, tags: [{ tag: "Agrotrade", variants: ["agrotrade"] }], tooLarge: false, truncated: false }) };
    return { ok: true, json: async () => ({}) };
  }));
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <TagsSettingsPage />
    </SWRConfig>,
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Settings → Tags", () => {
  it("asks for the tree and shows business / personal columns", async () => {
    const calls = setup();
    await screen.findAllByText("Agrotrade");
    expect(calls[0].url).toBe("/api/tags?business=all&tree=1");
    expect(screen.getByRole("columnheader", { name: "Business" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Personal" })).toBeTruthy();
  });

  it("filters to tags with several spellings and previews Normalize all", async () => {
    const calls = setup();
    await screen.findAllByText("Agrotrade");
    fireEvent.click(screen.getByRole("button", { name: /Multiple spellings \(1\)/ }));
    expect(screen.queryAllByText("колега/Шляхов")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Normalize all" }));
    await waitFor(() => expect(calls.some((c) => c.body?.op === "normalize" && c.body.dryRun === true)).toBe(true));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText(/"agrotrade"/);
  });

  it("tree view expands a branch and previews a branch rename", async () => {
    const calls = setup();
    await screen.findAllByText("Agrotrade");
    fireEvent.click(screen.getByRole("button", { name: "Tree" }));
    expect(screen.queryAllByText("Шляхов")).toHaveLength(0);
    fireEvent.click(screen.getAllByRole("button", { name: "Expand колега" })[0]);
    expect(screen.getAllByText("Шляхов").length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByRole("button", { name: "Rename branch" })[0]);
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByPlaceholderText("New name"), { target: { value: "друг" } });
    await waitFor(() =>
      expect(calls.some((c) => c.body?.op === "rename_prefix" && c.body.prefix === "колега" && c.body.newPrefix === "друг")).toBe(true),
    );
    await within(dialog).findByText(/across/);
  });
});
