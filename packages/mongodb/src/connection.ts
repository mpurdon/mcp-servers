import { MongoClient } from "mongodb";
import type { Config, EnvKey } from "./config.js";
import { safeHostFromUri } from "./config.js";

/**
 * Singleton connection manager. Holds one active MongoClient at a time.
 * Calling `switchTo` closes the existing client and opens a new one.
 */
export class ConnectionManager {
  private client: MongoClient | null = null;
  private _connectingPromise: Promise<MongoClient> | null = null;
  private activeEnv: EnvKey;
  private config: Config;

  constructor(config: Config) {
    this.config = config;
    this.activeEnv = config.defaultEnvironment;
  }

  getActiveEnv(): EnvKey {
    return this.activeEnv;
  }

  getActiveEnvName(): string {
    return this.config.environments[this.activeEnv].name;
  }

  getActiveHost(): string {
    return safeHostFromUri(
      this.config.environments[this.activeEnv].connectionString,
    );
  }

  isProduction(): boolean {
    return this.activeEnv === "prd";
  }

  /**
   * Get the connected client for the active environment, connecting lazily.
   *
   * Uses a shared in-flight promise so concurrent callers awaiting an initial
   * connection do not each create a separate MongoClient (TOCTOU race).
   */
  async getClient(): Promise<MongoClient> {
    if (this.client) return this.client;
    if (this._connectingPromise) return this._connectingPromise;
    this._connectingPromise = this._connect().finally(() => {
      this._connectingPromise = null;
    });
    return this._connectingPromise;
  }

  private async _connect(): Promise<MongoClient> {
    const uri = this.config.environments[this.activeEnv].connectionString;
    const client = new MongoClient(uri, {
      // Reasonable defaults for an interactive MCP server.
      serverSelectionTimeoutMS: 10_000,
      connectTimeoutMS: 10_000,
      socketTimeoutMS: 30_000,
      maxPoolSize: 5,
      minPoolSize: 1,
    });
    // If the topology is closed (network blip, server restart, idle eviction),
    // drop our cached reference so the next getClient() reconnects cleanly.
    client.on("topologyClosed", () => {
      if (this.client === client) this.client = null;
    });
    client.on("close", () => {
      if (this.client === client) this.client = null;
    });
    await client.connect();
    this.client = client;
    return client;
  }

  /**
   * Switch to a different environment. Closes the current client and opens a new one
   * to verify the new connection works before returning.
   */
  async switchTo(env: EnvKey): Promise<void> {
    this._connectingPromise = null;
    if (this.client) {
      try {
        await this.client.close();
      } catch {
        // ignore close errors during switch
      }
      this.client = null;
    }
    this.activeEnv = env;
    // Eagerly connect so a bad config surfaces immediately.
    await this.getClient();
  }

  /**
   * Re-read a freshly parsed config without restarting the server.
   * Closes the current connection and reconnects to the same active environment
   * using the updated connection string.
   */
  async reloadConfig(newConfig: Config): Promise<void> {
    this._connectingPromise = null;
    if (this.client) {
      try {
        await this.client.close();
      } catch {
        // ignore close errors during reload
      }
      this.client = null;
    }
    this.config = newConfig;
    // Keep the current env but reconnect with the (potentially new) URI.
    await this.getClient();
  }

  async close(): Promise<void> {
    this._connectingPromise = null;
    if (this.client) {
      try {
        await this.client.close();
      } catch {
        // ignore
      }
      this.client = null;
    }
  }
}
