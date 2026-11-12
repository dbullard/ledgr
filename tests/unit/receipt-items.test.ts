import { describe, test, expect } from "vitest";
import {
  allocateSplits,
  applyAliases,
  cleanItems,
  correctPricesFromText,
  extractPricedLines,
  itemsFromText,
  extractTotaledLines,
  cleanProductName,
  guessCategoryName,
  isSummaryLine,
  normalizeRawName,
  reconcile,
} from "../../src/lib/receipts/items";

const cats = [
  { id: "c-groc", name: "Groceries" },
  { id: "c-home", name: "Home Goods" },
];

describe("cleanItems", () => {
  test("drops junk lines, snaps categories, converts quantity, keeps discounts", () => {
    const items = cleanItems(
      {
        items: [
          { name: " KS ORG  BNNA ", quantity: 1.5, totalCents: 349, product: "Bananas", category: "groceries" },
          { name: "", totalCents: 100 },
          { name: "FREE SAMPLE", totalCents: 0 },
          { name: "COUPON", totalCents: -100, category: "Nonexistent" },
          { name: "DISH SOAP", totalCents: 499.4, category: "Home Goods" },
        ],
      },
      cats,
    );
    expect(items).toEqual([
      { rawName: "KS ORG BNNA", productName: "Bananas", categoryId: "c-groc", quantityMilli: 1500, totalCents: 349 },
      { rawName: "COUPON", productName: null, categoryId: null, quantityMilli: 1000, totalCents: -100 },
      { rawName: "DISH SOAP", productName: null, categoryId: "c-home", quantityMilli: 1000, totalCents: 499 },
    ]);
  });
});

describe("summary lines", () => {
  test("footer lines are not purchases", () => {
    for (const n of ["Total", "Change", "Subtotal", "Sub-Total", "Tax", "Driver tip", "Savings", "Balance due", "Tax 1", "TOTAL:"]) {
      expect(isSummaryLine(n)).toBe(true);
    }
  });

  test("products that merely contain those words are kept", () => {
    for (const n of ["Total Greek Yogurt", "Pocket Change Candy", "Tax Software", "Tip Top Bread", "Member's Mark Cash Cow"]) {
      expect(isSummaryLine(n)).toBe(false);
    }
  });

  test("cleanItems drops them", () => {
    const out = cleanItems(
      { items: [
        { name: "Bananas", totalCents: 199 },
        { name: "Total", totalCents: 12171 },
        { name: "Change", totalCents: 12747 },
        { name: "Driver tip", totalCents: 576 },
      ] },
      [],
    );
    expect(out.map((i) => i.rawName)).toEqual(["Bananas"]);
  });
});

const SAMS = [
  "Delivery from club items(3)",
  "",
  "Red Baron Pepperoni Classic Crust Frozen Pizza, 61.81 oz., 3 pk.          Qty 1   $11.98",
  "",
  "Hillshire Farm Turkey Polska Kielbasa Smoked Sausage, 14 oz., 3 pk.       Qty 1    $9.57",
  "",
  "Member's Mark Seasoned Beef Bites with Garlic and Herb Compound Butter,   Qty 1   $18.88",
  "1.5 lbs.",
  "",
  "Airship Buffalo Blend Whole Bean Coffee, 27 oz.                           Qty 2   $39.96",
  "Subtotal                                                                  $191.70",
].join("\n");

