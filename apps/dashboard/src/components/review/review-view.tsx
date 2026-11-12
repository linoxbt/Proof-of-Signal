"use client";

import { CheckCircle2, LogOut, Mail } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { ErrorBox, LoadingLine } from "@/components/load-state";
import { DemoTimeline } from "@/components/night/demo-timeline";
import { useDemoStepParam } from "@/components/night/use-demo-step-param";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label, Segmented, Select, Textarea } from "@/components/ui/field";
import { api } from "@/lib/api";
import { ApiError } from "@/lib/api/client";
import type { Flag, FlagClass, ReviewDecision, ReviewStatus } from "@/lib/api/types";
import { useReviewerSession } from "@/lib/auth/session";
import { formatMinutes } from "@/lib/format";
import { useApiData, useDemoVersion } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { EvidenceCard, TwoPersonState } from "./evidence-card";

const QUEUE_CLASSES: FlagClass[] = ["UNEXPLAINED_DELAY", "WATCH"];
const OPEN: ReviewStatus[] = ["unreviewed", "awaiting_second"];
const ALL: ReviewStatus[] = ["unreviewed", "awaiting_second", "concern_confirmed", "explained", "dismissed"];

export function ReviewView() {
  const t = useTranslations("review");
  const session = useReviewerSession();
  useDemoStepParam();

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold sm:text-3xl">{t("title")}</h1>
          <p className="mt-1 max-w-3xl text-muted-foreground">{t("intro")}</p>
        </div>
        {session.status === "signed_in" ? <SessionBar /> : null}
      </div>
      {session.isDemo ? <DemoTimeline /> : null}
      {session.status === "loading" ? <LoadingLine /> : null}
      {session.status === "unavailable" ? <ErrorBox error={new Error(t("unavailable"))} /> : null}
      {session.status === "signed_out" ? <SignInCard /> : null}
      {session.status === "signed_in" && session.token ? <Queue token={session.token} userId={session.userId} /> : null}
    </div>
  );
}

