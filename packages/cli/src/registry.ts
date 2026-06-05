/**
 * The single source of truth for which @mpurdon MCP servers exist and how they
 * are configured. The configurator drives every prompt from this list.
 */

export interface EnvVar {
  key: string;
  label: string;
  required: boolean;
  /** Mask input when prompting and never echo back. */
  secret: boolean;
  default?: string;
}

export interface ServerDef {
  /** The key used under `mcpServers` and as the registered server name. */
  key: string;
  /** Published npm package, invoked via `npx -y <packageName>`. */
  packageName: string;
  title: string;
  description: string;
  /** Environment variables the server reads. */
  env: EnvVar[];
  /**
   * Some servers read a JSON config file instead of (or in addition to) env
   * vars. When present, the configurator reminds the user to create it.
   */
  configFile?: {
    /** Path relative to home, e.g. ".mongodb-mcp/config.json". */
    relativePath: string;
    note: string;
  };
  /** Extra one-time setup the user must run (e.g. an OAuth flow). */
  setupNote?: string;
}

export const SERVERS: ServerDef[] = [
  {
    key: "mongodb",
    packageName: "@mpurdon/mcp-mongodb",
    title: "MongoDB",
    description:
      "Query/manage MongoDB across dev/stg/prd with production write-protection.",
    env: [],
    configFile: {
      relativePath: ".mongodb-mcp/config.json",
      note:
        "Create ~/.mongodb-mcp/config.json with your dev/stg/prd connection strings " +
        "(chmod 600). See the @mpurdon/mcp-mongodb README for the exact shape.",
    },
  },
  {
    key: "freshbooks",
    packageName: "@mpurdon/mcp-freshbooks",
    title: "FreshBooks",
    description: "FreshBooks invoices, clients, items, and time entries.",
    env: [
      {
        key: "FRESHBOOKS_CLIENT_ID",
        label: "FreshBooks app Client ID",
        required: true,
        secret: false,
      },
      {
        key: "FRESHBOOKS_CLIENT_SECRET",
        label: "FreshBooks app Client Secret",
        required: true,
        secret: true,
      },
    ],
    setupNote:
      "After registering, run `npx -y @mpurdon/mcp-freshbooks freshbooks-setup` once " +
      "to complete the OAuth flow and store tokens at ~/.freshbooks-mcp/tokens.json.",
  },
  {
    key: "sumologic",
    packageName: "@mpurdon/mcp-sumologic",
    title: "Sumo Logic",
    description: "Run Sumo Logic searches and inspect results.",
    env: [
      {
        key: "SUMOLOGIC_ACCESS_ID",
        label: "Sumo Logic Access ID",
        required: true,
        secret: false,
      },
      {
        key: "SUMOLOGIC_ACCESS_KEY",
        label: "Sumo Logic Access Key",
        required: true,
        secret: true,
      },
      {
        key: "SUMOLOGIC_API_ENDPOINT",
        label: "Sumo Logic API endpoint",
        required: false,
        secret: false,
        default: "https://api.sumologic.com/api",
      },
    ],
  },
  {
    key: "github",
    packageName: "@mpurdon/mcp-github",
    title: "GitHub",
    description: "GitHub org/repo/PR/issue and Actions workflow operations.",
    env: [
      {
        key: "GITHUB_TOKEN",
        label: "GitHub personal access token",
        required: true,
        secret: true,
      },
    ],
  },
];

export function findServer(key: string): ServerDef | undefined {
  return SERVERS.find((s) => s.key === key);
}
