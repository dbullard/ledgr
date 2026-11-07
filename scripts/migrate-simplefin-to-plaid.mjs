import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

// Resolve `pg` from the working directory so the file can be run from anywhere
// (e.g. copied to /tmp inside the app container, whose /app is read-only).
const pg = createRequire(`${process.cwd()}/`)("pg");

// One-off: move a household from SimpleFIN to Plaid WITHOUT losing history.
//
// A freshly linked Plaid account only has ~90 days of transactions, while the
// SimpleFIN account it replaces may hold years of categorized history. So we
// keep the OLD account (and everything hanging off it) and re-point it at the
// Plaid connection:
//   * Plaid rows that match an old row (same normalized amount, date within
//     3 days, one-to-one) are "adopted": the old row takes the Plaid id and
//     provider, so its category, name and edits survive, and the new
//     duplicate row is dropped.
//   * Plaid rows with no old counterpart are moved into the old account.
//   * The old account takes the Plaid external id, balances and connection;
//     the now-empty new account is deleted.
// Optionally drops the old SimpleFIN connections and detaches accounts Plaid
// does not cover (turning them into manual accounts).
//
// Modes (first argument):
//   suggest  print how many transactions each old/new account pair share
//   plan     dry run for the given pairs (default if only flags are given)
//   apply    do it, in ONE transaction (all or nothing). Back up first.
// Flags:
//   --pairs OLD=NEW,OLD=NEW   account id prefixes (old SimpleFIN = new Plaid)
//   --drop  CONN,CONN         old SimpleFIN connection id prefixes to delete
//   --detach ACC,ACC          account id prefixes to turn into manual accounts

const WINDOW_DAYS = 3;
const dayNumber = (iso) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / 86_400_000);

/** One-to-one match of incoming rows to existing rows: same amount, nearby date, closest first. */
export function matchRows(incoming, existing) {
  const byAmount = new Map();
  for (const e of existing) {
    const list = byAmount.get(e.amount);
    if (list) list.push(e);
    else byAmount.set(e.amount, [e]);
  }
  const candidates = [];
  for (const row of incoming) {
    for (const e of byAmount.get(row.amount) ?? []) {
      const gap = Math.abs(dayNumber(row.date) - dayNumber(e.date));
      if (gap <= WINDOW_DAYS) candidates.push({ inKey: row.key, exKey: e.key, gap });
    }
  }
  candidates.sort((a, b) => a.gap - b.gap);
  const result = new Map();
  const used = new Set();
  for (const c of candidates) {
    if (result.has(c.inKey) || used.has(c.exKey)) continue;
    result.set(c.inKey, c.exKey);
    used.add(c.exKey);
  }
  return result;
}

async function resolveAccount(client, prefix, provider) {
  const { rows } = await client.query(
    `select a.id, a.name, a.household_id, a.bank_connection_id, a.type, c.provider
       from accounts a left join bank_connections c on c.id = a.bank_connection_id
      where a.id like $1 and a.deleted_at is null`,
    [`${prefix}%`],
  );
  if (rows.length !== 1) throw new Error(`Account prefix "${prefix}" matched ${rows.length} accounts`);
  const acct = rows[0];
  if (provider && acct.provider !== provider) {
    throw new Error(`Account ${prefix} (${acct.name}) is provider "${acct.provider}", expected "${provider}"`);
  }
  return acct;
}

async function loadTxns(client, accountId) {
  const { rows } = await client.query(
    `select id, date::text as date, normalized_amount as amount, external_id, pending, provider
       from transactions where account_id = $1`,
    [accountId],
  );
  return rows;
}

