import bs58 from 'bs58';
import * as nearAPI from 'near-api-js';
import { JsonRpcProvider } from 'near-api-js/lib/providers';
import { AccessKeyViewRaw } from 'near-api-js/lib/providers/provider';
import { Chain } from 'viem';

import * as wagmiCore from '@wagmi/core';

import { RLP_EXECUTE } from './constants';
import { Logger } from './log';
import { Transaction } from './transactions_types';
import { AccountInfo } from './types';
import { fetchWithTimeout, getErrorMessage, getNearAddress } from './utils';

const logger = new Logger('[near-rewards#eth-connect]');

interface SwitchChainResult {
  changed: boolean;
  prevChainId: number | null;
  curChainId: number;
}

interface NearNetworkConfig {
  networkId: string;
  nodeUrl: string;
  walletUrl?: string;
  helperUrl?: string;
  explorerUrl?: string;
  indexerUrl?: string;
}

export class NearEthereumWallet {
  private wagmiCore: typeof wagmiCore;
  private wagmiConfig: wagmiCore.Config;
  private nearNetwork: NearNetworkConfig;
  private nearProvider: JsonRpcProvider;
  private nearChain: Chain;
  private nearRpcUrl: string;
  private keyStore: nearAPI.keyStores.KeyStore;

  private onError?: (error: string) => void;

  private signInLoading: boolean = false;
  private signedNearAccountInfo: AccountInfo | null = null;

  constructor({
    nearNetwork,
    wagmiConfig,
    keyStore,
    onError,
  }: {
    nearNetwork: NearNetworkConfig;
    wagmiConfig: wagmiCore.Config;
    keyStore: nearAPI.keyStores.KeyStore;
    onError?: (error: string) => void;
  }) {
    this.wagmiConfig = wagmiConfig;
    this.wagmiCore = wagmiCore;
    this.nearNetwork = nearNetwork;
    this.onError = onError;

    const expectedChainId =
      this.nearNetwork.networkId === 'mainnet' ? 397 : 398;
    const nearChain = this.wagmiConfig.chains.find(
      (c) => c.id === expectedChainId,
    );
    if (!nearChain) {
      throw new Error('Failed to parse NEAR chain from wagmiConfig.');
    }
    this.nearChain = nearChain;
    const nearRpcUrl = nearChain.rpcUrls.default.http[0];
    if (!nearRpcUrl) {
      throw new Error('Failed to parse NEAR rpc url from wagmiConfig.');
    }
    this.nearRpcUrl = nearRpcUrl;
    this.nearProvider = new JsonRpcProvider({
      url: this.nearNetwork.nodeUrl,
    });

    this.keyStore =
      keyStore || new nearAPI.keyStores.BrowserLocalStorageKeyStore();
  }

  private handleError(error: string) {
    if (!this.onError) return;
    this.onError(error);
  }

  async switchChain(targetChainId: number): Promise<SwitchChainResult | null> {
    const ethAccount = this.wagmiCore.getAccount(this.wagmiConfig);
    if (!ethAccount) return null;
    const currentChainId = ethAccount.chainId || null;
    if (currentChainId !== targetChainId) {
      logger.info(
        `Switching to chain ${ethAccount.chainId} > ${targetChainId}`,
        ethAccount,
      );
      await this.wagmiCore.switchChain(this.wagmiConfig, {
        chainId: targetChainId,
      });
      return {
        changed: true,
        prevChainId: currentChainId,
        curChainId: targetChainId,
      };
    }

    return {
      changed: false,
      prevChainId: currentChainId,
      curChainId: currentChainId,
    };
  }

