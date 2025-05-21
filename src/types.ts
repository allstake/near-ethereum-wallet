export interface AccountInfo {
  accountId: string;
  publicKey?: string;
  relayerPublicKey?: string;
}

export interface NearNetworkConfig {
  networkId: string;
  nodeUrl: string;
  walletUrl?: string;
  helperUrl?: string;
  explorerUrl?: string;
  indexerUrl?: string;
}
