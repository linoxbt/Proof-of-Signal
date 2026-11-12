import * as React from "react";
import { cn } from "@/lib/utils";

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn("text-sm font-medium text-foreground", className)} {...props} />;
}

const control =
  "min-h-12 w-full rounded-md border border-input bg-card px-3 text-base text-foreground placeholder:text-muted-foreground disabled:opacity-50";

export function Select({ className, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn(control, "pr-8", className)} {...props} />;
}

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(control, className)} {...props} />;
}

export function Textarea({ className, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(control, "min-h-24 py-2", className)} {...props} />;
}

/** Radio-group styled as a segmented control; every option is a 48px target. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  name,
  className,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  name: string;
  className?: string;
}) {
  return (
    <fieldset className={cn("min-w-0", className)}>
      <legend className="mb-1 text-sm font-medium">{label}</legend>
      <div className="flex flex-wrap gap-1 rounded-md border border-input bg-muted p-1">
        {options.map((o) => (
          <label
            key={o.value}
            className={cn(
              "flex min-h-12 flex-1 cursor-pointer items-center justify-center rounded px-3 text-center text-sm font-medium whitespace-nowrap has-[:focus-visible]:outline has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-ring",
              value === o.value ? "bg-card text-primary shadow-sm" : "text-muted-foreground hover:bg-card/60",
            )}
          >
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={value === o.value}
              onChange={() => onChange(o.value)}
              className="sr-only"
            />
            {o.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
