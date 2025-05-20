import { Buffer } from 'buffer';
import * as nearAPI from 'near-api-js';
import { JsonRpcProvider } from 'near-api-js/lib/providers';
import {
  AccessKeyViewRaw,
  ExecutionStatus,
  FinalExecutionOutcome,
} from 'near-api-js/lib/providers/provider';
import { stringifyJsonOrBytes } from 'near-api-js/lib/transaction';
import { parseRpcError } from 'near-api-js/lib/utils/rpc_errors';
import { bytesToHex, Chain, keccak256, toHex } from 'viem';

import * as wagmiCore from '@wagmi/core';

// @ts-expect-error bs58 is a js library
import bs58 from './bs58';
import {
  DEFAULT_ACCESS_KEY_ALLOWANCE,
  ETHEREUM_ACCOUNT_ABI,
  MAX_TGAS,
  RLP_EXECUTE,
} from './constants';
import { Logger } from './log';
import { Transaction } from './transactions_types';
import { AccountInfo } from './types';
import {
  fetchWithTimeout,
  getErrorMessage,
  getNearAddress,
  signTransactions,
  transformEthereumTransactions,
  validateAccessKey,
} from './utils';

const logger = new Logger('[near-eth]');

export interface SwitchChainResult {
  changed: boolean;
  prevChainId: number | null;
  curChainId: number;
}

