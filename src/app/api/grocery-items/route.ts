import { NextResponse } from "next/server";
import { buildGroceryResponse, checkBearer, corsHeaders, resolveHouseholdId } from "@/lib/grocery-items";

function json(body: unknown, status: number, request: Request) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store", ...corsHeaders(request.headers.get("Origin"), process.env.GROCERY_API_ORIGINS) },
  });
}

export async function OPTIONS(request: Request) {
  if (!process.env.GROCERY_API_KEY) return new NextResponse(null, { status: 404 });
  return new NextResponse(null, { status: 204, headers: corsHeaders(request.headers.get("Origin"), process.env.GROCERY_API_ORIGINS) });
}

export async function GET(request: Request) {
  const auth = checkBearer(request.headers.get("Authorization"), process.env.GROCERY_API_KEY);
  if (auth === "disabled") return new NextResponse(null, { status: 404 });
  if (auth === "denied") return json({ error: "Unauthorized" }, 401, request);
  try {
    const householdId = await resolveHouseholdId(process.env.GROCERY_API_HOUSEHOLD_ID);
    return json(await buildGroceryResponse(householdId), 200, request);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Failed" }, 500, request);
  }
}
