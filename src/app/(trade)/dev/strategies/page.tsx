import { redirect } from "next/navigation";
import { mapStrategiesSearchToAlgoTester } from "@/components/algo-tester/algo-tester-query";

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function StrategiesAdminPage({ searchParams }: PageProps) {
  const raw = await searchParams;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, item);
    } else if (typeof value === "string") {
      params.set(key, value);
    }
  }
  redirect(mapStrategiesSearchToAlgoTester(params));
}