/** Work out, without changing anything, what a pair migration would do. */
export async function planPair(client, oldPrefix, newPrefix) {
  const oldAcct = await resolveAccount(client, oldPrefix, "simplefin");
  const newAcct = await resolveAccount(client, newPrefix, "plaid");
  if (oldAcct.household_id !== newAcct.household_id) throw new Error("Accounts belong to different households");
  const oldTx = await loadTxns(client, oldAcct.id);
  const newTx = await loadTxns(client, newAcct.id);
  // Only rows not already tied to Plaid can be adopted.
  const adoptable = oldTx.filter((t) => t.provider !== "plaid");
  const matches = matchRows(
    newTx.map((t) => ({ key: t.id, date: t.date, amount: t.amount })),
    adoptable.map((t) => ({ key: t.id, date: t.date, amount: t.amount })),
  );
  return { oldAcct, newAcct, oldTx, newTx, matches };
}

function describePlan(p) {
  return {
    keep: `${p.oldAcct.name} (${p.oldAcct.id.slice(0, 8)}, ${p.oldTx.length} txns)`,
    replaceWith: `${p.newAcct.name} (${p.newAcct.id.slice(0, 8)}, ${p.newTx.length} txns)`,
    adopted: p.matches.size,
    movedIn: p.newTx.length - p.matches.size,
    oldRowsStayingAsIs: p.oldTx.length - p.matches.size,
  };
}

export async function suggest(client) {
  const { rows: olds } = await client.query(
    `select a.id, a.name from accounts a join bank_connections c on c.id = a.bank_connection_id
      where c.provider = 'simplefin' and a.deleted_at is null and c.id not like 'demo-%' order by a.name`,
  );
  const { rows: news } = await client.query(
    `select a.id, a.name from accounts a join bank_connections c on c.id = a.bank_connection_id
      where c.provider = 'plaid' and a.deleted_at is null and c.id not like 'demo-%' order by a.name`,
  );
  const out = [];
  for (const o of olds) {
    const oTx = (await loadTxns(client, o.id)).filter((t) => t.provider !== "plaid");
    for (const n of news) {
      const nTx = await loadTxns(client, n.id);
      if (nTx.length === 0 || oTx.length === 0) continue;
      const m = matchRows(
        nTx.map((t) => ({ key: t.id, date: t.date, amount: t.amount })),
        oTx.map((t) => ({ key: t.id, date: t.date, amount: t.amount })),
      );
      if (m.size > 0) {
        out.push({
          old: `${o.name} (${o.id.slice(0, 8)}, ${oTx.length})`,
          new: `${n.name} (${n.id.slice(0, 8)}, ${nTx.length})`,
          shared: m.size,
          ofNew: `${Math.round((100 * m.size) / nTx.length)}%`,
        });
      }
    }
  }
  return out.sort((a, b) => b.shared - a.shared);
}

/** @typedef {{ pairs: string[][], drop?: string[], detach?: string[] }} MigrationOptions */

/** @param {any} client @param {MigrationOptions} opts */
export async function plan(client, { pairs, drop = [], detach = [] }) {
  const plans = [];
  for (const [o, n] of pairs) plans.push(describePlan(await planPair(client, o, n)));
  const drops = [];
  for (const prefix of drop) {
    const { rows } = await client.query(
      `select id, institution_name, provider from bank_connections where id like $1`, [`${prefix}%`]);
    if (rows.length !== 1 || rows[0].provider !== "simplefin") throw new Error(`--drop ${prefix} is not exactly one SimpleFIN connection`);
    drops.push(`${rows[0].institution_name} (${rows[0].id.slice(0, 8)})`);
  }
  const detaches = [];
  for (const prefix of detach) detaches.push((await resolveAccount(client, prefix, null)).name);
  return { pairs: plans, dropConnections: drops, detachToManual: detaches };
}

