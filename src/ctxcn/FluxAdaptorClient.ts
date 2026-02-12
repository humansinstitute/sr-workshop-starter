import { Client } from "@modelcontextprotocol/sdk/client";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  NostrClientTransport,
  type NostrTransportOptions,
  PrivateKeySigner,
  ApplesauceRelayPool,
} from "@contextvm/sdk";

export type HealthInput = Record<string, unknown>;

export interface HealthOutput {
  [k: string]: unknown;
}

export type AuthWhoamiInput = Record<string, unknown>;

export interface AuthWhoamiOutput {
  [k: string]: unknown;
}

export interface DbQueryInput {
  /**
   * Table name to query
   */
  table: string;
  /**
   * Columns to select (comma-separated)
   */
  select?: string;
  /**
   * Filter conditions
   */
  filter?: {
    [k: string]: unknown;
  };
  /**
   * Order by column
   */
  order?: {
    column: string;
    ascending?: boolean;
  };
  /**
   * Maximum records to return
   */
  limit?: number;
  /**
   * Number of records to skip
   */
  offset?: number;
}

export interface DbQueryOutput {
  [k: string]: unknown;
}

export interface DbInsertInput {
  /**
   * Table name
   */
  table: string;
  /**
   * Record(s) to insert
   */
  data:
    | {
        [k: string]: unknown;
      }
    | {
        [k: string]: unknown;
      }[];
}

export interface DbInsertOutput {
  [k: string]: unknown;
}

export interface DbUpdateInput {
  /**
   * Table name
   */
  table: string;
  /**
   * Filter to match records
   */
  filter: {
    [k: string]: unknown;
  };
  /**
   * Fields to update
   */
  data: {
    [k: string]: unknown;
  };
}

export interface DbUpdateOutput {
  [k: string]: unknown;
}

export interface DbDeleteInput {
  /**
   * Table name
   */
  table: string;
  /**
   * Filter to match records to delete
   */
  filter: {
    [k: string]: unknown;
  };
}

export interface DbDeleteOutput {
  [k: string]: unknown;
}

export interface StorageUploadInput {
  /**
   * Storage bucket name
   */
  bucket: string;
  /**
   * File path within bucket
   */
  path: string;
  /**
   * Base64 encoded file content
   */
  content: string;
  /**
   * MIME type of the file
   */
  contentType?: string;
}

export interface StorageUploadOutput {
  [k: string]: unknown;
}

export interface StorageDownloadInput {
  /**
   * Storage bucket name
   */
  bucket: string;
  /**
   * File path within bucket
   */
  path: string;
}

export interface StorageDownloadOutput {
  [k: string]: unknown;
}

export interface StorageListInput {
  /**
   * Storage bucket name
   */
  bucket: string;
  /**
   * Filter by path prefix
   */
  prefix?: string;
  /**
   * Maximum files to return
   */
  limit?: number;
  /**
   * Number of files to skip
   */
  offset?: number;
}

export interface StorageListOutput {
  [k: string]: unknown;
}

export interface StorageDeleteInput {
  /**
   * Storage bucket name
   */
  bucket: string;
  /**
   * File path to delete
   */
  path: string;
}

export interface StorageDeleteOutput {
  [k: string]: unknown;
}

export interface FunctionInvokeInput {
  /**
   * Function name to invoke
   */
  name: string;
  /**
   * Payload to pass to the function
   */
  payload?: {
    [k: string]: unknown;
  };
}

export interface FunctionInvokeOutput {
  [k: string]: unknown;
}

export interface RegisterAppInput {
  /**
   * App name
   */
  name: string;
  /**
   * Base64-encoded attestation event signed by app
   */
  attestation: string;
}

export interface RegisterAppOutput {
  [k: string]: unknown;
}

export type ListAppsInput = Record<string, unknown>;

export interface ListAppsOutput {
  [k: string]: unknown;
}

export interface GetAppInput {
  /**
   * App npub
   */
  app_npub: string;
}

export interface GetAppOutput {
  [k: string]: unknown;
}

export interface GenerateTokenInput {
  /**
   * App npub
   */
  app_npub: string;
  /**
   * Relay URL for CVM
   */
  relay?: string;
  /**
   * HTTP endpoint URL
   */
  http?: string;
}

export interface GenerateTokenOutput {
  [k: string]: unknown;
}

export interface SyncRecordsInput {
  /**
   * App npub to sync to
   */
  app_npub: string;
  /**
   * Records to sync
   */
  records: {
    record_id: string;
    collection?: string;
    encrypted_data: string;
    metadata?: {
      [k: string]: unknown;
    };
  }[];
}

