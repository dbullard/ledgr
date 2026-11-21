import { describe, test, expect } from "vitest";
import { extractHints, findChargedTotal, findDate, findMerchant, findTotal, merchantFromFilename, merchantFromFirstLine } from "../../src/lib/receipts/hints";

describe("findTotal", () => {
  test("takes the grand total, not subtotal or tax", () => {
    const text = "Item Subtotal: $68.85\nSales Tax: $6.54\nGrand Total: USD 75.39";
    expect(findTotal(text)).toBe(7539);
  });
  test("works without line breaks and with thousands separators", () => {
    expect(findTotal("Subtotal 1,100.00 Tax 88.00 Total $1,188.00 Thank you")).toBe(118800);
  });
  test("null when there is no labelled total", () => {
    expect(findTotal("Thanks for shopping 12.50")).toBeNull();
  });
});

describe("findChargedTotal", () => {
  test("adds a driver tip printed after the total (Sam's Club delivery)", () => {
    const text = "Subtotal $90.44 Tax $4.37 Total $97.31 Driver tip $3.90";
    expect(findTotal(text)).toBe(9731);
    expect(findChargedTotal(text)).toBe(10121);
  });
  test("uses the card line as the charge: with the tip in 2026, without it in 2025", () => {
    const y26 = "Total $97.31 Driver tip $3.90 Ending in 1322 $101.21 Credit cards aren't charged";
    const y25 = "Total $216.41 Driver tip $9.15 *1322 $216.41 Credit cards aren't charged";
    expect(findChargedTotal(y26)).toBe(10121);
    expect(findChargedTotal(y25)).toBe(21641);
  });
  test("does not add a tip printed before the total (already included)", () => {
    expect(findChargedTotal("Subtotal 25.00 Delivery tip 5.00 Total 30.00")).toBe(3000);
  });
  test("is just the total when there is no tip, and null with no total", () => {
    expect(findChargedTotal("Grand Total: USD 75.39")).toBe(7539);
    expect(findChargedTotal("Thanks 12.50")).toBeNull();
  });
});

describe("findDate", () => {
  test.each([
    ["Order Placed: November 2, 2026", "2026-11-02"],
    ["Nov 4, 2026 at 10:14 AM", "2026-11-04"],
    ["11/02/2026", "2026-11-02"],
    ["2026-11-02", "2026-11-02"],
  ])("%s", (input, expected) => {
    expect(findDate(input)).toBe(expected);
  });
  test("rejects impossible dates", () => {
    expect(findDate("2026-02-31")).toBeNull();
  });
});

