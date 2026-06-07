/**
 * SumoLogic MCP Server with Context Awareness
 *
 * Enhanced implementation with configurable source mappings and contextual
 * awareness. stdio transport only.
 */

import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import axios, { AxiosInstance, AxiosError } from "axios";
import dotenv from "dotenv";
import fs from "fs/promises";
import path from "path";

// Load environment variables
// quiet: dotenv >=17 prints a tip banner to stdout by default, which would
// corrupt the stdio JSON-RPC stream. Suppress it.
dotenv.config({ quiet: true });

// Configuration interfaces
interface SourceMapping {
  sourceCategory: string;
  sourceName?: string;
  description: string;
  commonFilters?: string[];
  sampleQueries?: string[];
  namespaces?: string[];
}

interface Environment {
  applications: Record<string, SourceMapping>;
  infrastructure: Record<string, SourceMapping>;
}

interface Shortcut {
  description: string;
  queryTemplate: string;
  timeRange?: string;
  defaultParams?: Record<string, string>;
}

interface SumoLogicContext {
  version: string;
  organization: string;
  environments: Record<string, Environment>;
  shortcuts: Record<string, Shortcut>;
  commonFields: Record<string, string>;
}

// API constants
const SUMOLOGIC_ACCESS_ID = process.env.SUMOLOGIC_ACCESS_ID || "";
const SUMOLOGIC_ACCESS_KEY = process.env.SUMOLOGIC_ACCESS_KEY || "";
const SUMOLOGIC_API_ENDPOINT =
  process.env.SUMOLOGIC_API_ENDPOINT || "https://api.sumologic.com/api";
const CONTEXT_CONFIG_PATH =
  process.env.SUMOLOGIC_CONTEXT_CONFIG || "./sumologic-context.json";
const DEFAULT_ENVIRONMENT = process.env.SUMOLOGIC_DEFAULT_ENV || "production";

// Validate credentials
if (!SUMOLOGIC_ACCESS_ID || !SUMOLOGIC_ACCESS_KEY) {
  console.error(
    '[sumologic] SUMOLOGIC_ACCESS_ID and SUMOLOGIC_ACCESS_KEY environment variables are required. Set them in your MCP server config\'s "env" block.',
  );
  process.exit(1);
}

// Create axios instance
const sumoLogicClient: AxiosInstance = axios.create({
  baseURL: SUMOLOGIC_API_ENDPOINT,
  auth: {
    username: SUMOLOGIC_ACCESS_ID,
    password: SUMOLOGIC_ACCESS_KEY,
  },
  headers: {
    "Content-Type": "application/json",
    Accept: "application/json",
  },
});

// Global context storage
let contextConfig: SumoLogicContext | null = null;

// Load context configuration
async function loadContextConfig(): Promise<SumoLogicContext | null> {
  try {
    const configPath = path.resolve(CONTEXT_CONFIG_PATH);
    const configData = await fs.readFile(configPath, "utf-8");
    const config = JSON.parse(configData) as SumoLogicContext;
    console.error(
      `[sumologic] loaded context configuration from ${configPath}`,
    );
    return config;
  } catch (error) {
    console.error(
      `[sumologic] warning: could not load context configuration from ${CONTEXT_CONFIG_PATH}:`,
      error instanceof Error ? error.message : "Unknown error",
    );
    return null;
  }
}

// Helper functions
const handleApiError = (error: unknown): string => {
  if (error instanceof AxiosError && error.response) {
    return `API Error: ${error.response.status} - ${JSON.stringify(error.response.data)}`;
  }
  if (error instanceof Error) {
    return `Error: ${error.message}`;
  }
  return "Unknown error occurred";
};

function buildQueryFromMapping(
  mapping: SourceMapping,
  additionalQuery?: string,
): string {
  let query = `_sourceCategory="${mapping.sourceCategory}"`;

  if (mapping.sourceName) {
    query += ` _sourceName="${mapping.sourceName}"`;
  }

  if (mapping.commonFilters && mapping.commonFilters.length > 0) {
    query += ` ${mapping.commonFilters.join(" ")}`;
  }

  if (additionalQuery) {
    query += ` ${additionalQuery}`;
  }

  return query;
}