export interface SyncRecordsOutput {
  [k: string]: unknown;
}

export interface FetchRecordsInput {
  /**
   * App npub to fetch from
   */
  app_npub: string;
  /**
   * Filter by collection
   */
  collection?: string;
  /**
   * Fetch records updated after this ISO timestamp
   */
  since?: string;
}

export interface FetchRecordsOutput {
  [k: string]: unknown;
}

export interface FetchDelegatedRecordsInput {
  /**
   * App npub to fetch delegated records from
   */
  app_npub: string;
  /**
   * Only return records updated after this ISO-8601 timestamp
   */
  since?: string;
  /**
   * Filter by collection name
   */
  collection?: string;
  /**
   * Maximum records to return (default 100, max 1000)
   */
  limit?: number;
  /**
   * Pagination cursor from a previous response
   */
  cursor?: string;
}

export interface FetchDelegatedRecordsOutput {
  [k: string]: unknown;
}

export interface DeleteRecordsInput {
  /**
   * App npub
   */
  app_npub: string;
  /**
   * Record IDs to delete
   */
  record_ids: string[];
}

export interface DeleteRecordsOutput {
  [k: string]: unknown;
}

export type FluxAdaptor = {
  Health: (args: HealthInput) => Promise<HealthOutput>;
  AuthWhoami: (args: AuthWhoamiInput) => Promise<AuthWhoamiOutput>;
  DbQuery: (table: string, select?: string, filter?: object, order?: object, limit?: number, offset?: number) => Promise<DbQueryOutput>;
  DbInsert: (table: string, data: any) => Promise<DbInsertOutput>;
  DbUpdate: (table: string, filter: object, data: object) => Promise<DbUpdateOutput>;
  DbDelete: (table: string, filter: object) => Promise<DbDeleteOutput>;
  StorageUpload: (bucket: string, path: string, content: string, contentType?: string) => Promise<StorageUploadOutput>;
  StorageDownload: (bucket: string, path: string) => Promise<StorageDownloadOutput>;
  StorageList: (bucket: string, prefix?: string, limit?: number, offset?: number) => Promise<StorageListOutput>;
  StorageDelete: (bucket: string, path: string) => Promise<StorageDeleteOutput>;
  FunctionInvoke: (name: string, payload?: any) => Promise<FunctionInvokeOutput>;
  RegisterApp: (name: string, attestation: string) => Promise<RegisterAppOutput>;
  ListApps: (args: ListAppsInput) => Promise<ListAppsOutput>;
  GetApp: (app_npub: string) => Promise<GetAppOutput>;
  GenerateToken: (app_npub: string, relay?: string, http?: string) => Promise<GenerateTokenOutput>;
  SyncRecords: (app_npub: string, records: object[]) => Promise<SyncRecordsOutput>;
  FetchRecords: (app_npub: string, collection?: string, since?: string) => Promise<FetchRecordsOutput>;
  FetchDelegatedRecords: (app_npub: string, since?: string, collection?: string, limit?: number, cursor?: string) => Promise<FetchDelegatedRecordsOutput>;
  DeleteRecords: (app_npub: string, record_ids: string[]) => Promise<DeleteRecordsOutput>;
};

export class FluxAdaptorClient implements FluxAdaptor {
  static readonly SERVER_PUBKEY = "aa2d47b82e0e57d3a536d26ba37d7425481e402e5e54fcdaab293712f1875adb";
  static readonly DEFAULT_RELAYS = ["wss://relay.contextvm.org"];
  private client: Client;
  private transport: Transport;

  constructor(
    options: Partial<NostrTransportOptions> & { privateKey?: string; relays?: string[] } = {}
  ) {
    this.client = new Client({
      name: "FluxAdaptorClient",
      version: "1.0.0",
    });

    // Private key precedence: constructor options > config file
    const resolvedPrivateKey = options.privateKey ||
      "";

    // Use options.signer if provided, otherwise create from resolved private key
    const signer = options.signer || new PrivateKeySigner(resolvedPrivateKey);
    // Use options.relays if provided, otherwise use class DEFAULT_RELAYS
    const relays = options.relays || FluxAdaptorClient.DEFAULT_RELAYS;
    // Use options.relayHandler if provided, otherwise create from relays
    const relayHandler = options.relayHandler || new ApplesauceRelayPool(relays);
    const serverPubkey = options.serverPubkey;
    const { privateKey: _, ...rest } = options;

    this.transport = new NostrClientTransport({
      serverPubkey: serverPubkey || FluxAdaptorClient.SERVER_PUBKEY,
      signer,
      relayHandler,
      isStateless: true,
      ...rest,
    });

    // Auto-connect in constructor
    this.client.connect(this.transport).catch((error) => {
      console.error(`Failed to connect to server: ${error}`);
    });
  }

