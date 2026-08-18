import { Hono } from "hono";
import type { Session } from "./tools/auth.ts";
import { exposePrismaCRUD, prisma } from "./tools/prisma.ts";
import { handleFileUpload } from "./tools/fileUpload.ts";
import { getIntrospection } from "./tools/etl/introspect.ts";
import {
  compileGraph,
  CompileError,
  type GraphEdge,
  type GraphNode,
} from "./tools/etl/compiler.ts";
import { buildImportedGraph, ImportError } from "./tools/etl/importGraph.ts";

export function publicRoutes(app: Hono): void {
  app.get("/hello", (c) => c.json({ message: "Hello World" }));

  app.post("/file-upload", async (c) => {
    const result = await handleFileUpload(c);
    console.log("File upload result:", result);
    return "error" in result ? c.json(result, 400) : c.json(result, 201);
  });

  app.post("/json", async (c) => {
    const data = await c.req.json();
    console.log("Received JSON:", data);
    return c.json({ received: data });
  });
}

export function privateRoutes(app: Hono): void {
  app.get("/user", (c) => {
    const session = (c as any).get("session") as Session;
    return c.json(
      session.cas_data || session.google_data || session.microsoft_data || {},
    );
  });

  exposePrismaCRUD("api", app);

  app.get("/etl/schema", async (c) => {
    const tables = await getIntrospection();
    return c.json({ tables });
  });

  app.post("/etl/run", async (c) => {
    const body = await c.req.json<{
      nodes: GraphNode[];
      edges: GraphEdge[];
      targetNodeId: string;
      targetHandle?: string | null;
      limit?: number;
      mode?: "rows" | "count";
    }>();
    try {
      const compiled = await compileGraph(
        body.nodes,
        body.edges,
        body.targetNodeId,
        body.targetHandle,
      );

      if (body.mode === "count") {
        const countSql = `SELECT COUNT(*)::text AS count FROM (${compiled.sql}) AS _count_sub`;
        const rows = await prisma.$queryRawUnsafe<{ count: string }[]>(
          countSql,
          ...compiled.values,
        );
        return c.json({ count: Number(rows[0]?.count ?? 0) });
      }

      const cappedLimit = Math.max(
        1,
        Math.min(Number(body.limit) || 100, 1000),
      );
      const sql = `${compiled.sql} LIMIT ${cappedLimit}`;
      const rows = await prisma.$queryRawUnsafe(sql, ...compiled.values);
      return c.json({
        sql,
        columns: compiled.columns,
        rows: JSON.parse(
          JSON.stringify(rows, (_key, value) =>
            typeof value === "bigint" ? value.toString() : value,
          ),
        ),
      });
    } catch (e) {
      if (e instanceof CompileError) {
        return c.json({ error: e.message, nodeId: e.nodeId }, 400);
      }
      console.error("ETL run error:", e);
      return c.json({ error: String((e as Error).message || e) }, 500);
    }
  });

  app.post("/etl/import", async (c) => {
    const body = await c.req.json<{ sql: string }>();
    if (!body.sql || typeof body.sql !== "string") {
      return c.json({ error: "Missing sql text" }, 400);
    }
    try {
      const graph = await buildImportedGraph(body.sql);
      return c.json(graph);
    } catch (e) {
      if (e instanceof ImportError) {
        return c.json({ error: e.message }, 400);
      }
      console.error("ETL import error:", e);
      return c.json({ error: String((e as Error).message || e) }, 500);
    }
  });
}

export async function onLogin(session: Session): Promise<void> {
  console.log(
    "User logged in:",
    session.cas_data || session.google_data || session.microsoft_data,
  );
}

/* session.google_data

{
  iss: 'https://accounts.google.com',
  azp: '...',
  aud: '...',
  sub: '103589682456946370010',
  email: 'southwickmatthias@gmail.com',
  email_verified: true,
  name: 'Matthias Southwick',
  picture: 'https://lh3.googleusercontent.com/...',
  given_name: 'Matthias',
  family_name: 'Southwick',
  iat: 1723081204,
  exp: 1723084804,
}

*/
/* session.microsoft_data: {
  '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#users/$entity',
  userPrincipalName: 'Southwickmatthias@gmail.com',
  id: '4a1639e4ad5f1ca5',
  displayName: 'Matthias Southwick',
  surname: 'Southwick',
  givenName: 'Matthias',
  preferredLanguage: 'en-US',
  mail: null,
  mobilePhone: null,
  jobTitle: null,
  officeLocation: null,
  businessPhones: []
}

*/
