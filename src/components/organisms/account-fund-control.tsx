"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { setAccountFund } from "@/actions/investments";

interface AccountFundControlProps {
  accountId: string;
  accountName: string;
  fundTicker: string | null;
  fundName: string | null;
}

/**
 * For an investment account whose connector reports a balance but no holdings:
 * say the whole account is one fund (a target-date fund, say). Investments then
 * lists it as a single mutual-fund position that follows the account balance.
 */
export function AccountFundControl({ accountId, accountName, fundTicker, fundName }: AccountFundControlProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [ticker, setTicker] = useState(fundTicker ?? "");
  const [name, setName] = useState(fundName ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function save(next: { ticker: string; name?: string } | null) {
    startTransition(async () => {
      const result = await setAccountFund(accountId, next);
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setError(null);
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs"
        onClick={() => {
          setTicker(fundTicker ?? "");
          setName(fundName ?? "");
          setError(null);
          setOpen(true);
        }}
      >
        {fundTicker ? `Edit fund (${fundTicker})` : "Itemize as one fund"}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Itemize {accountName} as one fund</DialogTitle>
            <DialogDescription>
              Your connection reports a balance but no holdings. If the whole account is one fund, Ledgr
              will show it as a single mutual-fund position that follows the balance. It does not look up
              share prices, so you will see the value and allocation but not shares or price.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="fund-ticker">Ticker</Label>
              <Input
                id="fund-ticker"
                value={ticker}
                onChange={(e) => setTicker(e.target.value)}
                placeholder="GMGZX"
                autoComplete="off"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="fund-name">Fund name (optional)</Label>
              <Input
                id="fund-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="MyDestination 2055 Fund"
                autoComplete="off"
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
          <DialogFooter>
            {fundTicker && (
              <Button variant="outline" disabled={pending} onClick={() => save(null)}>
                Remove
              </Button>
            )}
            <Button disabled={pending || ticker.trim() === ""} onClick={() => save({ ticker, name })}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