describe("prices taken from the receipt text", () => {
  test("reads priced lines, joins wrapped names, ignores headers and totals", () => {
    const lines = extractPricedLines(SAMS);
    expect(lines.map((l) => l.totalCents)).toEqual([1198, 957, 1888, 3996]);
    expect(lines[2].name).toBe("Member's Mark Seasoned Beef Bites with Garlic and Herb Compound Butter, 1.5 lbs.");
    expect(lines[3].quantity).toBe(2);
  });

  test("a size in the name is not a price, and a neighbour's price is replaced", () => {
    const fixed = correctPricesFromText(
      { items: [
        { name: "Red Baron Pepperoni Classic Crust Frozen Pizza, 61.81 oz., 3 pk.", totalCents: 6181 },
        { name: "Hillshire Farm Turkey Polska Kielbasa Smoked Sausage, 14 oz., 3 pk.", totalCents: 1398, product: "Kielbasa" },
      ] },
      SAMS,
    );
    expect(fixed.items[0].totalCents).toBe(1198);
    expect(fixed.items[1]).toMatchObject({ totalCents: 957, product: "Kielbasa" });
  });

  test("names match despite 'Ibs.' for 'lbs.' and a dropped wrapped tail", () => {
    const fixed = correctPricesFromText(
      { items: [
        { name: "Member's Mark Seasoned Beef Bites with Garlic and Herb Compound Butter, 1.5 Ibs.", totalCents: 100 },
        { name: "Member's Mark Seasoned Beef Bites with Garlic and Herb Compound Butter,", totalCents: 100 },
      ] },
      SAMS,
    );
    expect(fixed.items[0].totalCents).toBe(1888);
    expect(fixed.items).toHaveLength(5); // second copy finds no printed line left; 3 others are added
  });

  test("printed lines the model skipped are added", () => {
    const fixed = correctPricesFromText({ items: [] }, SAMS);
    expect(fixed.items).toHaveLength(4);
  });

  test("other layouts are left to the model", () => {
    const parsed = { items: [{ name: "Bananas", totalCents: 199 }] };
    expect(correctPricesFromText(parsed, "BANANAS 1.99\nTOTAL 1.99")).toEqual(parsed);
    expect(correctPricesFromText(parsed, null)).toEqual(parsed);
  });
});

// What the server's PDF reader (unpdf) actually produces for a Sam's order.
const SERVER_TEXT = [
  "Sep 26, 2025", "Order 10349342204", "Shipping items(1)", "DAVID BULLARD", "4307 W MURFIELD DR", "ROGERS, AR 72758",
  "McCormick Pure Vanilla Extract, 8 fl. oz. Qty 1 $10.98",
  "Delivery from club items(12)",
  "Red Baron Pepperoni Classic Crust Frozen Pizza, 61.81 oz., 3 pk. Qty 1 $11.98",
  "Member's Mark Seasoned Beef Bites with Garlic and Herb Compound Butter,",
  "1.5 lbs.",
  "Qty 1 $18.88",
  "Ready Protein Bar, Variety Pack, 20 ct. Qty 1 $16.98",
  "$1.00 from savings $17.98",
  "Clio Greek Yogurt Bar, Strawberry & Vanilla, 12 pk. Qty 2 $19.72",
  "Subtotal $191.70",
  "Total $216.41",
].join("\n");

describe("the server's own PDF text", () => {
  test("is read: wrapped names join, savings lines don't leak into the next name", () => {
    const lines = extractPricedLines(SERVER_TEXT);
    expect(lines.map((l) => [l.totalCents, l.quantity])).toEqual([[1098, 1], [1198, 1], [1888, 1], [1698, 1], [1972, 2]]);
    expect(lines[2].name).toBe("Member's Mark Seasoned Beef Bites with Garlic and Herb Compound Butter, 1.5 lbs.");
    expect(lines[4].name).toBe("Clio Greek Yogurt Bar, Strawberry & Vanilla, 12 pk.");
  });

  test("a wrapped first item is not glued to the address above it", () => {
    const t = ["Shipping items(1)", "DAVID BULLARD", "4307 W MURFIELD DR", "ROGERS, AR 72758", "Long Product Name That Wraps,", "2 lbs.", "Qty 1 $5.00"].join("\n");
    expect(extractPricedLines(t)[0].name).toBe("Long Product Name That Wraps, 2 lbs.");
  });

  test("items are built with clean names and categories, no model needed", () => {
    const items = itemsFromText(SERVER_TEXT, null);
    expect(items).toHaveLength(5);
    expect(items[1]).toMatchObject({ name: expect.stringContaining("Red Baron"), totalCents: 1198, product: "Red Baron Pepperoni Classic Crust Frozen Pizza", category: "Groceries" });
  });

  test("a device reader's items keep their names but take the printed prices", () => {
    const items = itemsFromText(SERVER_TEXT, { items: [{ name: "Red Baron Pepperoni Classic Crust Frozen Pizza, 61.81 oz., 3 pk.", totalCents: 6181, product: "Pizza" }] });
    expect(items[0]).toMatchObject({ totalCents: 1198, product: "Pizza" });
    expect(items.length).toBe(5); // the printed lines it missed are added
  });

  test("names are cleaned and sorted into the household's categories", () => {
    expect(cleanProductName("Member's Mark 93/7 Ground Beef, priced per pound")).toBe("Member's Mark 93/7 Ground Beef");
    expect(cleanProductName("Strawberries, 2 lbs.")).toBe("Strawberries");
    expect(guessCategoryName("Huggies Little Movers Baby Diapers, Sizes 3-8")).toBe("Baby");
    expect(guessCategoryName("Member's Mark Vitamin D Whole Milk,1 gal.")).toBe("Groceries");
    expect(guessCategoryName("Culturelle Digestive Daily Probiotics Capsules, 80 ct.")).toBe("Pharmacy");
  });
});

