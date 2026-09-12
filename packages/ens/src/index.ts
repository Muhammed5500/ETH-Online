// @ethonline/ens
// ENSv2 on Sepolia: an agent's name is owned by the key that signs its
// reports, and its record is written by the orchestrator and not by itself.

export {
  adminRole,
  AGENT_NAME_TTL_SECONDS,
  AGENT_ROLE_BITMAP,
  AGENT_WRITABLE_KEYS,
  ENS_CHAIN_ID,
  ONE_YEAR_SECONDS,
  ORCHESTRATOR_ONLY_KEYS,
  ORCHESTRATOR_ROOT_ROLES,
  REGISTRY_ROLES,
  RESOLVER_ROLES,
  ROLE_CAN_TRANSFER_ADMIN,
  SEPOLIA,
  type EnsDeployment,
} from './deployment.js';

export {
  DEFAULT_SEPOLIA_RPC,
  ensChain,
  evmAddressFromKey,
  orchestratorSigner,
  publicSepolia,
  sepoliaRpcUrl,
  toEvmPrivateKey,
  type EnsSigner,
} from './client.js';

export {
  agentEnsName,
  dnsEncodeName,
  ensNameOwner,
  readEnsAgent,
  readEnsText,
  verifyEnsOwnership,
  type EnsAgentProfile,
  type OwnershipCheck,
} from './resolve.js';

export {
  formatAgentRecord,
  writeAgentRecord,
  type AgentEnsRecord,
  type WriteResult,
} from './write.js';
