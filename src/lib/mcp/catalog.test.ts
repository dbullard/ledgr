import { describe, test, expect, beforeAll } from "vitest";
import { InMemoryTransport, type JSONRPCMessage } from "@modelcontextprotocol/server";
import { readFileSync } from "fs";
import { resolve } from "path";
import { CATALOG_ONLY_MESSAGE, createCatalogServer } from "./catalog";

// The README's Available Tools table is what users read, so the catalog is
// checked against it rather than a second hand-kept list.
function readmeToolNames(): string[] {
  const readme = readFileSync(resolve(__dirname, "../../../README.md"), "utf-8");
  const section = readme.split("### Available Tools")[1].split("\n\n")[1];
  return [...section.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]).sort();
}

async function connect() {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const pending = new Map<number, (msg: JSONRPCMessage) => void>();
  clientSide.onmessage = (msg) => {
    if ("id" in msg && typeof msg.id === "number") pending.get(msg.id)?.(msg);
  };
  await createCatalogServer().connect(serverSide);
  await clientSide.start();

  let nextId = 1;
  const request = (method: string, params: Record<string, unknown> = {}) => {
    const id = nextId++;
    return new Promise<Record<string, unknown>>((done) => {
      pending.set(id, (msg) => done(msg as unknown as Record<string, unknown>));
      void clientSide.send({ jsonrpc: "2.0", id, method, params });
    });
  };

  await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "catalog-test", version: "0" },
  });
  await clientSide.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  return request;
}

describe("MCP tool catalog", () => {
  let request: Awaited<ReturnType<typeof connect>>;

  beforeAll(async () => {
    request = await connect();
  });

  test("lists exactly the tools in the README's Available Tools table", async () => {
    const res = await request("tools/list");
    const tools = (res.result as { tools: { name: string }[] }).tools;

    expect(tools.map((t) => t.name).sort()).toEqual(readmeToolNames());
    expect(tools).toHaveLength(22);
  });

  test("answers a tool call with an error instead of querying data", async () => {
    const res = await request("tools/call", { name: "list_accounts", arguments: {} });
    const result = res.result as { isError: boolean; content: { text: string }[] };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(CATALOG_ONLY_MESSAGE);
  });
});

describe("MCP receipt scope", () => {
  async function toolNames(scope: string): Promise<string[]> {
    const { createMcpServer } = await import("./server");
    const { registerAllTools } = await import("./tools");
    const names: string[] = [];
    const server = createMcpServer();
    const original = server.registerTool.bind(server);
    server.registerTool = ((name: string, ...rest: unknown[]) => {
      names.push(name);
      return (original as (...a: unknown[]) => unknown)(name, ...rest);
    }) as typeof server.registerTool;
    registerAllTools(server, { sub: "u", household_id: "h", scope });
    return names;
  }

  test("receipt tools need ledgr:receipts; reading item spending needs ledgr:read", async () => {
    const writeTools = ["save_receipt", "list_unmatched_receipts", "attach_receipt", "set_receipt_items"];
    const readOnly = await toolNames("ledgr:read");
    expect(readOnly).toContain("get_item_spending");
    for (const t of writeTools) expect(readOnly).not.toContain(t);

    const receipts = await toolNames("ledgr:receipts");
    for (const t of writeTools) expect(receipts).toContain(t);
    expect(receipts).not.toContain("get_item_spending");
    expect(receipts).not.toContain("update_transaction_category");
  });
});