/** @param {any} client @param {MigrationOptions} opts */
export async function apply(client, { pairs, drop = [], detach = [] }) {
  await client.query("begin");
  try {
    const repointedOldIds = new Set();
    for (const [o, n] of pairs) {
      const p = await planPair(client, o, n);
      const A = p.oldAcct.id;
      const P = p.newAcct.id;
      const newById = new Map(p.newTx.map((t) => [t.id, t]));

      // 1. Adopt: the old row takes over the Plaid identity; drop the new duplicate.
      for (const [newId, oldId] of p.matches) {
        const np = newById.get(newId);
        await client.query(
          `update transactions set external_id = $1, provider = 'plaid', pending = $2, updated_at = now() where id = $3`,
          [np.external_id, np.pending, oldId],
        );
        await client.query(`update receipts set transaction_id = $1 where transaction_id = $2`, [oldId, newId]);
        await client.query(`delete from transactions where id = $1`, [newId]);
      }
      // 2. Move the Plaid-only rows into the old account.
      await client.query(`update transactions set account_id = $1 where account_id = $2`, [A, P]);
      // 3. Other things pointing at the new account follow the old one.
      await client.query(`update recurring_transactions set account_id = $1 where account_id = $2`, [A, P]);
      if (p.oldAcct.type === "investment") {
        // Plaid's holdings are fresher than SimpleFIN's last snapshot.
        await client.query(`delete from investment_holdings where account_id = $1`, [A]);
        await client.query(`update investment_holdings set account_id = $1 where account_id = $2`, [A, P]);
        await client.query(`update investment_transactions set account_id = $1 where account_id = $2`, [A, P]);
      }
      // 4. Re-point the old account at the Plaid connection, then remove the empty duplicate.
      const { rows: [np] } = await client.query(
        `select bank_connection_id, external_account_id, current_balance, available_balance, subtype, official_name from accounts where id = $1`, [P]);
      await client.query(`update accounts set external_account_id = null where id = $1`, [P]);
      await client.query(
        `update accounts set bank_connection_id = $1, external_account_id = $2, current_balance = $3,
                available_balance = $4, subtype = $5, official_name = coalesce($6, official_name), updated_at = now()
          where id = $7`,
        [np.bank_connection_id, np.external_account_id, np.current_balance, np.available_balance, np.subtype, np.official_name, A],
      );
      await client.query(`delete from accounts where id = $1`, [P]);
      repointedOldIds.add(A);
    }

    for (const prefix of detach) {
      const a = await resolveAccount(client, prefix, null);
      await client.query(`update accounts set bank_connection_id = null, external_account_id = null, updated_at = now() where id = $1`, [a.id]);
    }

    for (const prefix of drop) {
      const { rows } = await client.query(`select id, provider from bank_connections where id like $1`, [`${prefix}%`]);
      if (rows.length !== 1 || rows[0].provider !== "simplefin") throw new Error(`--drop ${prefix} is not exactly one SimpleFIN connection`);
      const { rows: left } = await client.query(
        `select id, name from accounts where bank_connection_id = $1 and deleted_at is null`, [rows[0].id]);
      if (left.length > 0) {
        throw new Error(`Refusing to drop connection ${prefix}: still has accounts ${left.map((a) => a.name).join(", ")}. Pair or --detach them first.`);
      }
      await client.query(`delete from bank_connections where id = $1`, [rows[0].id]);
    }
    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw err;
  }
}

// ---- CLI ----
function parseArgs(argv) {
  const mode = ["suggest", "plan", "apply"].includes(argv[0]) ? argv[0] : "plan";
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1].split(",").filter(Boolean) : [];
  };
  const pairs = flag("--pairs").map((s) => s.split("="));
  if (pairs.some((p) => p.length !== 2 || !p[0] || !p[1])) throw new Error("--pairs must look like OLD=NEW,OLD=NEW");
  return { mode, pairs, drop: flag("--drop"), detach: flag("--detach") };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { mode, pairs, drop, detach } = parseArgs(process.argv.slice(2));
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    if (mode === "suggest") console.table(await suggest(client));
    else if (mode === "plan") console.log(JSON.stringify(await plan(client, { pairs, drop, detach }), null, 2));
    else {
      await apply(client, { pairs, drop, detach });
      console.log("applied");
    }
  } finally {
    await client.end();
  }
}
