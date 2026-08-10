import { NextResponse } from "next/server";
import { checkRaptorHealth } from "@/utils/solanatracker-raptor";


export async function GET() {
  const health = await checkRaptorHealth();
  return NextResponse.json(
    {
      provider: "solanatracker-raptor",
      ...health,
    },
    { status: health.healthy ? 200 : 503 },
  );
}