  // Get the relayer public key and onboarding transaction if needed.
  async getRelayerOnboardingInfo(accountId: string): Promise<{
    relayerPublicKey: string;
    onboardingTransaction: null | Transaction;
  }> {
    let relayerPublicKey: string;
    try {
      const response = await fetchWithTimeout(this.nearRpcUrl, {
        options: {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 3,
            method: 'near_getPublicKey',
          }),
        },
      });
      const { result } = await response.json();
      relayerPublicKey =
        'ed25519:' + bs58.encode(Buffer.from(result.public_key, 'hex'));
    } catch (error) {
      logger.error('getRelayerOnboardingInfo#getPublicKey', error);
      throw new Error("Failed to fetch the relayer's public key.");
    }

    try {
      const key = await this.nearProvider.query<AccessKeyViewRaw>({
        request_type: 'view_access_key',
        finality: 'final',
        account_id: accountId,
        public_key: relayerPublicKey,
      });
      logger.log(
        'User account ready, relayer access key onboarded.',
        relayerPublicKey,
        key,
      );
      return { relayerPublicKey, onboardingTransaction: null };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error('getRelayerOnboardingInfo#view_access_key', error);
      if (
        !error.message?.includes('does not exist while viewing') &&
        !error.message?.includes("doesn't exist") &&
        !error.message?.includes('does not exist') &&
        !error.message?.includes('has never been observed on the node')
      ) {
        throw new Error(
          'Failed to view the relayer public key (view_access_key).',
        );
      }
      logger.warn('Need to add the relayer access key:', relayerPublicKey);
      // Add the relayer's access key on-chain.
      return {
        relayerPublicKey,
        onboardingTransaction: {
          signerId: accountId,
          receiverId: accountId,
          actions: [
            {
              type: 'AddKey',
              params: {
                publicKey: relayerPublicKey,
                accessKey: {
                  nonce: 0,
                  permission: {
                    receiverId: accountId,
                    allowance: '0',
                    methodNames: [RLP_EXECUTE],
                  },
                },
              },
            },
          ],
        },
      };
    }
  }

  async onSignIn(): Promise<AccountInfo | null> {
    if (this.signedNearAccountInfo) return this.signedNearAccountInfo;
    if (this.signInLoading) return null;

    let switchChainResp: SwitchChainResult | null = null;
    try {
      this.signInLoading = true;
      const ethAccount = wagmiCore.getAccount(this.wagmiConfig);
      if (!ethAccount || !ethAccount.address) {
        throw new Error('Cannot get account address');
      }
      const nearAccountId = getNearAddress(ethAccount.address);
      logger.log('EthereumWallets:onSignIn', nearAccountId);

      const keyPair = await this.keyStore.getKey(
        this.nearNetwork.networkId,
        nearAccountId,
      );
      let reUseKeyPair = false;
      let nearPublicKey;
      let _relayerPublicKey: string | undefined = undefined;

      if (keyPair) {
        try {
          await this.nearProvider.query<AccessKeyViewRaw>({
            request_type: 'view_access_key',
            finality: 'final',
            account_id: nearAccountId,
            public_key: keyPair.getPublicKey().toString(),
          });
          reUseKeyPair = true;
        } catch (error) {
          logger.warn('Local access key cannot be reused.', error);
          this.keyStore.removeKey(this.nearNetwork.networkId, nearAccountId);
        }
      }

      if (reUseKeyPair) {
        nearPublicKey = keyPair.getPublicKey().toString();
        logger.log('Reusing existing publicKey:', nearPublicKey);
      } else {
        const newAccessKeyPair = nearAPI.utils.KeyPair.fromRandom('ed25519');
        nearPublicKey = newAccessKeyPair.getPublicKey().toString();
        logger.log('Created new publicKey:', nearPublicKey);

        // onboard
        const { relayerPublicKey, onboardingTransaction } =
          await this.getRelayerOnboardingInfo(nearAccountId);
        _relayerPublicKey = relayerPublicKey;
        if (onboardingTransaction) {
          switchChainResp = await this.switchChain(this.nearChain.id);
          // await signAndSendEthereumTransactions({
          //   transactions: [onboardingTransaction],
          //   relayerPublicKey,
          //   accountId: nearAccountId,
          // });
        }

        await this.keyStore.setKey(
          this.nearNetwork.networkId,
          nearAccountId,
          newAccessKeyPair,
        );
      }

      const account = {
        accountId: nearAccountId,
        publicKey: nearPublicKey,
        relayerPublicKey: _relayerPublicKey,
      };
      this.signedNearAccountInfo = account;
      return account;
    } catch (error) {
      this.handleError(getErrorMessage(error));
      return null;
    } finally {
      this.signInLoading = false;
      // If the chain was switched, switch back to the previous chain.
      if (switchChainResp?.changed && switchChainResp.prevChainId) {
        this.switchChain(switchChainResp.prevChainId);
      }
    }
  }
}
