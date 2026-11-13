"use client";

import { useSyncExternalStore, type ReactNode } from "react";

const subscribe = () => () => {};

/**
 * Renders children only in the browser. Used for the sign-in screen so that
 * attributes injected by browser extensions (e.g. Edge autofill's
 * `fdprocessedid` on inputs and buttons) can't cause a hydration mismatch.
 */
export function ClientOnly({ children }: { children: ReactNode }) {
  const mounted = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  return mounted ? <>{children}</> : null;
}
