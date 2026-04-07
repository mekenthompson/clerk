import { readFileSync, existsSync } from "node:fs";
import { resolve, extname, join } from "node:path";
import { spawn } from "node:child_process";
import type { ClerkConfig } from "../config/schema.js";
import {
  handleGetAgents,
  handleStartAgent,
  handleStopAgent,
  handleRestartAgent,
  handleGetLogs,
} from "./api.js";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(),
    },
  });
}

function parseRoute(
  pathname: string,
  method: string
): { handler: string; params: Record<string, string> } | null {
  // GET /api/agents
  if (method === "GET" && pathname === "/api/agents") {
    return { handler: "getAgents", params: {} };
  }

  // GET /api/agents/:name/logs
  const logsMatch = pathname.match(/^\/api\/agents\/([^/]+)\/logs$/);
  if (method === "GET" && logsMatch) {
    return { handler: "getLogs", params: { name: logsMatch[1] } };
  }

  // POST /api/agents/:name/start
  const startMatch = pathname.match(/^\/api\/agents\/([^/]+)\/start$/);
  if (method === "POST" && startMatch) {
    return { handler: "startAgent", params: { name: startMatch[1] } };
  }

  // POST /api/agents/:name/stop
  const stopMatch = pathname.match(/^\/api\/agents\/([^/]+)\/stop$/);
  if (method === "POST" && stopMatch) {
    return { handler: "stopAgent", params: { name: stopMatch[1] } };
  }

  // POST /api/agents/:name/restart
  const restartMatch = pathname.match(/^\/api\/agents\/([^/]+)\/restart$/);
  if (method === "POST" && restartMatch) {
    return { handler: "restartAgent", params: { name: restartMatch[1] } };
  }

  return null;
}

export function startWebServer(config: ClerkConfig, port: number): void {
  const uiDir = resolve(import.meta.dirname, "ui");
  const wsClients = new Set<any>();

  const server = Bun.serve({
    port,
    fetch(req, server) {
      const url = new URL(req.url);
      const { pathname } = url;

      // Handle CORS preflight
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders() });
      }

      // WebSocket upgrade
      if (pathname === "/ws") {
        const upgraded = server.upgrade(req);
        if (!upgraded) {
          return new Response("WebSocket upgrade failed", { status: 400 });
        }
        return undefined as unknown as Response;
      }

      // API routes
      const route = parseRoute(pathname, req.method);
      if (route) {
        switch (route.handler) {
          case "getAgents":
            return jsonResponse(handleGetAgents(config));

          case "getLogs": {
            const lines = parseInt(url.searchParams.get("lines") ?? "50", 10);
            return jsonResponse(handleGetLogs(route.params.name, lines));
          }

          case "startAgent": {
            const agentName = route.params.name;
            if (!config.agents[agentName]) {
              return jsonResponse({ ok: false, error: `Unknown agent: ${agentName}` }, 404);
            }
            return jsonResponse(handleStartAgent(agentName));
          }

          case "stopAgent": {
            const agentName = route.params.name;
            if (!config.agents[agentName]) {
              return jsonResponse({ ok: false, error: `Unknown agent: ${agentName}` }, 404);
            }
            return jsonResponse(handleStopAgent(agentName));
          }

          case "restartAgent": {
            const agentName = route.params.name;
            if (!config.agents[agentName]) {
              return jsonResponse({ ok: false, error: `Unknown agent: ${agentName}` }, 404);
            }
            return jsonResponse(handleRestartAgent(agentName));
          }
        }
      }

      // Static files
      let filePath = pathname === "/" ? "/index.html" : pathname;
      const fullPath = join(uiDir, filePath);

      // Prevent directory traversal
      if (!fullPath.startsWith(uiDir)) {
        return new Response("Forbidden", { status: 403 });
      }

      if (existsSync(fullPath)) {
        const ext = extname(fullPath);
        const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
        const content = readFileSync(fullPath);
        return new Response(content, {
          headers: { "Content-Type": contentType, ...corsHeaders() },
        });
      }

      return new Response("Not Found", { status: 404, headers: corsHeaders() });
    },

    websocket: {
      open(ws) {
        wsClients.add(ws);
      },
      close(ws) {
        wsClients.delete(ws);
      },
      message(ws, message) {
        // Handle subscription requests for agent logs
        try {
          const data = JSON.parse(String(message));
          if (data.type === "subscribe" && data.agent) {
            const agentName = String(data.agent).replace(/[^a-zA-Z0-9_-]/g, "");
            const child = spawn(
              "journalctl",
              ["--user", "-u", `clerk-${agentName}`, "-f", "--no-pager", "-n", "20"],
              { stdio: ["ignore", "pipe", "pipe"] }
            );

            child.stdout.on("data", (chunk: Buffer) => {
              try {
                ws.send(JSON.stringify({
                  type: "log",
                  agent: agentName,
                  data: chunk.toString("utf-8"),
                }));
              } catch {
                // Client disconnected
                child.kill();
              }
            });

            child.stderr.on("data", (chunk: Buffer) => {
              try {
                ws.send(JSON.stringify({
                  type: "log_error",
                  agent: agentName,
                  data: chunk.toString("utf-8"),
                }));
              } catch {
                child.kill();
              }
            });

            // Store child reference for cleanup
            (ws as any)._logProcess = child;
          }
        } catch {
          // Ignore invalid messages
        }
      },
    },
  });

  console.log(`Clerk dashboard running at http://localhost:${server.port}`);
}