function findSourceMapping(
  environment: string,
  resourceType: "applications" | "infrastructure",
  resourceName: string,
): SourceMapping | null {
  if (!contextConfig) return null;

  const env = contextConfig.environments[environment];
  if (!env) return null;

  return env[resourceType][resourceName] || null;
}

// Create MCP server
const server = new McpServer({
  name: "sumologic",
  version: "0.1.0",
});

// Add resources to expose context configuration using new ResourceTemplate pattern
//'Complete SumoLogic context configuration including environments, applications, and shortcuts'
server.resource("config", "sumologic://context/config", async (uri) => {
  if (!contextConfig) {
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify({ error: "No context configuration loaded" }),
        },
      ],
    };
  }

  return {
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(contextConfig, null, 2),
      },
    ],
  };
});

// Available applications and their SumoLogic source mappings, optionally filtered by environment
server.resource(
  "applications",
  new ResourceTemplate("sumologic://context/applications/{environment}", {
    list: undefined,
  }),
  async (uri, { environment }) => {
    if (!contextConfig) {
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({ error: "No context configuration loaded" }),
          },
        ],
      };
    }

    if (environment) {
      const env =
        contextConfig.environments[
          Array.isArray(environment) ? environment[0] : environment
        ];
      if (!env) {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify({
                error: `Environment '${environment}' not found`,
                availableEnvironments: Object.keys(contextConfig.environments),
              }),
            },
          ],
        };
      }

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(env.applications, null, 2),
          },
        ],
      };
    } else {
      // List all environments
      const environmentList = Object.keys(contextConfig.environments).map(
        (envName) => ({
          name: envName,
          uri: `sumologic://context/applications/${envName}`,
        }),
      );

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(environmentList, null, 2),
          },
        ],
      };
    }
  },
);

// Predefined query shortcuts and templates for common operations
server.resource("shortcuts", "sumologic://context/shortcuts", async (uri) => {
  if (!contextConfig) {
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify({ error: "No context configuration loaded" }),
        },
      ],
    };
  }

  return {
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(contextConfig.shortcuts, null, 2),
      },
    ],
  };
});

// Add prompts for common SumoLogic operations
server.prompt(
  "troubleshoot-application",
  {
    application: z.string().describe("Name of the application to troubleshoot"),
    environment: z
      .string()
      .optional()
      .describe("Environment (defaults to production)"),
    time_range: z
      .string()
      .optional()
      .describe("Time range to search (defaults to -15m)"),
  },
  ({
    application,
    environment = DEFAULT_ENVIRONMENT,
    time_range = "-15m",
  }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `Help me troubleshoot issues with the ${application} application in the ${environment} environment. 

Please:
1. First, discover what sources are available for this application
2. Search for recent errors and exceptions in the last ${time_range}
3. Look for any performance issues or slow responses
4. Check if there are any unusual patterns in the logs
5. Summarize your findings and suggest next steps

Use the contextual search tools to make this efficient.`,
        },
      },
    ],
  }),
);

server.prompt(
  "performance-analysis",
  {
    resource_name: z
      .string()
      .describe("Name of the application or infrastructure component"),
    resource_type: z
      .enum(["applications", "infrastructure"])
      .describe("Type of resource"),
    environment: z
      .string()
      .optional()
      .describe("Environment (defaults to production)"),
    threshold: z
      .string()
      .optional()
      .describe("Performance threshold to check (e.g., 1000ms)"),
  },
  ({
    resource_name,
    resource_type,
    environment = DEFAULT_ENVIRONMENT,
    threshold = "1000",
  }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `Analyze the performance of ${resource_name} (${resource_type}) in ${environment}.

Please:
1. Search for performance-related metrics using the "performance" shortcut with threshold ${threshold}
2. Look for response time patterns over the last hour
3. Identify any slow queries or high-latency operations
4. Check for resource utilization issues
5. Provide recommendations for optimization

Use the search_with_shortcut tool with the performance shortcut.`,
        },
      },
    ],
  }),
);

