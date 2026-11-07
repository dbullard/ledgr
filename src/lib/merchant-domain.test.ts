import { describe, test, expect } from "vitest";
import { guessMerchantFromDescription } from "./merchant-domain";

describe("guessMerchantFromDescription", () => {
  test.each([
    ["AMZN Mktp US*2K4HG1", "Amazon", "amazon.com"],
    ["SQ *STARBUCKS #1234", "Starbucks", "starbucks.com"],
    ["UBER EATS help.uber.com", "Uber Eats", "ubereats.com"],
    ["UBER *TRIP", "Uber", "uber.com"],
    ["NETFLIX.COM", "Netflix", "netflix.com"],
    ["MCDONALD'S F12345", "McDonald's", "mcdonalds.com"],
    ["TST* Chick-fil-A 00123", "Chick-fil-A", "chick-fil-a.com"],
    ["APPLE.COM/BILL", "Apple", "apple.com"],
    ["Walmart200015503319262 PIN POS RTN TO DDA CD8026 Bentonville AR#", "Walmart", "walmart.com"],
    ["WM Supercenter # DDA PIN POS PUR CD8026 Rogers #xxxxxxxx1605", "Walmart", "walmart.com"],
    ["Walmart+ Member PIN POS RTN TO DDA", "Walmart", "walmart.com"],
    ["Sams Club.com DDA PIN POS PUR CD1322 Bentonville", "Sam's Club", "samsclub.com"],
    ["Culvers Harrison DDA PIN POS PUR CD1322 Harrison Ar#xxxxxxxx3558", "Culver's", "culvers.com"],
    ["American Eagle Outfitte DDA PIN POS PUR CD8026 Rogers", "American Eagle", "ae.com"],
  ])("recognizes %s", (description, name, domain) => {
    expect(guessMerchantFromDescription(description)).toEqual({ name, domain });
  });

  test("falls back to a domain written in the description", () => {
    expect(guessMerchantFromDescription("WWW.JOESPIZZA.COM 555-1212")).toEqual({
      name: "Joespizza",
      domain: "joespizza.com",
    });
  });

  test.each(["Transfer to Savings", "ATM Withdrawal", "Check #1042", "Interest Payment", ""])(
    "returns null for %j",
    (description) => {
      expect(guessMerchantFromDescription(description)).toBeNull();
    },
  );

  test("does not read a file extension as a domain", () => {
    expect(guessMerchantFromDescription("statement.pdf")).toBeNull();
  });
});
