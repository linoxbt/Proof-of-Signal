"use client";

// Reviewer session. Live: Supabase Auth email magic link; the access token is
// sent to the API as a Bearer token and RLS decides what the user may see.
// Demo: two fake reviewers so the two-person rule can be exercised.
import type { SupabaseClient } from "@supabase/supabase-js";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { IS_DEMO, MODE, SUPABASE_ANON_KEY, SUPABASE_URL } from "../config";
import { DEMO_REVIEWERS, type DemoReviewer } from "../demo/store";

export type SessionStatus = "loading" | "signed_out" | "signed_in" | "unavailable";

export interface ReviewerSession {
  status: SessionStatus;
  email: string | null;
  userId: string | null;
  token: string | null;
  isDemo: boolean;
  /** Sends a magic link (live) or signs in as demo reviewer A (demo). */
  signIn: (email: string) => Promise<void>;
  signOut: () => Promise<void>;
  demoReviewers: DemoReviewer[];
  switchDemoReviewer: (id: string) => void;
}

const Ctx = createContext<ReviewerSession | null>(null);

let supabaseClient: SupabaseClient | null = null;
async function getSupabase(): Promise<SupabaseClient | null> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  if (!supabaseClient) {
    const { createClient } = await import("@supabase/supabase-js");
    supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "pkce" },
    });
  }
  return supabaseClient;
}

const DEMO_KEY = "pos.demoReviewer";

export function ReviewerSessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SessionStatus>("loading");
  const [email, setEmail] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);

  const applyDemo = useCallback((reviewer: DemoReviewer | null) => {
    if (reviewer) {
      sessionStorage.setItem(DEMO_KEY, reviewer.id);
      setEmail(reviewer.email);
      setUserId(reviewer.id);
      setToken(reviewer.token);
      setStatus("signed_in");
    } else {
      sessionStorage.removeItem(DEMO_KEY);
      setEmail(null);
      setUserId(null);
      setToken(null);
      setStatus("signed_out");
    }
  }, []);

  useEffect(() => {
    if (IS_DEMO) {
      const saved = sessionStorage.getItem(DEMO_KEY);
      // The demo starts signed in as reviewer A so the review flow is clickable at once.
      const reviewer = saved === "" ? null : (DEMO_REVIEWERS.find((r) => r.id === saved) ?? DEMO_REVIEWERS[0]);
      queueMicrotask(() => applyDemo(reviewer));
      return;
    }
    if (MODE !== "live") {
      queueMicrotask(() => setStatus("unavailable"));
      return;
    }
    let unsub: (() => void) | undefined;
    let cancelled = false;
    getSupabase().then(async (sb) => {
      if (cancelled) return;
      if (!sb) {
        setStatus("unavailable");
        return;
      }
      const { data } = await sb.auth.getSession();
      if (cancelled) return;
      const s = data.session;
      setEmail(s?.user.email ?? null);
      setUserId(s?.user.id ?? null);
      setToken(s?.access_token ?? null);
      setStatus(s ? "signed_in" : "signed_out");
      const sub = sb.auth.onAuthStateChange((_event, session) => {
        setEmail(session?.user.email ?? null);
        setUserId(session?.user.id ?? null);
        setToken(session?.access_token ?? null);
        setStatus(session ? "signed_in" : "signed_out");
      });
      unsub = () => sub.data.subscription.unsubscribe();
    });
    return () => {
      cancelled = true;
      unsub?.();
    };
  }, [applyDemo]);

  const signIn = useCallback(
    async (address: string) => {
      if (IS_DEMO) {
        applyDemo(DEMO_REVIEWERS[0]);
        return;
      }
      const sb = await getSupabase();
      if (!sb) throw new Error("Sign-in is not configured (NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY).");
      const { error } = await sb.auth.signInWithOtp({
        email: address.trim(),
        options: { emailRedirectTo: `${window.location.origin}/review`, shouldCreateUser: false },
      });
      if (error) throw error;
    },
    [applyDemo],
  );

  const signOut = useCallback(async () => {
    if (IS_DEMO) {
      applyDemo(null);
      sessionStorage.setItem(DEMO_KEY, "");
      return;
    }
    const sb = await getSupabase();
    await sb?.auth.signOut();
  }, [applyDemo]);

  const switchDemoReviewer = useCallback(
    (id: string) => {
      const r = DEMO_REVIEWERS.find((x) => x.id === id);
      if (IS_DEMO && r) applyDemo(r);
    },
    [applyDemo],
  );

  const value = useMemo<ReviewerSession>(
    () => ({
      status,
      email,
      userId,
      token,
      isDemo: IS_DEMO,
      signIn,
      signOut,
      demoReviewers: IS_DEMO ? DEMO_REVIEWERS : [],
      switchDemoReviewer,
    }),
    [status, email, userId, token, signIn, signOut, switchDemoReviewer],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useReviewerSession(): ReviewerSession {
  const v = useContext(Ctx);
  if (!v) throw new Error("useReviewerSession must be used inside ReviewerSessionProvider");
  return v;
}