server.prompt(
  "security-audit",
  {
    environment: z
      .string()
      .optional()
      .describe("Environment to audit (defaults to production)"),
    time_range: z
      .string()
      .optional()
      .describe("Time range for audit (defaults to -24h)"),
  },
  ({ environment = DEFAULT_ENVIRONMENT, time_range = "-24h" }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `Perform a security audit across the ${environment} environment for the last ${time_range}.

Please:
1. Discover all available applications and infrastructure in ${environment}
2. Search for authentication failures and unauthorized access attempts
3. Look for suspicious activity patterns or unusual traffic
4. Check for any security-related errors or warnings
5. Review access logs for anomalies
6. Summarize security findings and recommend actions

Use contextual searches to examine each application and infrastructure component systematically.`,
        },
      },
    ],
  }),
);

// Enhanced tools with context awareness

// Tool for discovering available applications and infrastructure
server.tool(
  "discover_sources",
  "Discover available applications, infrastructure, and query shortcuts for a given environment",
  {
    environment: z
      .string()
      .optional()
      .describe("Environment to discover sources for (defaults to production)"),
  },
  async ({ environment = DEFAULT_ENVIRONMENT }) => {
    if (!contextConfig) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: "No context configuration available",
              suggestion:
                "Load a sumologic-context.json file to enable contextual awareness",
            }),
          },
        ],
      };
    }

    const env = contextConfig.environments[environment];
    if (!env) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: `Environment '${environment}' not found`,
              availableEnvironments: Object.keys(contextConfig.environments),
            }),
          },
        ],
      };
    }

    const discovery = {
      environment,
      applications: Object.entries(env.applications).map(([name, mapping]) => ({
        name,
        description: mapping.description,
        sourceCategory: mapping.sourceCategory,
        sourceName: mapping.sourceName,
        sampleQueries: mapping.sampleQueries?.slice(0, 2), // Limit to first 2 samples
      })),
      infrastructure: Object.entries(env.infrastructure).map(
        ([name, mapping]) => ({
          name,
          description: mapping.description,
          sourceCategory: mapping.sourceCategory,
          sourceName: mapping.sourceName,
        }),
      ),
      shortcuts: Object.entries(contextConfig.shortcuts).map(
        ([name, shortcut]) => ({
          name,
          description: shortcut.description,
          queryTemplate: shortcut.queryTemplate,
        }),
      ),
    };

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(discovery, null, 2),
        },
      ],
    };
  },
);

// Enhanced search tool with contextual awareness
server.tool(
  "search_by_context",
  "Start a search job using contextual resource mappings (applications or infrastructure)",
  {
    resource_type: z
      .enum(["applications", "infrastructure"])
      .describe("Type of resource to search"),
    resource_name: z
      .string()
      .describe("Name of the application or infrastructure component"),
    query: z
      .string()
      .optional()
      .describe("Additional query to append to the base source query"),
    environment: z
      .string()
      .optional()
      .describe("Environment to search in (defaults to production)"),
    from_time: z
      .string()
      .describe(
        'Start time for the search (e.g. "2023-04-01T00:00:00Z" or "-15m")',
      ),
    to_time: z
      .string()
      .describe(
        'End time for the search (e.g. "2023-04-01T01:00:00Z" or "now")',
      ),
    time_zone: z
      .string()
      .optional()
      .describe("Timezone for the search (defaults to UTC)"),
  },
  async ({
    resource_type,
    resource_name,
    query,
    environment = DEFAULT_ENVIRONMENT,
    from_time,
    to_time,
    time_zone,
  }) => {
    const mapping = findSourceMapping(
      environment,
      resource_type,
      resource_name,
    );

    if (!mapping) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: `Resource '${resource_name}' not found in ${resource_type} for environment '${environment}'`,
              suggestion:
                "Use discover_sources tool to see available resources",
            }),
          },
        ],
        isError: true,
      };
    }

    const finalQuery = buildQueryFromMapping(mapping, query);

    try {
      const searchJobData = {
        query: finalQuery,
        from: from_time,
        to: to_time,
        timeZone: time_zone || "UTC",
      };

      const response = await sumoLogicClient.post(
        "/v1/search/jobs",
        searchJobData,
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                searchJob: response.data,
                contextUsed: {
                  resource: `${environment}.${resource_type}.${resource_name}`,
                  mapping: {
                    description: mapping.description,
                    sourceCategory: mapping.sourceCategory,
                    sourceName: mapping.sourceName,
                  },
                  finalQuery,
                },
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: handleApiError(error),
          },
        ],
        isError: true,
      };
    }
  },
);

