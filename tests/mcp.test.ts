import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, "..");
const entrypoint = resolve(projectRoot, "dist/index.js");

function startServer(cwd = projectRoot) {
  return spawn("node", [entrypoint, "--mcp"], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

async function readFramedResponse(child: ReturnType<typeof startServer>, timeoutMs = 1500) {
  const stdout = child.stdout;
  if (!stdout) throw new Error("stdout unavailable");

  return await new Promise<any>((resolvePromise, reject) => {
    let buffer = Buffer.alloc(0);

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for MCP response after ${timeoutMs}ms`));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      stdout.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
    }

    function onError(error: Error) {
      cleanup();
      reject(error);
    }

    function onExit(code: number | null, signal: NodeJS.Signals | null) {
      cleanup();
      reject(new Error(`MCP process exited before response (code=${code}, signal=${signal})`));
    }

    function onData(chunk: Buffer) {
      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;

      const header = buffer.subarray(0, headerEnd).toString("utf8");
      const lengthMatch = header.match(/Content-Length:\s*(\d+)/i);
      if (!lengthMatch) {
        cleanup();
        reject(new Error(`Missing Content-Length header: ${header}`));
        return;
      }

      const contentLength = Number.parseInt(lengthMatch[1], 10);
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + contentLength) return;

      const body = buffer.subarray(bodyStart, bodyStart + contentLength).toString("utf8");
      cleanup();
      resolvePromise(JSON.parse(body));
    }

    stdout.on("data", onData);
    child.on("error", onError);
    child.on("exit", onExit);
  });
}

async function readLineResponse(child: ReturnType<typeof startServer>, timeoutMs = 1500) {
  const stdout = child.stdout;
  if (!stdout) throw new Error("stdout unavailable");

  return await new Promise<any>((resolvePromise, reject) => {
    let buffer = "";

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for newline MCP response after ${timeoutMs}ms`));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      stdout.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
    }

    function onError(error: Error) {
      cleanup();
      reject(error);
    }

    function onExit(code: number | null, signal: NodeJS.Signals | null) {
      cleanup();
      reject(new Error(`MCP process exited before line response (code=${code}, signal=${signal})`));
    }

    function onData(chunk: Buffer) {
      buffer += chunk.toString("utf8");
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) return;

      const line = buffer.slice(0, newlineIndex).trim();
      cleanup();
      resolvePromise(JSON.parse(line));
    }

    stdout.on("data", onData);
    child.on("error", onError);
    child.on("exit", onExit);
  });
}

function writeFramedMessage(child: ReturnType<typeof startServer>, payload: unknown) {
  const input = child.stdin;
  if (!input) throw new Error("stdin unavailable");
  const body = JSON.stringify(payload);
  input.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

function writeLineMessage(child: ReturnType<typeof startServer>, payload: unknown) {
  const input = child.stdin;
  if (!input) throw new Error("stdin unavailable");
  input.write(`${JSON.stringify(payload)}\n`);
}

async function stopServer(child: ReturnType<typeof startServer>) {
  child.kill("SIGTERM");
  await new Promise((resolvePromise) => child.once("exit", () => resolvePromise(undefined)));
}

async function initializeServer(child: ReturnType<typeof startServer>) {
  writeFramedMessage(child, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test-client", version: "1.0.0" },
    },
  });

  const response = await readFramedResponse(child);
  assert.equal(response.jsonrpc, "2.0");
  assert.equal(response.id, 1);
  assert.equal(response.result?.serverInfo?.name, "codesight");
}

test("MCP server responds to Content-Length framed initialize", async () => {
  const child = startServer();
  try {
    writeFramedMessage(child, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      },
    });

    const response = await readFramedResponse(child);
    assert.equal(response.jsonrpc, "2.0");
    assert.equal(response.id, 1);
    assert.equal(response.result?.serverInfo?.name, "codesight");
  } finally {
    await stopServer(child);
  }
});

test("MCP server responds to newline-delimited initialize used by Claude health checks", async () => {
  const child = startServer();
  try {
    writeLineMessage(child, {
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {
          roots: {},
          elicitation: {},
        },
        clientInfo: {
          name: "claude-code",
          title: "Claude Code",
          version: "2.1.96",
          description: "Anthropic's agentic coding tool",
          websiteUrl: "https://claude.com/claude-code",
        },
      },
    });

    const response = await readLineResponse(child);
    assert.equal(response.jsonrpc, "2.0");
    assert.equal(response.id, 0);
    assert.equal(response.result?.serverInfo?.name, "codesight");
  } finally {
    await stopServer(child);
  }
});

