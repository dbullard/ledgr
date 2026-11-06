import { NextRequest, NextResponse } from "next/server";
import { uploadUnmatchedReceipt } from "@/actions/receipts";
import { getSession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

/**
 * Receipt upload for the native apps (and anything else that holds a session
 * cookie). Same pipeline as the Receipts page: file, hints, auto-match.
 * multipart/form-data with a `file` field.
 */
export async function POST(req: NextRequest) {
  if (!(await getSession())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }
  const res = await uploadUnmatchedReceipt(form);
  if ("error" in res) return NextResponse.json(res, { status: 400 });
  return NextResponse.json(res);
}
