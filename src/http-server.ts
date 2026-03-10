// ============================================================
// HTTP Streamable transport for remote/cloud MCP clients
// Activated via MCP_MODE=http environment variable
// ============================================================

import express from "express";
import type { Request, Response } from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

const AUTH_TOKEN = process.env.AUTH_TOKEN;
const sessions = new Map<string, StreamableHTTPServerTransport>();

function authMiddleware(req: Request, res: Response, next: () => void): void {
  const header = req.headers.authorization;
  if (!header || header !== `Bearer ${AUTH_TOKEN}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

export async function startHttpServer(server: Server): Promise<void> {
  if (!AUTH_TOKEN) {
    console.error("Error: AUTH_TOKEN is required for HTTP mode.");
    process.exit(1);
  }

  const port = parseInt(process.env.PORT ?? process.env.MCP_PORT ?? "3000", 10);
  const host = process.env.MCP_HOST ?? "0.0.0.0";

  const app = express();
  app.use(express.json());

  app.post("/mcp", authMiddleware, async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (sessionId && sessions.has(sessionId)) {
      const transport = sessions.get(sessionId)!;
      await transport.handleRequest(req, res, req.body);
      return;
    }

    if (isInitializeRequest(req.body)) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) sessions.delete(sid);
      };

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);

      if (transport.sessionId) {
        sessions.set(transport.sessionId, transport);
      }
      return;
    }

    res.status(400).json({ error: "Bad Request: No valid session or initialize request" });
  });

  app.get("/mcp", authMiddleware, async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !sessions.has(sessionId)) {
      res.status(400).json({ error: "Bad Request: No valid session" });
      return;
    }
    const transport = sessions.get(sessionId)!;
    await transport.handleRequest(req, res);
  });

  app.delete("/mcp", authMiddleware, async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (sessionId && sessions.has(sessionId)) {
      const transport = sessions.get(sessionId)!;
      await transport.close();
      sessions.delete(sessionId);
    }
    res.status(200).json({ ok: true });
  });

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", sessions: sessions.size });
  });

  const httpServer = app.listen(port, host, () => {
    console.error(`n8n-mcp-lite server started (HTTP Streamable transport)`);
    console.error(`Listening on http://${host}:${port}/mcp`);
  });

  const shutdown = async () => {
    for (const transport of sessions.values()) {
      await transport.close();
    }
    sessions.clear();
    httpServer.close();
    await server.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
