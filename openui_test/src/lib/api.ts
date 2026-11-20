/** No-login public mode: visitors chat without an account (backend PUBLIC_MODE=true). */
export const PUBLIC_MODE = process.env.NEXT_PUBLIC_PUBLIC_MODE === "true";

let visitorCookie: Promise<unknown> | null = null;

/**
 * fetch wrapper for calls to the FastAPI backend (via the /api rewrite).
 * A 401 means the session expired or was revoked: go back to the login page.
 * In public mode a 401 only means "staff only", so visitors stay put.
 */
export const authFetch: typeof fetch = async (input, init) => {
  // Public mode: /api/auth/me hands out the visitor cookie, so it must land before any other call.
  if (PUBLIC_MODE && typeof window !== "undefined") {
    await (visitorCookie ??= fetch("/api/auth/me", { credentials: "same-origin" }).catch(() => null));
  }
  const response = await fetch(input, { credentials: "same-origin", ...init });
  if (response.status === 401 && typeof window !== "undefined" && !PUBLIC_MODE) {
    window.location.assign("/login?expired=1");
  }
  return response;
};

export type SessionUser = {
  username: string;
  display_name: string;
  role: string;
  plan?: string;
  session_expires_at?: string;
};

export async function fetchCurrentUser(): Promise<SessionUser | null> {
  // Public mode goes through the cookie gate so two first-visit calls cannot mint two visitors.
  const response = await (PUBLIC_MODE ? authFetch : fetch)("/api/auth/me", { credentials: "same-origin" });
  if (!response.ok) return null;
  const data = (await response.json()) as { user: SessionUser };
  return data.user;
}

export async function logout(): Promise<void> {
  try {
    await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
  } finally {
    window.location.assign("/login");
  }
}

/** Error text from a FastAPI error body ({detail: {message}} or {error: {message}}). */
export async function errorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json();
    return body?.detail?.message ?? body?.error?.message ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Chat fetch: FastAPI errors ({detail: {message}}, e.g. the 429 "limit reached")
 * are re-sent as {message} so the chat shows the server's words, not "Request failed: 429".
 */
export const chatFetch: typeof fetch = async (input, init) => {
  const response = await authFetch(input, init);
  if (response.ok) return response;
  const message = await errorMessage(response, `Request failed: ${response.status}`);
  return new Response(JSON.stringify({ message }), { status: response.status, statusText: response.statusText });
};