// Text the server's OCR actually returns for a printed Toast restaurant receipt.
const TOAST = "BIG ORANGE\n2203 South Promenade Boulevard Suite 3100\nRogers, AR 72758\nCheck #112 Table 50\n11/5/26 4:57\n\nOrdered: PM\n\n‘American Classic Burger $13.75\n\nGluten Free Bun\n\nSouthern Fried Chicken\n\nSandwich $20.50\n\nHouse Fries\n\nKid's Chicken Snackers $6.95\n\nSubtotal $41.20\n\nTax $3.92\n\nTip $7.42\n\nTotal $5254\n\nVisa XX000KXX6285";

describe("restaurant receipts read from OCR text", () => {
  test("items are the priced lines, wrapped names joined, modifiers left out, and they add up to the subtotal", () => {
    const lines = extractTotaledLines(TOAST);
    expect(lines.map((l) => [l.name, l.totalCents])).toEqual([
      ["American Classic Burger", 1375],
      ["Southern Fried Chicken Sandwich", 2050],
      ["Kid's Chicken Snackers", 695],
    ]);
  });

  test("nothing is returned when the lines don't add up to the printed subtotal", () => {
    expect(extractTotaledLines(TOAST.replace("$20.50", "$20.80"))).toEqual([]);
    expect(extractTotaledLines("Coffee $3.00\nTotal $3.00")).toEqual([]); // no subtotal to prove it against
  });

  test("quantities are read, and the transaction's category is used", () => {
    const items = itemsFromText("2 Pad Thai $24.00\nSpring Rolls $6.00\nSubtotal $30.00\nTax $2.00", null, "Restaurants");
    expect(items.map((i) => [i.name, i.quantity, i.totalCents, i.category])).toEqual([
      ["Pad Thai", 2, 2400, "Restaurants"],
      ["Spring Rolls", 1, 600, "Restaurants"],
    ]);
  });
});

describe("aliases", () => {
  test("normalizes raw names", () => {
    expect(normalizeRawName("KS  ORG-BNNA, 3LB")).toBe("ks org bnna 3lb");
  });
  test("a confirmed alias overrides the model's guess", () => {
    const [item] = applyAliases(
      [{ rawName: "KS ORG BNNA", productName: "Banana", categoryId: "c-home", quantityMilli: 1000, totalCents: 349 }],
      [{ rawKey: "ks org bnna", productName: "Bananas", categoryId: "c-groc" }],
    );
    expect(item).toMatchObject({ productName: "Bananas", categoryId: "c-groc" });
  });
});

