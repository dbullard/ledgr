import Link from "next/link";
import { getHouseholdId } from "@/lib/auth/session";
import { withHousehold } from "@/lib/household-context";
import { getCategories } from "@/queries/categories";
import {
  PRODUCT_SORTS,
  getItemSpendByCategory,
  getProductPriceHistory,
  getTopProducts,
  type ProductSort,
} from "@/queries/receipt-items";
import { PriceSparkline } from "@/components/atoms/price-sparkline";
import { centsToDisplay } from "@/lib/money";
import { formatDateShort, todayDateString } from "@/lib/date-utils";

export const metadata = { title: "Items" };

const RANGES = [
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "1 year" },
  { value: "all", label: "All time" },
] as const;

function daysAgo(n: number): string {
  return new Date(Date.parse(`${todayDateString()}T00:00:00Z`) - n * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

function first(v: string | string[] | undefined): string | null {
  return typeof v === "string" && v ? v : null;
}

export default async function ReceiptItemsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const householdId = await getHouseholdId();
  const params = await searchParams;
  const range = RANGES.some((r) => r.value === first(params.range)) ? first(params.range)! : "90";
  const categoryId = first(params.category);
  const product = first(params.product);
  const search = first(params.q);
  const sort: ProductSort = PRODUCT_SORTS.includes(first(params.sort) as ProductSort)
    ? (first(params.sort) as ProductSort)
    : "spent";
  const defaultDir = sort === "name" ? "asc" : "desc";
  const dir = first(params.dir) === "asc" || first(params.dir) === "desc" ? (first(params.dir) as "asc" | "desc") : defaultDir;

  const filters = {
    dateFrom: range === "all" ? "2000-01-01" : daysAgo(Number(range)),
    dateTo: todayDateString(),
    categoryId,
  };

  const { byCategory, products, history, groups } = await withHousehold(householdId, async (tx) => ({
    // The category chart ignores the category filter so every category stays visible.
    byCategory: await getItemSpendByCategory(householdId, { ...filters, categoryId: null }, tx),
    products: await getTopProducts(householdId, filters, 200, tx, { sort, dir, search }),
    history: product ? await getProductPriceHistory(householdId, product, tx) : [],
    groups: await getCategories(householdId, tx),
  }));

  const grandTotal = byCategory.reduce((s, r) => s + r.totalCents, 0);
  const maxCat = Math.max(1, ...byCategory.map((r) => r.totalCents));
  const query = (extra: Record<string, string | null>) => {
    const q = new URLSearchParams();
    const merged = { range, category: categoryId, product, q: search, sort, dir, ...extra };
    for (const [k, v] of Object.entries(merged)) if (v) q.set(k, v);
    return `/receipts/items?${q}`;
  };
  const header = (key: ProductSort, label: string, align: "left" | "right" = "right") => {
    const active = sort === key;
    const nextDir = active ? (dir === "desc" ? "asc" : "desc") : key === "name" ? "asc" : "desc";
    return (
      <th
        scope="col"
        aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
        className={`py-1 font-normal ${align === "right" ? "pl-3 text-right" : ""}`}
      >
        <Link
          href={query({ sort: key, dir: nextDir })}
          className={`inline-flex items-center gap-1 hover:text-foreground ${active ? "text-foreground" : ""}`}
        >
          {label}
          <span aria-hidden className={active ? "" : "opacity-0"}>
            {dir === "asc" ? "↑" : "↓"}
          </span>
        </Link>
      </th>
    );
  };
  const itemCount = byCategory.reduce((s, r) => s + r.itemCount, 0);
  const picked = history.length > 0 ? products.find((p) => p.key === product?.toLowerCase()) : null;

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <div>
        <Link href="/receipts" className="text-sm text-muted-foreground hover:underline">
          ← Receipts
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">What we buy</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          From receipts you&apos;ve read item by item. Prices are before tax, so totals are lower than the
          charges they came from.
        </p>
      </div>

      {byCategory.length > 0 && (
        <dl className="grid grid-cols-3 gap-3">
          {[
            ["Spent on items", centsToDisplay(grandTotal)],
            ["Items bought", itemCount.toLocaleString()],
            ["Categories", String(byCategory.length)],
          ].map(([k, v]) => (
            <div key={k} className="rounded-xl bg-card p-3 ring-1 ring-foreground/10">
              <dt className="text-xs text-muted-foreground">{k}</dt>
              <dd className="mt-0.5 text-xl font-semibold tabular-nums tracking-tight">{v}</dd>
            </div>
          ))}
        </dl>
      )}

      <form method="get" className="flex flex-wrap items-center gap-2 text-sm">
        <input type="hidden" name="sort" value={sort} />
        <input type="hidden" name="dir" value={dir} />
        <input
          type="search"
          name="q"
          defaultValue={search ?? ""}
          placeholder="Search name, store, category, month, price…"
          aria-label="Search items"
          className="min-w-40 flex-1 rounded border border-border bg-background px-2 py-1"
        />
        <select name="range" defaultValue={range} aria-label="Date range" className="rounded border border-border bg-background px-2 py-1">
          {RANGES.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
        <select name="category" defaultValue={categoryId ?? ""} aria-label="Category" className="rounded border border-border bg-background px-2 py-1">
          <option value="">All categories</option>
          {groups.flatMap((g) =>
            g.categories
              .filter((c) => !c.isIncome)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              )),
          )}
        </select>
        <button type="submit" className="rounded border border-border px-3 py-1 hover:bg-muted">
          Apply
        </button>
      </form>

      {byCategory.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No items yet. Open a transaction with a receipt and choose Items, then Read items.
        </p>
      ) : (
        <>
          <section aria-label="Spend by category" className="space-y-2">
            <h2 className="text-sm font-medium">By category · {centsToDisplay(grandTotal)}</h2>
            {byCategory.map((r) => (
              <div key={r.categoryId ?? "none"} className="grid grid-cols-[9rem_1fr_6rem_3rem] items-center gap-2 text-sm">
                <Link
                  href={query({ category: categoryId === r.categoryId ? null : r.categoryId, product: null })}
                  aria-current={categoryId === r.categoryId ? "true" : undefined}
                  className={`truncate hover:underline ${categoryId === r.categoryId ? "font-semibold" : ""}`}
                >
                  {r.categoryName ?? "No category"}
                </Link>
                <div className="h-2 rounded-full bg-muted">
                  <div
                    className="h-2 rounded-full bg-primary"
                    style={{ width: `${Math.max(2, (Math.max(r.totalCents, 0) / maxCat) * 100)}%` }}
                  />
                </div>
                <span className="text-right tabular-nums">{centsToDisplay(r.totalCents)}</span>
                <span className="text-right text-xs tabular-nums text-muted-foreground">
                  {grandTotal > 0 ? `${Math.round((Math.max(r.totalCents, 0) / grandTotal) * 100)}%` : ""}
                </span>
              </div>
            ))}
          </section>

          <section aria-label="Top products" className="space-y-2">
            <h2 className="text-sm font-medium">
              Products · {products.length}
              {search ? ` matching “${search}”` : ""}
              {categoryId ? " in this category" : ""}
            </h2>
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  {header("name", "Product", "left")}
                  <th scope="col" className="py-1 pl-3 text-left font-normal">
                    Bought at
                  </th>
                  {header("spent", "Spent")}
                  {header("times", "Times")}
                  {header("avg", "Avg price")}
                  {header("last", "Last bought")}
                </tr>
              </thead>
              <tbody>
                {products.map((p) => (
                  <tr key={p.key} className="border-t border-border/70">
                    <td className="py-1.5">
                      <Link href={query({ product: p.key })} className="hover:underline">
                        {p.name}
                      </Link>
                    </td>
                    <td className="py-1.5 pl-3 text-muted-foreground">
                      {p.stores.map((s) => s.name).join(", ")}
                      {p.storeCount > p.stores.length ? ` +${p.storeCount - p.stores.length}` : ""}
                    </td>
                    <td className="py-1.5 pl-3 text-right tabular-nums">{centsToDisplay(p.totalCents)}</td>
                    <td className="py-1.5 pl-3 text-right tabular-nums">{p.purchases}</td>
                    <td className="py-1.5 pl-3 text-right tabular-nums">{centsToDisplay(p.avgUnitCents)}</td>
                    <td className="py-1.5 pl-3 text-right whitespace-nowrap">{formatDateShort(p.lastDate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}

      {product && (
        <section aria-label="Price history" className="space-y-3">
          <h2 className="text-sm font-medium">Price history · {picked?.name ?? product}</h2>
          {history.length === 0 ? (
            <p className="text-sm text-muted-foreground">No purchases of this product on attached receipts.</p>
          ) : (
            <>
              <PriceSparkline points={history} label={`Price per unit of ${picked?.name ?? product}`} />
              <table className="w-full text-sm">
                <tbody>
                  {[...history].reverse().map((h, i) => (
                    <tr key={i} className="border-t border-border/70">
                      <td className="py-1.5">{formatDateShort(h.date)}</td>
                      <td className="py-1.5">
                        <Link href={`/transactions?txn=${h.transactionId}`} className="hover:underline">
                          {h.merchant}
                        </Link>
                        {h.accountName ? <span className="text-muted-foreground"> · {h.accountName}</span> : null}
                      </td>
                      <td className="py-1.5 pl-3 text-right tabular-nums">{centsToDisplay(h.unitCents)} each</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </section>
      )}
    </div>
  );
}
