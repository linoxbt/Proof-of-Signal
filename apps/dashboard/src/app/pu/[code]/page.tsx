import type { Metadata } from "next";
import { PuView } from "@/components/pu/pu-view";

export async function generateMetadata({ params }: { params: Promise<{ code: string }> }): Promise<Metadata> {
  const { code } = await params;
  return { title: decodeURIComponent(code) };
}

export default async function PuPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  return <PuView code={decodeURIComponent(code)} />;
}