describe("reconcile and allocateSplits", () => {
  test("gap is the receipt total minus the lines", () => {
    expect(reconcile([{ totalCents: 1000 }, { totalCents: 500 }], 1620)).toEqual({ itemsTotalCents: 1500, gapCents: 120 });
    expect(reconcile([{ totalCents: 1 }], null).gapCents).toBeNull();
  });

  test("splits sum exactly to the transaction and spread tax proportionally", () => {
    const splits = allocateSplits(
      [
        { categoryId: "c-groc", totalCents: 3000 },
        { categoryId: "c-groc", totalCents: 1000 },
        { categoryId: "c-home", totalCents: 1000 },
        { categoryId: null, totalCents: 777 },
      ],
      5333,
    );
    expect(splits).toEqual([
      { categoryId: "c-groc", amount: 4266 },
      { categoryId: "c-home", amount: 1067 },
    ]);
    expect(splits!.reduce((s, x) => s + x.amount, 0)).toBe(5333);
  });

  test("never loses a cent to rounding", () => {
    const splits = allocateSplits(
      [
        { categoryId: "a", totalCents: 1 },
        { categoryId: "b", totalCents: 1 },
        { categoryId: "c", totalCents: 1 },
      ],
      100,
    )!;
    expect(splits.reduce((s, x) => s + x.amount, 0)).toBe(100);
  });

  test("null when nothing is categorized", () => {
    expect(allocateSplits([{ categoryId: null, totalCents: 100 }], 100)).toBeNull();
  });
});

describe("Walmart order text with fulfilment status", () => {
  const WM = [
    "Delivery items(2)",
    "Great Value Chunk Chicken Breast with",
    "Rib Meat in Water, 12.5 oz Can 2 substituted",
    "Qty 2 $5.68",
    "Butter, 15 Count 2 shopped",
    "Qty 1 $14.97",
  ].join("\n");

  test("status text is not part of an item name", () => {
    const lines = extractPricedLines(WM);
    expect(lines.map((l) => l.name)).toEqual([
      "Great Value Chunk Chicken Breast with Rib Meat in Water, 12.5 oz Can",
      "Butter, 15 Count",
    ]);
  });

  test("a model's full name and the printed tail are one item, not two", () => {
    const fixed = correctPricesFromText(
      { items: [{ name: "Great Value Chunk Chicken Breast with Rib Meat in Water, 12.5 oz Can", totalCents: 2072 }] },
      "Delivery items(1)\nGreat Value Chunk Chicken Breast with\nRib Meat in Water, 12.5 oz Can 2 substituted\nQty 2 $5.68",
    );
    expect(fixed.items).toHaveLength(1);
    expect(fixed.items[0]).toMatchObject({ totalCents: 568, quantity: 2 });
  });
});

describe("Walmart delivery invoice as the server reads the PDF", () => {
  const INVOICE = [
    "Invoice",
    "Buyer",
    "Loren Bullard",
    "4307 W Murfield Dr, Rogers, AR 72758",
    "OGX Clarifying Strength and Rosemary Mint Hair",
    "Shampoo, 13 fl. oz Qty 1 $6.97",
    "(4 pack) Betty Crocker Bisquick, Gluten Free Pancake",
    "and Baking Mix, 16 oz Qty 1 $20.72",
    "King Arthur Baking Company Non-GMO",
    "Project Verified, Certified Gluten-Free",
    "Measure for Measure Flour, 3 lb Bag",
    "23 shopped Qty 1 $8.67",
    "Great Value Ground Cloves, 2 oz 23 shopped Qty 1 $2.18",
    "Russet Baking Potatoes Whole",
    "Fresh, Each 9 weight adjusted Qty 3 $1.64",
    "Subtotal $132.35",
  ].join("\n");

  test("wrapped names are whole, status text is gone, the address is not glued on", () => {
    const lines = extractPricedLines(INVOICE);
    expect(lines.map((l) => [l.name, l.totalCents, l.quantity])).toEqual([
      ["OGX Clarifying Strength and Rosemary Mint Hair Shampoo, 13 fl. oz", 697, 1],
      ["(4 pack) Betty Crocker Bisquick, Gluten Free Pancake and Baking Mix, 16 oz", 2072, 1],
      ["King Arthur Baking Company Non-GMO Project Verified, Certified Gluten-Free Measure for Measure Flour, 3 lb Bag", 867, 1],
      ["Great Value Ground Cloves, 2 oz", 218, 1],
      ["Russet Baking Potatoes Whole Fresh, Each", 164, 3],
    ]);
  });
});