test("MCP server waits for full framed headers split across chunks", async () => {
  const child = startServer();
  try {
    const input = child.stdin;
    if (!input) throw new Error("stdin unavailable");

    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "chunked-client", version: "1.0.0" },
      },
    });

    input.write(`Content-Length: ${Buffer.byteLength(payload)}\r\n`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    input.write(`\r\n${payload}`);

    const response = await readFramedResponse(child);
    assert.equal(response.jsonrpc, "2.0");
    assert.equal(response.id, 2);
    assert.equal(response.result?.serverInfo?.name, "codesight");
  } finally {
    await stopServer(child);
  }
});

test("MCP server lists CodeMap claim tools alongside legacy Codesight tools", async () => {
  const child = startServer();
  try {
    await initializeServer(child);

    writeFramedMessage(child, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });

    const response = await readFramedResponse(child);
    const toolNames = (response.result?.tools ?? []).map((tool: { name: string }) => tool.name);

    assert.ok(toolNames.includes("codesight_get_summary"));
    assert.ok(toolNames.includes("codemap_get_overview"));
    assert.ok(toolNames.includes("codemap_get_knowledge_overview"));
    assert.ok(toolNames.includes("codemap_search_claims"));
    assert.ok(toolNames.includes("codemap_search_knowledge"));
    assert.ok(toolNames.includes("codemap_get_claim"));
    assert.ok(toolNames.includes("codemap_get_claim_evidence"));
    assert.ok(toolNames.includes("codemap_get_claim_history"));
    assert.ok(toolNames.includes("codemap_get_claim_state_history"));
    assert.ok(toolNames.includes("codemap_verify_claim"));
    assert.ok(toolNames.includes("codemap_diff_since_snapshot"));
    assert.ok(toolNames.includes("codemap_get_publish_run"));
    assert.ok(toolNames.includes("codemap_get_publish_status"));
    assert.ok(toolNames.includes("codemap_get_conflicts"));
  } finally {
    await stopServer(child);
  }
});