function SessionBar() {
  const t = useTranslations();
  const s = useReviewerSession();
  return (
    <div className="flex flex-wrap items-end gap-2">
      {s.isDemo ? (
        <div className="flex flex-col gap-1">
          <Label htmlFor="demo-reviewer">
            {t("demo.reviewerSwitch")} <span className="text-muted-foreground">({t("demo.reviewerSession")})</span>
          </Label>
          <Select id="demo-reviewer" value={s.userId ?? ""} onChange={(e) => s.switchDemoReviewer(e.target.value)} className="sm:w-64">
            {s.demoReviewers.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </Select>
          <p className="max-w-64 text-xs text-muted-foreground">{t("demo.reviewerHelp")}</p>
        </div>
      ) : (
        <span className="text-sm text-muted-foreground">{t("review.signedInAs", { email: s.email ?? "" })}</span>
      )}
      <Button variant="outline" onClick={() => void s.signOut()}>
        <LogOut aria-hidden="true" />
        {t("review.signOut")}
      </Button>
    </div>
  );
}

function SignInCard() {
  const t = useTranslations("review");
  const s = useReviewerSession();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Card className="max-w-lg">
      <CardHeader>
        <CardTitle>{t("signInTitle")}</CardTitle>
        <CardDescription>{t("signInHelp")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setErr(null);
            setBusy(true);
            try {
              await s.signIn(email);
              setSent(!s.isDemo);
            } catch (x) {
              setErr(x instanceof Error ? x.message : String(x));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Label htmlFor="email">{t("email")}</Label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            required={!s.isDemo}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={s.isDemo ? "reviewer.a@demo.invalid" : ""}
          />
          <Button type="submit" disabled={busy}>
            <Mail aria-hidden="true" />
            {t("sendLink")}
          </Button>
          {sent ? (
            <p role="status" className="flex items-center gap-2">
              <CheckCircle2 className="size-5" aria-hidden="true" />
              {t("linkSent")}
            </p>
          ) : null}
          {err ? <ErrorBox error={new Error(err)} /> : null}
        </form>
      </CardContent>
    </Card>
  );
}

function Queue({ token, userId }: { token: string; userId: string | null }) {
  const t = useTranslations("review");
  const tc = useTranslations("common");
  const params = useSearchParams();
  const demoVersion = useDemoVersion();
  const [classFilter, setClassFilter] = useState<"both" | FlagClass>("both");
  const [statusFilter, setStatusFilter] = useState<"open" | "all">("open");
  const [selected, setSelected] = useState<string | null>(params.get("flag"));

  const elections = useApiData("elections", (s) => api.elections(s));
  const electionId = params.get("election") ?? elections.data?.elections[0]?.id ?? null;
  const classes = classFilter === "both" ? QUEUE_CLASSES : [classFilter];
  const statuses = statusFilter === "open" ? OPEN : ALL;
  const flags = useApiData(
    electionId ? `flags:${electionId}:${token}:${classes.join()}:${statuses.join()}:${demoVersion}` : null,
    (s) => api.flags(electionId!, { classes, statuses }, token, s),
  );

  const list = flags.data?.flags ?? [];
  const current = list.find((f) => f.id === selected) ?? list[0] ?? null;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Segmented
          name="status"
          label={t("statusFilter")}
          value={statusFilter}
          onChange={setStatusFilter}
          options={[
            { value: "open", label: t("openOnly") },
            { value: "all", label: t("allStatuses") },
          ]}
        />
        <div className="flex flex-col gap-1">
          <Label htmlFor="class-filter">{t("classFilter")}</Label>
          <Select id="class-filter" value={classFilter} onChange={(e) => setClassFilter(e.target.value as typeof classFilter)}>
            <option value="both">
              {t("classes.UNEXPLAINED_DELAY")} + {t("classes.WATCH")}
            </option>
            {QUEUE_CLASSES.map((c) => (
              <option key={c} value={c}>
                {t(`classes.${c}`)}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {elections.error ? <ErrorBox error={elections.error} onRetry={elections.reload} /> : null}
      {flags.error ? <ErrorBox error={flags.error} onRetry={flags.reload} /> : null}
      {flags.loading && !flags.data ? <LoadingLine /> : null}
      {flags.data && list.length === 0 ? (
        <Card>
          <CardContent className="pt-4">
            <p>{t("empty")}</p>
            <p className="text-sm text-muted-foreground">{t("emptyNotReviewer")}</p>
          </CardContent>
        </Card>
      ) : null}

      {list.length ? (
        <div className="grid gap-4 lg:grid-cols-[22rem_minmax(0,1fr)]">
          <Card>
            <CardHeader>
              <CardDescription>{tc("showing", { shown: list.length, total: list.length })}</CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="flex flex-col gap-2" data-testid="flag-list">
                {list.map((f) => (
                  <li key={f.id}>
                    <button
                      type="button"
                      onClick={() => setSelected(f.id)}
                      aria-pressed={current?.id === f.id}
                      className={cn(
                        "flex min-h-12 w-full flex-col rounded-md border p-3 text-left hover:bg-muted",
                        current?.id === f.id ? "border-primary bg-accent" : "border-border",
                      )}
                    >
                      <span className="font-medium">{f.evidence.name}</span>
                      <span className="text-sm text-muted-foreground">
                        {f.pu_code} · {t(`classes.${f.class}`)}
                      </span>
                      <span className="mt-1 flex flex-wrap gap-x-3 text-sm">
                        <span>{t("pendingFor", { time: formatMinutes(f.evidence.minutes_pending) })}</span>
                        <span className="font-medium">{t(`statuses.${f.review_status}`)}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
          {current ? (
            <Card>
              <CardContent className="flex flex-col gap-4 pt-4 sm:pt-5">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="rounded-full bg-secondary px-2.5 py-0.5 font-semibold text-secondary-foreground">{t(`classes.${current.class}`)}</span>
                  <span className="text-muted-foreground">{t("pendingFor", { time: formatMinutes(current.evidence.minutes_pending) })}</span>
                </div>
                <EvidenceCard e={current.evidence} />
                <Reviews flag={current} userId={userId} />
                <TwoPersonState status={current.review_status} />
                <ReviewForm key={`${current.id}:${userId}`} flag={current} token={token} userId={userId} onDone={flags.reload} />
              </CardContent>
            </Card>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Reviews({ flag, userId }: { flag: Flag; userId: string | null }) {
  const t = useTranslations("review");
  return (
    <section className="border-t border-border pt-3">
      <h3 className="mb-1 font-semibold">{t("reviewsTitle")}</h3>
      {flag.reviews.length === 0 ? <p className="text-sm text-muted-foreground">{t("noReviews")}</p> : null}
      <ul className="flex flex-col gap-2">
        {flag.reviews.map((r, i) => (
          <li key={`${r.reviewer_id}-${i}`} className="rounded-md bg-muted p-2 text-sm">
            <div className="font-medium">
              {t("reviewBy", {
                reviewer: r.reviewer_id === userId ? t("you") : t("otherReviewer"),
                decision: t(`statuses.${r.decision}`),
              })}
            </div>
            {r.note ? <p className="mt-0.5">{r.note}</p> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function ReviewForm({ flag, token, userId, onDone }: { flag: Flag; token: string; userId: string | null; onDone: () => void }) {
  const t = useTranslations("review");
  const [decision, setDecision] = useState<ReviewDecision | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const already = !!userId && flag.reviews.some((r) => r.reviewer_id === userId);
  const final = !OPEN.includes(flag.review_status);

  useEffect(() => {
    if (msg?.kind !== "ok") return;
    const id = setTimeout(() => setMsg(null), 4000);
    return () => clearTimeout(id);
  }, [msg]);

  if (final) return msg ? <p role="status" className="font-medium">{msg.text}</p> : null;
  if (already) {
    return (
      <p className="rounded-md border border-border bg-muted p-3 text-sm" data-testid="already-reviewed">
        {t("alreadyReviewed")}
      </p>
    );
  }

  const options: { value: ReviewDecision; label: string }[] = [
    { value: "concern_confirmed", label: t("confirm") },
    { value: "explained", label: t("explained") },
    { value: "dismissed", label: t("dismiss") },
  ];

  return (
    <form
      className="flex flex-col gap-3 border-t border-border pt-3"
      data-testid="review-form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!decision) return;
        if (decision === "explained" && !note.trim()) {
          setMsg({ kind: "err", text: t("noteMissing") });
          return;
        }
        setBusy(true);
        setMsg(null);
        try {
          await api.reviewFlag(flag.id, decision, note, token);
          setMsg({ kind: "ok", text: t("saved") });
          setDecision(null);
          setNote("");
          onDone();
        } catch (x) {
          const text = x instanceof ApiError && x.status === 409 ? t("alreadyReviewed") : x instanceof Error ? x.message : String(x);
          setMsg({ kind: "err", text });
        } finally {
          setBusy(false);
        }
      }}
    >
      <fieldset>
        <legend className="mb-2 font-semibold">{t("decision")}</legend>
        <div className="grid gap-2 sm:grid-cols-3">
          {options.map((o) => (
            <label
              key={o.value}
              className={cn(
                "flex min-h-12 cursor-pointer items-center justify-center rounded-md border-2 px-3 text-center font-medium has-[:focus-visible]:outline has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-ring",
                decision === o.value ? "border-primary bg-accent text-primary" : "border-input bg-card hover:bg-muted",
              )}
            >
              <input type="radio" name="decision" value={o.value} checked={decision === o.value} onChange={() => setDecision(o.value)} className="sr-only" />
              {o.label}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex flex-col gap-1">
        <Label htmlFor="note">{decision === "explained" ? t("noteRequired") : t("note")}</Label>
        <Textarea
          id="note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={t("notePlaceholder")}
          aria-required={decision === "explained"}
        />
      </div>
      <Button type="submit" disabled={!decision || busy} className="sm:self-start">
        {busy ? t("submitting") : t("submit")}
      </Button>
      {msg ? (
        <p role={msg.kind === "err" ? "alert" : "status"} className={cn("text-sm font-medium", msg.kind === "err" && "text-notice-foreground")}>
          {msg.text}
        </p>
      ) : null}
    </form>
  );
}
