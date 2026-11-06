import { generateText, Output } from "ai";
import { createUserModel } from "@/lib/ai/provider";
import { getAiConfig } from "@/lib/ai/config";
import { buildItemsPrompt, parsedReceiptSchema, type ParsedReceipt } from "./items";

export interface ParseInput {
  text: string | null;
  image: { data: Buffer; mediaType: string } | null;
  categoryNames: string[];
}

export type ParseRunner = (input: ParseInput) => Promise<ParsedReceipt>;

/**
 * Receipts show what a household buys, so by default they only go to a model
 * the household runs itself (AI_PROVIDER=custom, e.g. Ollama). A hosted
 * provider needs an explicit RECEIPT_PARSE_ALLOW_REMOTE=true.
 */
export function receiptModelBlocker(env: Record<string, string | undefined> = process.env): string | null {
  if (!env.AI_PROVIDER || !env.AI_MODEL) {
    return "Item reading needs a local model. Set AI_PROVIDER=custom, AI_BASE_URL and AI_MODEL (for example Ollama).";
  }
  if (env.AI_PROVIDER !== "custom" && env.RECEIPT_PARSE_ALLOW_REMOTE !== "true") {
    return "Receipts are only read by a local model. To allow your hosted provider, set RECEIPT_PARSE_ALLOW_REMOTE=true.";
  }
  return null;
}

export const runReceiptModel: ParseRunner = async ({ text, image, categoryNames }) => {
  const config = getAiConfig();
  if (!config) throw new Error("AI is not configured");
  const prompt = buildItemsPrompt(text, categoryNames);
  const { output } = await generateText({
    model: createUserModel(config),
    output: Output.object({ schema: parsedReceiptSchema }),
    instructions: "You read store receipts and return structured line items. Be exact with prices.",
    messages: [
      {
        role: "user",
        content: image
          ? [
              { type: "text", text: prompt },
              { type: "image", image: image.data, mediaType: image.mediaType },
            ]
          : [{ type: "text", text: prompt }],
      },
    ],
  });
  if (!output) throw new Error("The model returned nothing usable");
  return output;
};
