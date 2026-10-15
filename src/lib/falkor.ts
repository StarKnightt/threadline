import { FalkorDB } from "falkordb";

export const BRAIN = "threadline";
export const SHARED = "tl_shared";
export const memGraphName = (userId: string) => `tl_mem_${userId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 24)}`;

type Role = "ro" | "rw";
type Db = Awaited<ReturnType<typeof FalkorDB.connect>>;

const g = globalThis as unknown as { __tlDb?: Partial<Record<Role, Promise<Db>>> };
g.__tlDb ??= {};

function creds(role: Role) {
  const host = process.env.FALKORDB_HOST ?? "localhost";
  const port = Number(process.env.FALKORDB_PORT ?? 6379);
  const ro = role === "ro" && process.env.FALKORDB_RO_USERNAME;
  return {
    host,
    port,
    username: (ro ? process.env.FALKORDB_RO_USERNAME : process.env.FALKORDB_USERNAME) || undefined,
    password: (ro ? process.env.FALKORDB_RO_PASSWORD : process.env.FALKORDB_PASSWORD) || undefined,
  };
}

/** One client per role, reused across invocations of a warm serverless function. */
export function db(role: Role = "rw"): Promise<Db> {
  const cached = g.__tlDb![role];
  if (cached) return cached;
  const { host, port, username, password } = creds(role);
  const p = FalkorDB.connect({ socket: { host, port, connectTimeout: 8000 }, username, password }).then((client) => {
    client.on?.("error", () => {
      g.__tlDb![role] = undefined;
    });
    return client;
  });
  p.catch(() => {
    g.__tlDb![role] = undefined;
  });
  g.__tlDb![role] = p;
  return p;
}

export type Row = Record<string, unknown>;

export async function query<T = Row>(graph: string, cypher: string, params: Record<string, unknown> = {}, opts: { ro?: boolean; timeout?: number } = {}) {
  const client = await db(opts.ro ? "ro" : "rw");
  const gr = client.selectGraph(graph);
  const run = opts.ro ? gr.roQuery.bind(gr) : gr.query.bind(gr);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = await run<T>(cypher, { params: params as any, TIMEOUT: opts.timeout ?? 15000 });
  return { rows: (res.data ?? []) as T[], metadata: res.metadata };
}

export async function close() {
  for (const role of ["ro", "rw"] as Role[]) {
    const p = g.__tlDb![role];
    if (p) (await p).close();
    g.__tlDb![role] = undefined;
  }
}
