/**
 * An in-memory next/navigation for component tests (P8): useSearchParams
 * follows router.replace / push, so pages that keep their state in the URL
 * work under jsdom.
 *
 *   vi.mock("next/navigation", async () => (await import("../helpers/next-navigation")).navigationMock);
 *   beforeEach(() => resetNavigation());
 */
import { useMemo, useSyncExternalStore } from "react";

let search = "";
let pathname = "/merchants";
let params: Record<string, string> = {};
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const navigationCalls: string[] = [];

function go(href: string) {
  navigationCalls.push(href);
  const [path, qs] = href.split("?");
  if (path) pathname = path;
  search = qs ?? "";
  emit();
}

const router = { replace: go, push: go, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} };

export function resetNavigation(opts: { pathname?: string; search?: string; params?: Record<string, string> } = {}) {
  pathname = opts.pathname ?? "/merchants";
  search = opts.search ?? "";
  params = opts.params ?? {};
  navigationCalls.length = 0;
  emit();
}

export const navigationMock = {
  useSearchParams: () => {
    const s = useSyncExternalStore(subscribe, () => search, () => search);
    return useMemo(() => new URLSearchParams(s), [s]);
  },
  usePathname: () => useSyncExternalStore(subscribe, () => pathname, () => pathname),
  useRouter: () => router,
  useParams: () => params,
  redirect: (href: string) => go(href),
  notFound: () => {
    throw new Error("notFound");
  },
};