// Tool for using predefined shortcuts
server.tool(
  "search_with_shortcut",
  "Execute a search using a predefined shortcut template applied to a specific resource",
  {
    shortcut_name: z
      .string()
      .describe("Name of the predefined shortcut to use"),
    resource_type: z
      .enum(["applications", "infrastructure"])
      .describe("Type of resource to apply shortcut to"),
    resource_name: z
      .string()
      .describe("Name of the application or infrastructure component"),
    parameters: z
      .record(z.string(), z.string())
      .optional()
      .describe("Parameters to substitute in the shortcut template"),
    environment: z
      .string()
      .optional()
      .describe("Environment to search in (defaults to production)"),
    from_time: z
      .string()
      .optional()
      .describe("Start time (uses shortcut default if not provided)"),
    to_time: z
      .string()
      .optional()
      .describe('End time (uses "now" if not provided)'),
    time_zone: z
      .string()
      .optional()
      .describe("Timezone for the search (defaults to UTC)"),
  },
  async ({
    shortcut_name,
    resource_type,
    resource_name,
    parameters,
    environment = DEFAULT_ENVIRONMENT,
    from_time,
    to_time,
    time_zone,
  }) => {
    if (!contextConfig) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: "No context configuration available",
            }),
          },
        ],
        isError: true,
      };
    }

    const shortcut = contextConfig.shortcuts[shortcut_name];
    if (!shortcut) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: `Shortcut '${shortcut_name}' not found`,
              availableShortcuts: Object.keys(contextConfig.shortcuts),
            }),
          },
        ],
        isError: true,
      };
    }

    const mapping = findSourceMapping(
      environment,
      resource_type,
      resource_name,
    );
    if (!mapping) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: `Resource '${resource_name}' not found in ${resource_type} for environment '${environment}'`,
            }),
          },
        ],
        isError: true,
      };
    }

    // Build the query with shortcut template
    let shortcutQuery = shortcut.queryTemplate;
    const allParams = { ...shortcut.defaultParams, ...parameters };

    // Substitute parameters in template
    Object.entries(allParams).forEach(([key, value]) => {
      shortcutQuery = shortcutQuery.replace(
        new RegExp(`\\$\\{${key}\\}`, "g"),
        value,
      );
    });

    const finalQuery = buildQueryFromMapping(mapping, shortcutQuery);

    try {
      const searchJobData = {
        query: finalQuery,
        from: from_time || shortcut.timeRange || "-15m",
        to: to_time || "now",
        timeZone: time_zone || "UTC",
      };

      const response = await sumoLogicClient.post(
        "/v1/search/jobs",
        searchJobData,
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                searchJob: response.data,
                contextUsed: {
                  shortcut: shortcut_name,
                  resource: `${environment}.${resource_type}.${resource_name}`,
                  finalQuery,
                  parametersUsed: allParams,
                },
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: handleApiError(error),
          },
        ],
        isError: true,
      };
    }
  },
);

// Keep all original tools for backward compatibility
server.tool(
  "check_connection",
  "Check if the SumoLogic API connection is working and context is loaded",
  {},
  async () => {
    try {
      await sumoLogicClient.get("/v1/collectors");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "success",
              message: "Connection to SumoLogic API successful",
              contextConfigLoaded: contextConfig !== null,
            }),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "error",
              message: handleApiError(error),
            }),
          },
        ],
      };
    }
  },
);

