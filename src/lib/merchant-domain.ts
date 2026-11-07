export interface MerchantGuess {
  name: string;
  domain: string;
}

/**
 * Deterministic, no-AI merchant identification from a raw bank description.
 * Used as the fallback when no AI provider is configured (or before it runs),
 * so a household still gets logos for the brands that dominate most
 * statements. Conservative by design — returns null rather than guessing, and
 * the AI pass still handles everything this doesn't recognize.
 */

// Order matters: the first matching entry wins, so more specific patterns
// (Uber Eats, Amazon Prime) sit above their parent brand.
const KNOWN_BRANDS: { pattern: RegExp; name: string; domain: string }[] = [
  { pattern: /\buber\s*eats\b/, name: "Uber Eats", domain: "ubereats.com" },
  { pattern: /\buber\b/, name: "Uber", domain: "uber.com" },
  { pattern: /\blyft\b/, name: "Lyft", domain: "lyft.com" },
  { pattern: /\bdoordash\b/, name: "DoorDash", domain: "doordash.com" },
  { pattern: /\bgrubhub\b/, name: "Grubhub", domain: "grubhub.com" },
  { pattern: /\binstacart\b/, name: "Instacart", domain: "instacart.com" },
  { pattern: /\bamzn\b|\bamazon\b/, name: "Amazon", domain: "amazon.com" },
  { pattern: /\bwalmart\b|\bwal[- ]mart\b/, name: "Walmart", domain: "walmart.com" },
  { pattern: /\btarget\b/, name: "Target", domain: "target.com" },
  { pattern: /\bcostco\b/, name: "Costco", domain: "costco.com" },
  { pattern: /\bkroger\b/, name: "Kroger", domain: "kroger.com" },
  { pattern: /\bsafeway\b/, name: "Safeway", domain: "safeway.com" },
  { pattern: /\btrader joe'?s?\b/, name: "Trader Joe's", domain: "traderjoes.com" },
  { pattern: /\bwhole foods\b|\bwholefds\b/, name: "Whole Foods", domain: "wholefoodsmarket.com" },
  { pattern: /\baldi\b/, name: "Aldi", domain: "aldi.us" },
  { pattern: /\bpublix\b/, name: "Publix", domain: "publix.com" },
  { pattern: /\bheb\b/, name: "H-E-B", domain: "heb.com" },
  { pattern: /\bhome ?depot\b/, name: "The Home Depot", domain: "homedepot.com" },
  { pattern: /\blowe'?s\b/, name: "Lowe's", domain: "lowes.com" },
  { pattern: /\bbest ?buy\b/, name: "Best Buy", domain: "bestbuy.com" },
  { pattern: /\bcvs\b/, name: "CVS", domain: "cvs.com" },
  { pattern: /\bwalgreens\b/, name: "Walgreens", domain: "walgreens.com" },
  { pattern: /\bstarbucks\b/, name: "Starbucks", domain: "starbucks.com" },
  { pattern: /\bdunkin\b/, name: "Dunkin'", domain: "dunkindonuts.com" },
  { pattern: /\bmcdonald'?s?\b/, name: "McDonald's", domain: "mcdonalds.com" },
  { pattern: /\bchipotle\b/, name: "Chipotle", domain: "chipotle.com" },
  { pattern: /\bchick[- ]?fil[- ]?a\b/, name: "Chick-fil-A", domain: "chick-fil-a.com" },
  { pattern: /\bsubway\b/, name: "Subway", domain: "subway.com" },
  { pattern: /\bpanera\b/, name: "Panera Bread", domain: "panerabread.com" },
  { pattern: /\btaco bell\b/, name: "Taco Bell", domain: "tacobell.com" },
  { pattern: /\bwendy'?s\b/, name: "Wendy's", domain: "wendys.com" },
  { pattern: /\bburger king\b/, name: "Burger King", domain: "bk.com" },
  { pattern: /\bdomino'?s\b/, name: "Domino's", domain: "dominos.com" },
  { pattern: /\bnetflix\b/, name: "Netflix", domain: "netflix.com" },
  { pattern: /\bspotify\b/, name: "Spotify", domain: "spotify.com" },
  { pattern: /\bhulu\b/, name: "Hulu", domain: "hulu.com" },
  { pattern: /\bdisney ?(plus|\+)\b/, name: "Disney+", domain: "disneyplus.com" },
  { pattern: /\bhbo ?max\b/, name: "Max", domain: "max.com" },
  { pattern: /\byoutube\b/, name: "YouTube", domain: "youtube.com" },
  { pattern: /\bgoogle\b/, name: "Google", domain: "google.com" },
  { pattern: /\bitunes\b/, name: "Apple", domain: "apple.com" },
  { pattern: /\bopenai\b|\bchatgpt\b/, name: "OpenAI", domain: "openai.com" },
  { pattern: /\banthropic\b|\bclaude\.ai\b/, name: "Anthropic", domain: "anthropic.com" },
  { pattern: /\bgithub\b/, name: "GitHub", domain: "github.com" },
  { pattern: /\bdropbox\b/, name: "Dropbox", domain: "dropbox.com" },
  { pattern: /\bmicrosoft\b|\bmsft\b/, name: "Microsoft", domain: "microsoft.com" },
  { pattern: /\badobe\b/, name: "Adobe", domain: "adobe.com" },
  { pattern: /\bpaypal\b/, name: "PayPal", domain: "paypal.com" },
  { pattern: /\bvenmo\b/, name: "Venmo", domain: "venmo.com" },
  { pattern: /\bcash ?app\b/, name: "Cash App", domain: "cash.app" },
  { pattern: /\bverizon\b/, name: "Verizon", domain: "verizon.com" },
  { pattern: /\bat&t\b|\batt\s+(bill|wireless|payment)\b/, name: "AT&T", domain: "att.com" },
  { pattern: /\bt-?mobile\b/, name: "T-Mobile", domain: "t-mobile.com" },
  { pattern: /\bcomcast\b|\bxfinity\b/, name: "Xfinity", domain: "xfinity.com" },
  { pattern: /\bshell (oil|service)\b/, name: "Shell", domain: "shell.com" },
  { pattern: /\bchevron\b/, name: "Chevron", domain: "chevron.com" },
  { pattern: /\bexxon\b|\bexxonmobil\b/, name: "Exxon", domain: "exxon.com" },
  { pattern: /\bsouthwest\b/, name: "Southwest Airlines", domain: "southwest.com" },
  { pattern: /\bdelta air\b|\bdelta airlines\b/, name: "Delta Air Lines", domain: "delta.com" },
  { pattern: /\bunited air\b|\bunited airlines\b/, name: "United Airlines", domain: "united.com" },
  { pattern: /\bairbnb\b/, name: "Airbnb", domain: "airbnb.com" },
  { pattern: /\bpeloton\b/, name: "Peloton", domain: "onepeloton.com" },
  { pattern: /\bapple\s*(store|music|one|tv)\b/, name: "Apple", domain: "apple.com" },
];

// Real-world TLDs only — keeps a stray "FILE.TXT"-style token from being read as a host.
const DOMAIN_IN_TEXT =
  /\b([a-z0-9][a-z0-9-]*[a-z0-9]\.(?:com|net|org|io|co|app|tv|us|ai|dev|shop|store|me|ly|fm))\b/i;

// Card-processor and wallet prefixes that precede the real merchant name.
const PROCESSOR_PREFIX = /^(?:sq|tst|sp|pp|paypal|pos|dd|ach|debit|purchase)\s*\*\s*/i;

function normalize(description: string): string {
  return description
    .toLowerCase()
    .replace(PROCESSOR_PREFIX, "")
    .replace(/[^a-z0-9&'+.\-\s*]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function guessMerchantFromDescription(description: string): MerchantGuess | null {
  const text = normalize(description);
  if (!text) return null;

  for (const brand of KNOWN_BRANDS) {
    if (brand.pattern.test(text)) return { name: brand.name, domain: brand.domain };
  }

  const match = DOMAIN_IN_TEXT.exec(text);
  if (match) {
    const host = match[1].toLowerCase().replace(/^www\./, "");
    const label = host.split(".")[0];
    if (label.length >= 3) {
      return { name: label.charAt(0).toUpperCase() + label.slice(1), domain: host };
    }
  }

  return null;
}
