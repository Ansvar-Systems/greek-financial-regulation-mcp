#!/usr/bin/env node

/**
 * Greek Financial Regulation MCP — stdio entry point.
 *
 * Provides MCP tools for querying HCMC (Hellenic Capital Market Commission)
 * decisions, circulars, and Bank of Greece Governor's Acts on financial supervision.
 *
 * Tool prefix: gr_fin_
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  listSourcebooks,
  searchProvisions,
  getProvision,
  searchEnforcement,
  checkProvisionCurrency,
} from "./db.js";
import { buildCitation } from "./utils/citation.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let pkgVersion = "0.1.0";
try {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "package.json"), "utf8"),
  ) as { version: string };
  pkgVersion = pkg.version;
} catch {
  // fallback to default
}

const SERVER_NAME = "greek-financial-regulation-mcp";

// --- Tool definitions ---

const TOOLS = [
  {
    name: "gr_fin_search_regulations",
    description:
      "Full-text search across HCMC and Bank of Greece regulatory provisions. Returns matching decisions (apofaseis), circulars (egkyklioi), and Governor's Acts (Praxeis Dioikiti) on capital markets and banking supervision in Greece.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query in Greek or English (e.g., 'επενδυτικές υπηρεσίες', 'AML', 'investment services', 'capital adequacy')",
        },
        sourcebook: {
          type: "string",
          description: "Filter by sourcebook ID (e.g., HCMC_Apofaseis, HCMC_Egkyklioi, BOG_Praxeis_Dioikiti). Optional.",
        },
        status: {
          type: "string",
          enum: ["in_force", "deleted", "not_yet_in_force"],
          description: "Filter by provision status. Defaults to all statuses.",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return. Defaults to 20.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "gr_fin_get_regulation",
    description:
      "Get a specific HCMC or Bank of Greece provision by sourcebook and reference.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sourcebook: {
          type: "string",
          description: "Sourcebook identifier (e.g., HCMC_Apofaseis, BOG_Praxeis_Dioikiti)",
        },
        reference: {
          type: "string",
          description: "Provision reference (e.g., 'HCMC_1/452/1.11.2007', 'BOG_EXEC_273_1_2021')",
        },
      },
      required: ["sourcebook", "reference"],
    },
  },
  {
    name: "gr_fin_list_sourcebooks",
    description:
      "List all HCMC and Bank of Greece sourcebook categories with their names and descriptions.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "gr_fin_search_enforcement",
    description:
      "Search HCMC and Bank of Greece enforcement actions — sanctions, fines, activity revocations, and public censures.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query (e.g., firm name, breach type, 'market abuse', 'ξέπλυμα χρήματος')",
        },
        action_type: {
          type: "string",
          enum: ["fine", "ban", "restriction", "warning"],
          description: "Filter by action type. Optional.",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return. Defaults to 20.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "gr_fin_check_currency",
    description:
      "Check whether a specific HCMC or Bank of Greece provision reference is currently in force.",
    inputSchema: {
      type: "object" as const,
      properties: {
        reference: {
          type: "string",
          description: "Provision reference to check (e.g., 'HCMC_1/452/1.11.2007')",
        },
      },
      required: ["reference"],
    },
  },
  {
    name: "gr_fin_about",
    description: "Return metadata about this MCP server: version, data source, tool list.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
];

// --- Zod schemas ---

const SearchRegulationsArgs = z.object({
  query: z.string().min(1),
  sourcebook: z.string().optional(),
  status: z.enum(["in_force", "deleted", "not_yet_in_force"]).optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const GetRegulationArgs = z.object({
  sourcebook: z.string().min(1),
  reference: z.string().min(1),
});

const SearchEnforcementArgs = z.object({
  query: z.string().min(1),
  action_type: z.enum(["fine", "ban", "restriction", "warning"]).optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const CheckCurrencyArgs = z.object({
  reference: z.string().min(1),
});

// --- Helper ---

function textContent(data: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(data, null, 2) },
    ],
  };
}

function errorContent(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true as const,
  };
}

// --- Server setup ---

const server = new Server(
  { name: SERVER_NAME, version: pkgVersion },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    switch (name) {
      case "gr_fin_search_regulations": {
        const parsed = SearchRegulationsArgs.parse(args);
        const results = searchProvisions({
          query: parsed.query,
          sourcebook: parsed.sourcebook,
          status: parsed.status,
          limit: parsed.limit,
        });
        return textContent({ results, count: results.length });
      }

      case "gr_fin_get_regulation": {
        const parsed = GetRegulationArgs.parse(args);
        const provision = getProvision(parsed.sourcebook, parsed.reference);
        if (!provision) {
          return errorContent(
            `Provision not found: ${parsed.sourcebook} ${parsed.reference}`,
          );
        }
        const p = provision as Record<string, unknown>;
        return textContent({
          ...provision,
          _citation: buildCitation(
            `${parsed.sourcebook} ${String(p.reference ?? parsed.reference)}`,
            String(p.title ?? `${parsed.sourcebook} ${parsed.reference}`),
            "gr_fin_get_regulation",
            { sourcebook: parsed.sourcebook, reference: parsed.reference },
            p.url as string | undefined,
          ),
        });
      }

      case "gr_fin_list_sourcebooks": {
        const sourcebooks = listSourcebooks();
        return textContent({ sourcebooks, count: sourcebooks.length });
      }

      case "gr_fin_search_enforcement": {
        const parsed = SearchEnforcementArgs.parse(args);
        const results = searchEnforcement({
          query: parsed.query,
          action_type: parsed.action_type,
          limit: parsed.limit,
        });
        return textContent({ results, count: results.length });
      }

      case "gr_fin_check_currency": {
        const parsed = CheckCurrencyArgs.parse(args);
        const currency = checkProvisionCurrency(parsed.reference);
        return textContent(currency);
      }

      case "gr_fin_about": {
        return textContent({
          name: SERVER_NAME,
          version: pkgVersion,
          description:
            "HCMC (Hellenic Capital Market Commission) and Bank of Greece MCP server. Provides access to Greek financial supervision decisions, circulars, and Governor's Acts.",
          data_source: "HCMC (https://www.hcmc.gr/) and Bank of Greece (https://www.bankofgreece.gr/)",
          tools: TOOLS.map((t) => ({ name: t.name, description: t.description })),
        });
      }

      default:
        return errorContent(`Unknown tool: ${name}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorContent(`Error executing ${name}: ${message}`);
  }
});

// --- Main ---

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`${SERVER_NAME} v${pkgVersion} running on stdio\n`);
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