// Tool for listing collectors
server.tool("list_collectors", "List all SumoLogic collectors", async () => {
  try {
    const response = await sumoLogicClient.get("/v1/collectors");
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(response.data, null, 2),
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: handleApiError(error),
        },
      ],
      isError: true,
    };
  }
});

// Tool for getting collector by ID
server.tool(
  "get_collector",
  "Get a specific SumoLogic collector by ID",
  {
    collector_id: z.string().describe("The ID of the collector to retrieve"),
  },
  async ({ collector_id }) => {
    try {
      const response = await sumoLogicClient.get(
        `/v1/collectors/${collector_id}`,
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(response.data, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: handleApiError(error),
          },
        ],
        isError: true,
      };
    }
  },
);

// Tool for executing a search query
server.tool(
  "start_search_job",
  "Start a search job in SumoLogic",
  {
    query: z.string().describe("The search query to execute"),
    from_time: z
      .string()
      .describe(
        'Start time for the search (e.g. "2023-04-01T00:00:00Z" or "-15m" for relative time)',
      ),
    to_time: z
      .string()
      .describe(
        'End time for the search (e.g. "2023-04-01T01:00:00Z" or "now" for relative time)',
      ),
    time_zone: z
      .string()
      .optional()
      .describe('Timezone for the search (e.g. "UTC")'),
  },
  async ({ query, from_time, to_time, time_zone }) => {
    try {
      const searchJobData = {
        query,
        from: from_time,
        to: to_time,
        timeZone: time_zone || "UTC",
      };

      const response = await sumoLogicClient.post(
        "/v1/search/jobs",
        searchJobData,
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(response.data, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: handleApiError(error),
          },
        ],
        isError: true,
      };
    }
  },
);

// Tool for checking search job status
server.tool(
  "check_search_job_status",
  "Check the status of a search job",
  {
    job_id: z.string().describe("The ID of the search job to check"),
  },
  async ({ job_id }) => {
    try {
      const response = await sumoLogicClient.get(`/v1/search/jobs/${job_id}`);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(response.data, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: handleApiError(error),
          },
        ],
        isError: true,
      };
    }
  },
);

// Tool for getting search job results
server.tool(
  "get_search_job_results",
  "Get the results of a search job",
  {
    job_id: z.string().describe("The ID of the search job to get results for"),
    limit: z
      .number()
      .optional()
      .describe("The maximum number of results to return"),
    offset: z.number().optional().describe("The offset into the result set"),
  },
  async ({ job_id, limit, offset }) => {
    try {
      const url = `/v1/search/jobs/${job_id}/messages`;
      const params: Record<string, string> = {};

      if (limit !== undefined) {
        params.limit = limit.toString();
      }

      if (offset !== undefined) {
        params.offset = offset.toString();
      }

      const response = await sumoLogicClient.get(url, { params });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(response.data, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: handleApiError(error),
          },
        ],
        isError: true,
      };
    }
  },
);

// Main function
async function main() {
  // Load context configuration at startup
  contextConfig = await loadContextConfig();

  console.error("[sumologic] starting (stdio)...");

  const transport = new StdioServerTransport();

  try {
    await server.connect(transport);
    console.error("[sumologic] connected and ready");
    if (contextConfig) {
      console.error(
        `[sumologic] context loaded for organization: ${contextConfig.organization}`,
      );
      console.error(
        `[sumologic] available environments: ${Object.keys(contextConfig.environments).join(", ")}`,
      );
    }
  } catch (error) {
    console.error("[sumologic] error connecting MCP server:", error);
    process.exit(1);
  }

  const shutdown = () => process.exit(0);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Guard late rejections so they can't crash the process and reset state.
process.on("unhandledRejection", (reason) => {
  console.error(`[sumologic] unhandled rejection (ignored): ${reason}`);
});

// Start the server
main().catch((error) => {
  console.error("[sumologic] fatal:", error);
  process.exit(1);
});
