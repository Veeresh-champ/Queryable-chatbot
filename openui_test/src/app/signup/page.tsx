"use client";

import { Suspense } from "react";

import { AuthScreen } from "@/components/auth-screen";
import { ClientOnly } from "@/components/client-only";

export default function SignupPage() {
  return (
    <ClientOnly>
      <Suspense>
        <AuthScreen initialMode="signup" />
      </Suspense>
    </ClientOnly>
  );
}