describe("extractHints", () => {
  test("reads an email's sender, date and total", () => {
    const eml = "From: Spotify <no-reply@spotify.com>\nDate: Nov 4, 2026\n\nTotal $24.08";
    expect(extractHints("receipt.eml", eml)).toEqual({
      totalCents: 2408,
      date: "2026-11-04",
      merchant: "Spotify",
    });
  });
  test("a delivery receipt's amount includes the driver tip", () => {
    const text = "Order Details\nOct 30, 2026\nSubtotal $90.44\nTax $4.37\nTotal $97.31\nDriver tip $3.90";
    expect(extractHints("SamsClub_800000090394266.pdf", text).totalCents).toBe(10121);
  });
  test("falls back to the filename when there is no text", () => {
    expect(extractHints("Casey's 2026-11-01 26.24.jpg", null)).toEqual({
      totalCents: 2624,
      date: "2026-11-01",
      merchant: "Casey",
    });
  });
  test("merchantFromFilename drops dates, amounts and noise words", () => {
    expect(merchantFromFilename("IMG_receipt_Best Buy_2026-10-03_874.91.pdf")).toBe("Best Buy");
    expect(merchantFromFilename("2026-10-03.pdf")).toBeNull();
  });

  test("a text receipt's merchant is its first plausible line, not the filename", () => {
    const text = "Trader Joe's\nOrder Placed: October 27, 2026\nGrand Total: $74.33";
    expect(extractHints("tj-oct27.txt", text).merchant).toBe("Trader Joe's");
  });
  test("merchantFromFirstLine skips headers, amounts and dates", () => {
    expect(merchantFromFirstLine("RECEIPT\n11/02/2026 10:14\n$5.00\nCorner Cafe\nTotal 5.00")).toBe("Corner Cafe");
    expect(merchantFromFirstLine("12345\n$9.99")).toBeNull();
  });

  describe("findMerchant", () => {
    test("a phrase in the filename names the store", () => {
      expect(findMerchant("Receipt from CCR2 #emmP.pdf", "$32.56 #emmP\nDecaf $18.50\nNutty but Nice")).toBe("CCR2");
      expect(findMerchant("Your Receipt for MOJITOS - NEW.pdf", "Total $20.00")).toBe("Mojitos");
      expect(findMerchant("Your Black Hills Energy bill is available.pdf", "Your recent energy bill is ready.")).toBe("Black Hills Energy");
      expect(findMerchant("Confirmation of digital purchase from Nintendo.pdf", null)).toBe("Nintendo");
    });

    test("a forwarded receipt email's subject and sender name the store", () => {
      const text = "David Bullard <me@gmail.com>\nReceipt for $52.54 at Big Orange - Rogers\nBig Orange <no-reply@toasttab.com>";
      expect(findMerchant("dropped-1.pdf", text)).toBe("Big Orange");
      expect(findMerchant("dropped-2.pdf", "Begin forwarded message:\nFrom: AT&T Orders <orders@account.att-mail.com>\nSubject: Thanks")).toBe("AT&T");
    });

    test("never takes the user's own name or mailbox as the store", () => {
      expect(findMerchant("x.pdf", "David Bullard <dbullard07@gmail.com>\nHave a great day")).not.toMatch(/bullard/i);
    });

    test("order pages are named by their site, not the Buyer label", () => {
      const text = "11/11/26 Order details - Walmart.com\nInvoice\nOrder# 2000156\nBuyer\nLoren Bullard\n4307 W Murfield Dr";
      expect(findMerchant("dropped-20261111.pdf", text)).toBe("Walmart");
    });

    test("recognises Sam's Club by its order wording and curly apostrophe", () => {
      expect(findMerchant("PDF document.pdf", "Nov 14, 2026\nOrder 8000\nDelivery from club items(11)\nBeef Qty 1 $20.22")).toBe("Sam's Club");
      expect(findMerchant("Order Receipt - TC 1.png", "sam’s club\nCLUB MANAGER JOSHUA\nPump# 9 UNLEAD")).toBe("Sam's Club");
    });

    test("welcome and thank-you lines on restaurant receipts name the store", () => {
      expect(findMerchant("scan.jpg", "Welcome to Chick-fil-A\nTuscany Square FSU (# 01977)\nRogers, AR")).toBe("Chick-fil-A");
      expect(findMerchant("scan.jpg", "Thank you for dining with Pei Wei Asian Kitchen\n4895 Ul Pauline Uhitaker p")).toBe("Pei Wei Asian Kitchen");
    });

    test("a company-name line beats the customer's name above it", () => {
      const text = "0\n956\nDAVID BULLARD\n4307 W MURFIELD DR\nCarroll Electric Cooperative Corporation\nPO BOX 4000";
      expect(findMerchant("BillPdf.ashx.pdf", text)).toBe("Carroll Electric Cooperative Corporation");
    });

    test("labels, addresses, items and OCR debris are never the store", () => {
      for (const junk of ["Buyer", "Delivered to:", "Account name: David B.", "Vanilla Latte × 2", "4895 Ul Pauline Uhitaker p", "HARPS ee"]) {
        expect(findMerchant("scan-1.jpg", `${junk}\nTotal $5.00`)).toBeNull();
      }
    });
  });
});
