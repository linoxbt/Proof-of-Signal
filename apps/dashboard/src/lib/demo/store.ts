// In-memory demo state: the night timeline position and the reviews made in
// this browser tab. Nothing leaves the browser in demo mode.
import type { ReviewDecision } from "../api/types";
import { DEFAULT_NIGHT_STEP, NIGHT_STEPS } from "./fixtures";

export interface DemoReviewer {
  id: string;
  email: string;
  token: string;
  /** i18n-free display label */
  label: string;
}

export const DEMO_REVIEWERS: DemoReviewer[] = [
  {
    id: "0d3c9a52-7a0e-4b8e-9b55-0000000000a1",
    email: "reviewer.a@demo.invalid",
    token: "demo-token-reviewer-a",
    label: "Demo reviewer A",
  },
  {
    id: "0d3c9a52-7a0e-4b8e-9b55-0000000000b2",
    email: "reviewer.b@demo.invalid",
    token: "demo-token-reviewer-b",
    label: "Demo reviewer B",
  },
];

export interface DemoReview {
  reviewer_id: string;
  decision: ReviewDecision;
  note: string | null;
  created_at: string;
}

type Listener = () => void;

export class DemoStore {
  private step = DEFAULT_NIGHT_STEP;
  readonly reviews = new Map<string, DemoReview[]>();
  private listeners = new Set<Listener>();

  getStep(): number {
    return this.step;
  }

  getMinutes(): number {
    return NIGHT_STEPS[this.step].minutes;
  }

  setStep(step: number): void {
    const s = Math.max(0, Math.min(NIGHT_STEPS.length - 1, Math.round(step)));
    if (s === this.step) return;
    this.step = s;
    this.emit();
  }

  addReview(flagId: string, review: DemoReview): void {
    const list = this.reviews.get(flagId) ?? [];
    this.reviews.set(flagId, [...list, review]);
    this.emit();
  }

  reset(): void {
    this.step = DEFAULT_NIGHT_STEP;
    this.reviews.clear();
    this.emit();
  }

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}

/** Singleton for the browser tab. Tests create their own DemoStore. */
export const demoStore = new DemoStore();
