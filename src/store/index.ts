import type { DatabaseConfig } from '../config.js'
import { PgRpcClient } from './pgRpcClient.js'
import type { RpcClient } from './rpc.js'
import { SupabaseGateway } from './supabaseGateway.js'
import { SupabaseRpcClient } from './supabaseRpcClient.js'
import type { WorkflowStore } from './workflowStore.js'

export function createRpcClient(config: DatabaseConfig): RpcClient {
  return config.kind === 'postgres'
    ? new PgRpcClient(config.databaseUrl)
    : new SupabaseRpcClient(config.url, config.serviceRoleKey)
}

export function createWorkflowStore(config: DatabaseConfig): WorkflowStore {
  return new SupabaseGateway(createRpcClient(config))
}

export { StoreError } from './workflowStore.js'
export type { StoreErrorCode, WorkflowStore } from './workflowStore.js'