test("MCP server serves canonical CodeMap claim tools and materializes .codemap on demand", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "codemap-mcp-"));
  try {
    const srcDir = join(repoRoot, "src");
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(repoRoot, "package.json"), JSON.stringify({
      name: "codemap-mcp",
      dependencies: {
        express: "^4.0.0",
      },
    }, null, 2), "utf-8");
    await writeFile(
      join(srcDir, "routes.ts"),
      [
        'import { Router } from "express";',
        "const router = Router();",
        'router.get("/users", (_req, res) => res.json([]));',
        "export default router;",
        "",
      ].join("\n"),
      "utf-8",
    );

    const child = startServer(repoRoot);
    try {
      await initializeServer(child);

      writeFramedMessage(child, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "codemap_get_overview",
          arguments: {},
        },
      });

      const overview = await readFramedResponse(child);
      const overviewText = overview.result?.content?.[0]?.text ?? "";
      assert.match(overviewText, /CodeMap Overview/);
      assert.match(overviewText, /route/);

      writeFramedMessage(child, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "codemap_search_claims",
          arguments: {
            query: "users",
            type: "route",
          },
        },
      });

      const search = await readFramedResponse(child);
      const searchText = search.result?.content?.[0]?.text ?? "";
      assert.match(searchText, /matching CodeMap claim/);
      assert.match(searchText, /GET \/users/);

      writeFramedMessage(child, {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "codemap_get_claim",
          arguments: {
            subject: "GET /users",
          },
        },
      });

      const claim = await readFramedResponse(child);
      const claimText = claim.result?.content?.[0]?.text ?? "";
      assert.match(claimText, /Subject: GET \/users/);
      assert.match(claimText, /Verification/);

      writeFramedMessage(child, {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "codemap_get_claim_evidence",
          arguments: {
            subject: "GET /users",
          },
        },
      });

      const evidence = await readFramedResponse(child);
      const evidenceText = evidence.result?.content?.[0]?.text ?? "";
      assert.match(evidenceText, /Evidence for claim:/);
      assert.match(evidenceText, /src\/routes\.ts/);

      writeFramedMessage(child, {
        jsonrpc: "2.0",
        id: 55,
        method: "tools/call",
        params: {
          name: "codemap_get_claim_history",
          arguments: {
            subject: "GET /users",
          },
        },
      });

      const history = await readFramedResponse(child);
      const historyText = history.result?.content?.[0]?.text ?? "";
      assert.match(historyText, /Verification history for/);
      assert.match(historyText, /line-exists/);

      writeFramedMessage(child, {
        jsonrpc: "2.0",
        id: 56,
        method: "tools/call",
        params: {
          name: "codemap_get_claim_state_history",
          arguments: {
            subject: "GET /users",
          },
        },
      });

      const stateHistory = await readFramedResponse(child);
      const stateHistoryText = stateHistory.result?.content?.[0]?.text ?? "";
      assert.match(stateHistoryText, /Claim-state history for/);
      assert.match(stateHistoryText, /GET \/users/);

      writeFramedMessage(child, {
        jsonrpc: "2.0",
        id: 57,
        method: "tools/call",
        params: {
          name: "codemap_verify_claim",
          arguments: {
            subject: "GET /users",
          },
        },
      });

      const verify = await readFramedResponse(child);
      const verifyText = verify.result?.content?.[0]?.text ?? "";
      assert.match(verifyText, /Verify claim/);
      assert.match(verifyText, /Verdict: warning/);
      assert.match(verifyText, /Source snapshots/);

      writeFramedMessage(child, {
        jsonrpc: "2.0",
        id: 58,
        method: "tools/call",
        params: {
          name: "codemap_diff_since_snapshot",
          arguments: {
            source_path: "src/routes.ts",
          },
        },
      });

      const diff = await readFramedResponse(child);
      const diffText = diff.result?.content?.[0]?.text ?? "";
      assert.match(diffText, /Snapshot diff for/);
      assert.match(diffText, /Current state: unchanged/);
      assert.match(diffText, /GET \/users/);

      writeFramedMessage(child, {
        jsonrpc: "2.0",
        id: 59,
        method: "tools/call",
        params: {
          name: "codemap_get_publish_status",
          arguments: {},
        },
      });

      const status = await readFramedResponse(child);
      const statusText = status.result?.content?.[0]?.text ?? "";
      assert.match(statusText, /CodeMap publish status/);
      assert.match(statusText, /Latest run:/);
      assert.match(statusText, /Publish plan/);

      writeFramedMessage(child, {
        jsonrpc: "2.0",
        id: 60,
        method: "tools/call",
        params: {
          name: "codemap_get_publish_run",
          arguments: {
            latest: true,
          },
        },
      });

      const run = await readFramedResponse(child);
      const runText = run.result?.content?.[0]?.text ?? "";
      assert.match(runText, /Publish run/);
      assert.match(runText, /Claim-state changes/);
      assert.match(runText, /Verification changes/);
      assert.match(runText, /GET \/users/);

      writeFramedMessage(child, {
        jsonrpc: "2.0",
        id: 61,
        method: "tools/call",
        params: {
          name: "codemap_get_conflicts",
          arguments: {
            limit: 5,
          },
        },
      });

      const conflicts = await readFramedResponse(child);
      const conflictsText = conflicts.result?.content?.[0]?.text ?? "";
      assert.match(conflictsText, /No conflicts found/);
    } finally {
      await stopServer(child);
    }

    const claimsNdjson = await readFile(join(repoRoot, ".codemap", "claims", "claims.ndjson"), "utf-8");
    assert.match(claimsNdjson, /"type":"route"/);
    assert.match(claimsNdjson, /"subject":"GET \/users"/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("MCP CodeMap tools scope claim queries to impacted files", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "codemap-mcp-scope-"));
  try {
    const routesDir = join(repoRoot, "src", "routes");
    await mkdir(routesDir, { recursive: true });
    await writeFile(join(repoRoot, "package.json"), JSON.stringify({
      name: "codemap-mcp-scope",
      dependencies: {
        express: "^4.0.0",
      },
    }, null, 2), "utf-8");
    await writeFile(
      join(routesDir, "users.ts"),
      [
        'import { Router } from "express";',
        "const router = Router();",
        'router.get("/users", (_req, res) => res.json([]));',
        "export default router;",
        "",
      ].join("\n"),
      "utf-8",
    );
    await writeFile(
      join(routesDir, "admin.ts"),
      [
        'import { Router } from "express";',
        "const router = Router();",
        'router.get("/admin", (_req, res) => res.json([]));',
        "export default router;",
        "",
      ].join("\n"),
      "utf-8",
    );

    const child = startServer(repoRoot);
    try {
      await initializeServer(child);

      writeFramedMessage(child, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "codemap_search_claims",
          arguments: {
            type: "route",
            changed_files: ["src/routes/users.ts"],
            impact_depth: 0,
          },
        },
      });

      const search = await readFramedResponse(child);
      const searchText = search.result?.content?.[0]?.text ?? "";
      assert.match(searchText, /GET \/users/);
      assert.doesNotMatch(searchText, /GET \/admin/);

      writeFramedMessage(child, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "codemap_get_claim",
          arguments: {
            subject: "GET /admin",
            changed_files: ["src/routes/users.ts"],
            impact_depth: 0,
          },
        },
      });

      const claim = await readFramedResponse(child);
      const claimText = claim.result?.content?.[0]?.text ?? "";
      assert.match(claimText, /Claim not found/);

      writeFramedMessage(child, {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "codemap_get_claim_history",
          arguments: {
            subject: "GET /users",
            changed_files: ["src/routes/users.ts"],
            impact_depth: 0,
          },
        },
      });

      const history = await readFramedResponse(child);
      const historyText = history.result?.content?.[0]?.text ?? "";
      assert.match(historyText, /Verification history for/);
      assert.match(historyText, /GET \/users/);

      writeFramedMessage(child, {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "codemap_get_claim_state_history",
          arguments: {
            subject: "GET /users",
            changed_files: ["src/routes/users.ts"],
            impact_depth: 0,
          },
        },
      });

      const stateHistory = await readFramedResponse(child);
      const stateHistoryText = stateHistory.result?.content?.[0]?.text ?? "";
      assert.match(stateHistoryText, /Claim-state history for/);
      assert.match(stateHistoryText, /GET \/users/);
    } finally {
      await stopServer(child);
    }
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("MCP server materializes knowledge claims and compatibility knowledge on demand", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "codemap-mcp-knowledge-"));
  try {
    const notesDir = join(repoRoot, "notes");
    await mkdir(notesDir, { recursive: true });
    await writeFile(
      join(notesDir, "adr-001-payments.md"),
      [
        "---",
        "title: Payments ADR",
        "tags: [payments, architecture]",
        "project: Codemap",
        "---",
        "",
        "# Payments ADR",
        "",
        "## Decision",
        "",
        "We decided to use Polar for the initial marketplace launch.",
        "",
      ].join("\n"),
      "utf-8",
    );
    await writeFile(
      join(notesDir, "2026-04-22-sync.md"),
      [
        "---",
        "title: Product Sync",
        "tags: [payments, open-question]",
        "---",
        "",
        "# Product Sync",
        "",
        "Attendees: Alex Rivera, Sam Lee",
        "",
        "## Payments",
        "",
        "How should we handle refunds across Stripe and Polar?",
        "",
        "Alex Rivera will draft an experiment plan.",
        "",
      ].join("\n"),
      "utf-8",
    );

    const child = startServer(repoRoot);
    try {
      await initializeServer(child);

      writeFramedMessage(child, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "codemap_get_knowledge_overview",
          arguments: {},
        },
      });

      const overview = await readFramedResponse(child);
      const overviewText = overview.result?.content?.[0]?.text ?? "";
      assert.match(overviewText, /CodeMap Knowledge Overview/);
      assert.match(overviewText, /Key Decisions/);
      assert.match(overviewText, /Polar/);
      assert.match(overviewText, /Open Questions/);

      writeFramedMessage(child, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "codemap_search_knowledge",
          arguments: {
            query: "Polar",
          },
        },
      });

      const search = await readFramedResponse(child);
      const searchText = search.result?.content?.[0]?.text ?? "";
      assert.match(searchText, /matching CodeMap claim/);
      assert.match(searchText, /knowledge_decision/);
      assert.match(searchText, /Polar/);

      writeFramedMessage(child, {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "codemap_get_claim",
          arguments: {
            subject: "Alex Rivera",
          },
        },
      });

      const claim = await readFramedResponse(child);
      const claimText = claim.result?.content?.[0]?.text ?? "";
      assert.match(claimText, /Type: knowledge_person/);
      assert.match(claimText, /Subject: Alex Rivera/);

      writeFramedMessage(child, {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "codesight_get_knowledge",
          arguments: {},
        },
      });

      const knowledge = await readFramedResponse(child);
      const knowledgeText = knowledge.result?.content?.[0]?.text ?? "";
      assert.match(knowledgeText, /# Knowledge Map/);
      assert.match(knowledgeText, /## Key Decisions/);
      assert.match(knowledgeText, /Polar/);
      assert.match(knowledgeText, /## Open Questions/);
    } finally {
      await stopServer(child);
    }

    const compatibilityKnowledge = await readFile(join(repoRoot, ".codemap", "compatibility", "KNOWLEDGE.md"), "utf-8");
    assert.match(compatibilityKnowledge, /Polar/);
    assert.match(compatibilityKnowledge, /Alex Rivera/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});
