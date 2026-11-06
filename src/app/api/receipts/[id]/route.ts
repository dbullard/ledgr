import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { receipts } from "@/db/schema";
import { getSession, getHouseholdId } from "@/lib/auth/session";
import { withHousehold } from "@/lib/household-context";
import { readReceipt } from "@/lib/receipts/storage";
import { RECEIPT_TYPES } from "@/lib/receipts/paths";

export const dynamic = "force-dynamic";

const INLINE_TYPES = new Set(["application/pdf", "image/png", "image/jpeg", "image/webp"]);

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!(await getSession())) return new NextResponse("Unauthorized", { status: 401 });
  const householdId = await getHouseholdId();
  const { id } = await ctx.params;

  const [row] = await withHousehold(householdId, (tx) =>
    tx
      .select({
        filePath: receipts.filePath,
        contentType: receipts.contentType,
        originalFilename: receipts.originalFilename,
      })
      .from(receipts)
      .where(and(eq(receipts.householdId, householdId), eq(receipts.id, id)))
      .limit(1),
    db,
  );
  if (!row) return new NextResponse("Not found", { status: 404 });

  let body: Buffer;
  try {
    body = await readReceipt(row.filePath);
  } catch {
    return new NextResponse("Receipt file is missing from storage", { status: 410 });
  }

  // Only allow-listed types are ever served as their own type; viewable ones
  // render inline, everything else downloads.
  const type = Object.values(RECEIPT_TYPES).includes(row.contentType)
    ? row.contentType
    : "application/octet-stream";
  const disposition = INLINE_TYPES.has(type) ? "inline" : "attachment";
  const filename = encodeURIComponent(row.originalFilename);

  return new NextResponse(new Uint8Array(body), {
    headers: {
      "Content-Type": type,
      "Content-Disposition": `${disposition}; filename*=UTF-8''${filename}`,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
      "Cache-Control": "private, no-store",
    },
  });
}