  async disconnect(): Promise<void> {
    await this.transport.close();
  }

  private async call<T = unknown>(
    name: string,
    args: Record<string, unknown>
  ): Promise<T> {
    const result = await this.client.callTool({
      name,
      arguments: { ...args },
    });
    return result.structuredContent as T;
  }

    /**
   * Check service health and Fluxbase connection
   * @returns {Promise<HealthOutput>} The result of the health operation
   */
  async Health(
    args: HealthInput
  ): Promise<HealthOutput> {
    return this.call("health", args);
  }

    /**
   * Get current authenticated user info
   * @returns {Promise<AuthWhoamiOutput>} The result of the auth_whoami operation
   */
  async AuthWhoami(
    args: AuthWhoamiInput
  ): Promise<AuthWhoamiOutput> {
    return this.call("auth_whoami", args);
  }

    /**
   * Query records from a database table
   * @param {string} table Table name to query
   * @param {string} select [optional] Columns to select (comma-separated)
   * @param {object} filter [optional] Filter conditions
   * @param {object} order [optional] Order by column
   * @param {number} limit [optional] Maximum records to return
   * @param {number} offset [optional] Number of records to skip
   * @returns {Promise<DbQueryOutput>} The result of the db_query operation
   */
  async DbQuery(
    table: string, select?: string, filter?: object, order?: object, limit?: number, offset?: number
  ): Promise<DbQueryOutput> {
    return this.call("db_query", { table, select, filter, order, limit, offset });
  }

    /**
   * Insert records into a database table
   * @param {string} table Table name
   * @param {any} data Record(s) to insert
   * @returns {Promise<DbInsertOutput>} The result of the db_insert operation
   */
  async DbInsert(
    table: string, data: any
  ): Promise<DbInsertOutput> {
    return this.call("db_insert", { table, data });
  }

    /**
   * Update records in a database table
   * @param {string} table Table name
   * @param {object} filter Filter to match records
   * @param {object} data Fields to update
   * @returns {Promise<DbUpdateOutput>} The result of the db_update operation
   */
  async DbUpdate(
    table: string, filter: object, data: object
  ): Promise<DbUpdateOutput> {
    return this.call("db_update", { table, filter, data });
  }

    /**
   * Delete records from a database table
   * @param {string} table Table name
   * @param {object} filter Filter to match records to delete
   * @returns {Promise<DbDeleteOutput>} The result of the db_delete operation
   */
  async DbDelete(
    table: string, filter: object
  ): Promise<DbDeleteOutput> {
    return this.call("db_delete", { table, filter });
  }

    /**
   * Upload a file to storage (content must be base64 encoded)
   * @param {string} bucket Storage bucket name
   * @param {string} path File path within bucket
   * @param {string} content Base64 encoded file content
   * @param {string} contentType [optional] MIME type of the file
   * @returns {Promise<StorageUploadOutput>} The result of the storage_upload operation
   */
  async StorageUpload(
    bucket: string, path: string, content: string, contentType?: string
  ): Promise<StorageUploadOutput> {
    return this.call("storage_upload", { bucket, path, content, contentType });
  }

    /**
   * Download a file from storage (returns base64 encoded content)
   * @param {string} bucket Storage bucket name
   * @param {string} path File path within bucket
   * @returns {Promise<StorageDownloadOutput>} The result of the storage_download operation
   */
  async StorageDownload(
    bucket: string, path: string
  ): Promise<StorageDownloadOutput> {
    return this.call("storage_download", { bucket, path });
  }

    /**
   * List files in a storage bucket
   * @param {string} bucket Storage bucket name
   * @param {string} prefix [optional] Filter by path prefix
   * @param {number} limit [optional] Maximum files to return
   * @param {number} offset [optional] Number of files to skip
   * @returns {Promise<StorageListOutput>} The result of the storage_list operation
   */
  async StorageList(
    bucket: string, prefix?: string, limit?: number, offset?: number
  ): Promise<StorageListOutput> {
    return this.call("storage_list", { bucket, prefix, limit, offset });
  }

