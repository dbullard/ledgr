import Link from "next/link";
import { ReceiptTray } from "@/components/organisms/receipt-tray";
import { WalmartImport } from "@/components/organisms/walmart-import";

export const metadata = { title: "Receipts" };

export default function ReceiptsPage() {
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Receipts</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Always optional. Drop receipts here and Ledgr attaches the ones that clearly match a
          transaction; the rest wait below for you to choose.
        </p>
        <Link href="/receipts/items" className="mt-2 inline-block text-sm underline">
          See what we buy →
        </Link>
      </div>
      <ReceiptTray />
      <WalmartImport />
    </div>
  );
}
