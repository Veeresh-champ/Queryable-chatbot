"use client";

import { Suspense } from "react";

import { AuthScreen } from "@/components/auth-screen";
import { ClientOnly } from "@/components/client-only";

export default function LoginPage() {
  return (
    <ClientOnly>
      <Suspense>
        <AuthScreen initialMode="signin" />
      </Suspense>
    </ClientOnly>
  );
}