export interface NearNetworkConfig {
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
    debug,
  }: {
    nearNetwork: NearNetworkConfig;
    wagmiConfig: wagmiCore.Config;
    keyStore: nearAPI.keyStores.KeyStore;
    onError?: (error: string) => void;
    debug?: boolean;
  }) {
    this.wagmiConfig = wagmiConfig;
    this.wagmiCore = wagmiCore;
    this.nearNetwork = nearNetwork;
    this.onError = onError;

    if (debug) {
      Logger.debug = true;
    }

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

  private async switchChain(
    targetChainId: number,
  ): Promise<SwitchChainResult | null> {
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
  private async getRelayerOnboardingInfo(accountId: string): Promise<{
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { result } = (await response.json()) as any;
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

  private async executeEthereumTransaction({
    tx,
    relayerPublicKey,
  }: {
    tx: Transaction;
    relayerPublicKey: string;
  }): Promise<`0x${string}`> {
    //  Metamask has a check (https://github.com/MetaMask/core/blob/v360.0.0/packages/transaction-controller/src/utils/validation.ts#L100-L110) that
    //  prevents the execution of 'external' transactions (i.e., those originating outside MetaMask) when these transactions have an 'internal'
    //  account address in the to field (i.e., a user's own address within MetaMask) and contain non-empty data.
    //  When issuing an onboarding transaction, we set the to field to the user's own address and utilize the data field to pass required parameters to the Wallet Contract,
    //  specifically to add the provided public key to the account.
    //  We hash to value for AddKey/DeleteKey to bypass that metamask check. In the Wallet Contract itself contract compares to address with address hash.
    const nearChainId = this.nearChain.id;
    const to = (
      /^0x([A-Fa-f0-9]{40})$/.test(tx.receiverId) &&
      !['AddKey', 'DeleteKey'].includes(tx.actions[0].type)
        ? tx.receiverId
        : '0x' + keccak256(toHex(tx.receiverId)).slice(26)
    ) as `0x${string}`;
    let ethTx: wagmiCore.WriteContractParameters;
    switch (tx.actions[0].type) {
      case 'AddKey': {
        const publicKey = bytesToHex(
          bs58.decode(tx.actions[0].params.publicKey.split(':')[1]),
        );
        if (tx.actions[0].params.accessKey.permission === 'FullAccess') {
          const args = [
            0, // 0 stands for ed25519
            publicKey,
            BigInt(tx.actions[0].params.accessKey.nonce ?? 0),
            true,
            false, // Not used with is_full_access
            BigInt(0), // Not used with is_full_access
            '', // Not used with is_full_access
            [], // Not used with is_full_access
          ];
          ethTx = {
            abi: ETHEREUM_ACCOUNT_ABI,
            address: to,
            functionName: 'addKey',
            args,
            chainId: nearChainId,
            type: 'legacy',
          };
          throw new Error('Requesting a FullAccess key is not allowed.');
        } else {
          const allowance = BigInt(
            tx.actions[0].params.accessKey.permission.allowance ??
              DEFAULT_ACCESS_KEY_ALLOWANCE,
          );
          const args = [
            0, // 0 stands for ed25519
            publicKey,
            BigInt(tx.actions[0].params.accessKey.nonce ?? 0),
            false,
            allowance > 0 ? true : false,
            allowance,
            tx.actions[0].params.accessKey.permission.receiverId,
            tx.actions[0].params.accessKey.permission.methodNames ?? [],
          ];
          ethTx = {
            abi: ETHEREUM_ACCOUNT_ABI,
            address: to,
            functionName: 'addKey',
            args,
            gasPrice:
              tx.actions[0].params.publicKey === relayerPublicKey &&
              tx.receiverId ===
                tx.actions[0].params.accessKey.permission.receiverId
                ? // Free onboarding tx: fix 1 wei gasPrice because some wallets ignore 0 gasPrice.
                  // Rpc will also return a dust eth_getBalance for accounts not yet onboarded to trick wallets
                  // into accepting this free transaction even before the user owns NEAR.
                  BigInt(1)
                : undefined,
            chainId: nearChainId,
            type: 'legacy',
          };
        }
        break;
      }
      case 'DeleteKey': {
        const publicKey = bytesToHex(
          bs58.decode(tx.actions[0].params.publicKey.split(':')[1]),
        );
        const args = [
          0, // 0 stands for ed25519
          publicKey,
        ];
        ethTx = {
          abi: ETHEREUM_ACCOUNT_ABI,
          address: to,
          functionName: 'deleteKey',
          args,
          chainId: nearChainId,
          type: 'legacy',
        };
        break;
      }
      case 'FunctionCall': {
        const yoctoNear = BigInt(tx.actions[0].params.deposit) % BigInt(1e6);
        const value = BigInt(tx.actions[0].params.deposit) / BigInt(1e6);
        const requestedGas = BigInt(tx.actions[0].params.gas);
        const nearGas = requestedGas <= MAX_TGAS ? requestedGas : MAX_TGAS;
        const args = [
          tx.receiverId,
          tx.actions[0].params.methodName,
          bytesToHex(stringifyJsonOrBytes(tx.actions[0].params.args)),
          nearGas,
          +yoctoNear.toString(),
        ];
        ethTx = {
          abi: ETHEREUM_ACCOUNT_ABI,
          address: to,
          functionName: 'functionCall',
          args,
          value,
          chainId: nearChainId,
          type: 'legacy',
        };
        break;
      }
      case 'Transfer': {
        const yoctoNear = BigInt(tx.actions[0].params.deposit) % BigInt(1e6);
        const value = BigInt(tx.actions[0].params.deposit) / BigInt(1e6);
        const args = [tx.receiverId, +yoctoNear.toString()];
        ethTx = {
          abi: ETHEREUM_ACCOUNT_ABI,
          address: to,
          functionName: 'transfer',
          args,
          value,
          chainId: nearChainId,
          type: 'legacy',
        };
        break;
      }
      default: {
        throw new Error('Invalid action type');
      }
    }
    // NOTE: re-add simulateContract and parse errors after eth_call implements errors.
    // const { request } = await wagmiCore!.simulateContract(wagmiConfig, ethTx);
    const result = await wagmiCore.writeContract(this.wagmiConfig, ethTx);
    return result;
  }

  private async signAndSendEthereumTransactions({
    transactions,
    relayerPublicKey,
    accountId,
  }: {
    transactions: Transaction[];
    relayerPublicKey: string;
    accountId: string;
  }) {
    if (!transactions.length) {
      throw new Error('No transactions to send');
    }

    const nearChainId = this.nearChain.id;
    const results: Array<FinalExecutionOutcome> = [];
    try {
      const ethTxHashes: Array<string> = [];
      for (const [txIndex, tx] of transactions.entries()) {
        logger.log(`Sending transaction [${txIndex}]`, tx);
        const txHash = await this.executeEthereumTransaction({
          tx,
          relayerPublicKey,
        });
        logger.log(`Sent transaction: ${txHash}`);
        ethTxHashes.push(txHash);
        await new Promise((r) => setTimeout(r, 2000));

        let receipt;
        try {
          // NOTE: error is thrown if tx failed so we catch it to get the receipt.
          receipt = await wagmiCore.waitForTransactionReceipt(
            this.wagmiConfig,
            {
              hash: txHash,
              chainId: nearChainId,
            },
          );
        } catch (error) {
          logger.error('waitForTransactionReceipt ', error);
          while (!receipt) {
            try {
              await new Promise((r) => setTimeout(r, 1000));
              receipt = await wagmiCore.getTransactionReceipt(
                this.wagmiConfig,
                {
                  hash: txHash,
                  chainId: nearChainId,
                },
              );
            } catch (err) {
              logger.log(err);
            }
          }
        }
        logger.log('Receipt:', receipt);

        let nearTx;
        while (!nearTx) {
          try {
            await new Promise((r) => setTimeout(r, 1000));
            nearTx = await this.nearProvider.txStatus(
              // eslint-disable-next-line @typescript-eslint/ban-ts-comment
              // @ts-expect-error
              receipt.nearTransactionHash,
              accountId,
            );
          } catch (err) {
            logger.error('signAndSendTransactions#txStatus', err);
          }
        }

        logger.log('transaction:', nearTx);
        if (receipt.status !== 'success') {
          const failedOutcome = nearTx.receipts_outcome.find(
            ({ outcome }) =>
              typeof outcome.status === 'object' &&
              typeof outcome.status.Failure === 'object' &&
              outcome.status.Failure !== null &&
              outcome.executor_id === tx.receiverId,
          );
          if (failedOutcome) {
            throw new Error(
              parseRpcError(
                (failedOutcome.outcome.status as ExecutionStatus).Failure!,
              ).message,
            );
          } else {
            throw new Error(
              'Transaction execution error, failed to parse failure reason.',
            );
          }
        }
        results.push(nearTx);
      }
    } catch (error) {
      logger.error('Failed to execute transactions:', error);
      throw error;
    }

    return results;
  }

  private async addNearAccessKey({
    receiverId,
    relayerPublicKey,
    nearPublicKey,
    nearAccountId,
    methodNames,
  }: {
    receiverId: string;
    relayerPublicKey: string;
    nearPublicKey: string;
    nearAccountId: string;
    methodNames: string[];
  }) {
    const results = await this.signAndSendEthereumTransactions({
      transactions: transformEthereumTransactions([
        {
          signerId: nearAccountId,
          receiverId: nearAccountId,
          actions: [
            {
              type: 'AddKey',
              params: {
                publicKey: nearPublicKey,
                accessKey: {
                  nonce: 0,
                  permission: {
                    receiverId,
                    allowance: DEFAULT_ACCESS_KEY_ALLOWANCE,
                    methodNames,
                  },
                },
              },
            },
          ],
        },
      ]),
      relayerPublicKey,
      accountId: nearAccountId,
    });
    return results;
  }

  private async checkNearAccessKey(
    contractId: string,
    contractMethodNames: string[],
    transactions: Omit<Transaction, 'signerId'>[],
  ) {
    let accessKeyUsable = false;
    const accountInfo = this.signedNearAccountInfo;
    if (!accountInfo) {
      throw new Error('Cannot get account info');
    }
    if (!accountInfo.publicKey) {
      throw new Error('Cannot get public key');
    }
    const nearAccountId = accountInfo.accountId;
    const nearPublicKey = accountInfo.publicKey;
    const relayerPublicKey = accountInfo.relayerPublicKey;
    try {
      const accessKey = await this.nearProvider.query<AccessKeyViewRaw>({
        request_type: 'view_access_key',
        finality: 'final',
        account_id: accountInfo.accountId,
        public_key: nearPublicKey,
      });
      accessKeyUsable = validateAccessKey({
        transactions: transactions,
        accessKey,
      });
    } catch (error) {
      logger.log('checkNearAccessKey#view_access_key', error);
      accessKeyUsable = false;
    }

    if (!accessKeyUsable) {
      if (!relayerPublicKey) {
        throw new Error('Cannot get relayer public key');
      }

      logger.log('checkNearAccessKey#add_access_key');
      await this.addNearAccessKey({
        receiverId: contractId,
        relayerPublicKey,
        nearPublicKey,
        nearAccountId,
        methodNames: contractMethodNames,
      });
    }
  }

  async signAndSendNearTransactions(
    contractId: string,
    contractMethodNames: string[],
    transactions: Transaction[],
  ) {
    if (!transactions.length) {
      throw new Error('No transactions to send');
    }
    const accountInfo = this.signedNearAccountInfo;
    if (!accountInfo) {
      throw new Error('Cannot get account info');
    }
    if (!accountInfo.publicKey) {
      throw new Error('Cannot get public key');
    }

    // check access key
    await this.checkNearAccessKey(
      contractId,
      contractMethodNames,
      transactions,
    );

    logger.log(`Sending near transaction`, transactions);
    const signer = new nearAPI.InMemorySigner(this.keyStore);
    const signedTransactions = await signTransactions(
      transactions,
      signer,
      this.nearNetwork,
    );
    const results: Array<FinalExecutionOutcome> = [];
    for (let i = 0; i < signedTransactions.length; i += 1) {
      const nearTx = await this.nearProvider.sendTransaction(
        signedTransactions[i],
      );
      logger.log('NEAR transaction:', nearTx);
      if (
        typeof nearTx.status === 'object' &&
        typeof nearTx.status.Failure === 'object' &&
        nearTx.status.Failure !== null
      ) {
        logger.error('Transaction execution error.');
        throw parseRpcError(nearTx.status.Failure);
      }
      results.push(nearTx);
    }
    return results;
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
          await this.signAndSendEthereumTransactions({
            transactions: [onboardingTransaction],
            relayerPublicKey,
            accountId: nearAccountId,
          });
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

  async onSignOut(): Promise<void> {
    try {
      if (this.signedNearAccountInfo?.publicKey) {
        this.keyStore.removeKey(
          this.nearNetwork.networkId,
          this.signedNearAccountInfo.accountId,
        );
      }
      this.signedNearAccountInfo = null;
      this.wagmiCore.disconnect(this.wagmiConfig);
    } catch (error) {
      logger.error(error);
    }
  }
}
