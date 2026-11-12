import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-2xl font-bold">404</h1>
      <Link href="/" className="inline-flex min-h-12 items-center text-primary underline">
        Proof of Signal
      </Link>
    </div>
  );
}