    /**
   * Delete a file from storage
   * @param {string} bucket Storage bucket name
   * @param {string} path File path to delete
   * @returns {Promise<StorageDeleteOutput>} The result of the storage_delete operation
   */
  async StorageDelete(
    bucket: string, path: string
  ): Promise<StorageDeleteOutput> {
    return this.call("storage_delete", { bucket, path });
  }

    /**
   * Invoke a Fluxbase edge function
   * @param {string} name Function name to invoke
   * @param {any} payload [optional] Payload to pass to the function
   * @returns {Promise<FunctionInvokeOutput>} The result of the function_invoke operation
   */
  async FunctionInvoke(
    name: string, payload?: any
  ): Promise<FunctionInvokeOutput> {
    return this.call("function_invoke", { name, payload });
  }

    /**
   * Register a new app with attestation signed by app owner
   * @param {string} name App name
   * @param {string} attestation Base64-encoded attestation event signed by app
   * @returns {Promise<RegisterAppOutput>} The result of the register_app operation
   */
  async RegisterApp(
    name: string, attestation: string
  ): Promise<RegisterAppOutput> {
    return this.call("register_app", { name, attestation });
  }

    /**
   * List apps owned by authenticated user
   * @returns {Promise<ListAppsOutput>} The result of the list_apps operation
   */
  async ListApps(
    args: ListAppsInput
  ): Promise<ListAppsOutput> {
    return this.call("list_apps", args);
  }

    /**
   * Get app information by npub
   * @param {string} app_npub App npub
   * @returns {Promise<GetAppOutput>} The result of the get_app operation
   */
  async GetApp(
    app_npub: string
  ): Promise<GetAppOutput> {
    return this.call("get_app", { app_npub });
  }

    /**
   * Generate access token for an app (must be owner)
   * @param {string} app_npub App npub
   * @param {string} relay [optional] Relay URL for CVM
   * @param {string} http [optional] HTTP endpoint URL
   * @returns {Promise<GenerateTokenOutput>} The result of the generate_token operation
   */
  async GenerateToken(
    app_npub: string, relay?: string, http?: string
  ): Promise<GenerateTokenOutput> {
    return this.call("generate_token", { app_npub, relay, http });
  }

    /**
   * Sync encrypted records to app storage
   * @param {string} app_npub App npub to sync to
   * @param {object[]} records Records to sync
   * @returns {Promise<SyncRecordsOutput>} The result of the sync_records operation
   */
  async SyncRecords(
    app_npub: string, records: object[]
  ): Promise<SyncRecordsOutput> {
    return this.call("sync_records", { app_npub, records });
  }

    /**
   * Fetch encrypted records from app storage
   * @param {string} app_npub App npub to fetch from
   * @param {string} collection [optional] Filter by collection
   * @param {string} since [optional] Fetch records updated after this ISO timestamp
   * @returns {Promise<FetchRecordsOutput>} The result of the fetch_records operation
   */
  async FetchRecords(
    app_npub: string, collection?: string, since?: string
  ): Promise<FetchRecordsOutput> {
    return this.call("fetch_records", { app_npub, collection, since });
  }

    /**
   * Fetch records delegated to the caller. Returns only the requesting delegate's encrypted blob — owner blobs and other delegates' blobs are stripped. Use for AI agent / bot access to assigned records.
   * @param {string} app_npub App npub to fetch delegated records from
   * @param {string} since [optional] Only return records updated after this ISO-8601 timestamp
   * @param {string} collection [optional] Filter by collection name
   * @param {number} limit [optional] Maximum records to return (default 100, max 1000)
   * @param {string} cursor [optional] Pagination cursor from a previous response
   * @returns {Promise<FetchDelegatedRecordsOutput>} The result of the fetch_delegated_records operation
   */
  async FetchDelegatedRecords(
    app_npub: string, since?: string, collection?: string, limit?: number, cursor?: string
  ): Promise<FetchDelegatedRecordsOutput> {
    return this.call("fetch_delegated_records", { app_npub, since, collection, limit, cursor });
  }

    /**
   * Delete records from app storage
   * @param {string} app_npub App npub
   * @param {string[]} record_ids Record IDs to delete
   * @returns {Promise<DeleteRecordsOutput>} The result of the delete_records operation
   */
  async DeleteRecords(
    app_npub: string, record_ids: string[]
  ): Promise<DeleteRecordsOutput> {
    return this.call("delete_records", { app_npub, record_ids });
  }
}
