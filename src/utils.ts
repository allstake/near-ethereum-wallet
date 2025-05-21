import type { Signer } from 'near-api-js';
import * as nearAPI from 'near-api-js';

import { Action, AddKeyPermission, Transaction } from './transactions_types';
import { NearNetworkConfig } from './types';

import type {
  AccessKeyViewRaw,
  FunctionCallPermissionView,
} from 'near-api-js/lib/providers/provider';

const { transactions, utils } = nearAPI;

export function getNearAddress(ethAccountAddress?: string): string {
  return ethAccountAddress?.toLowerCase() || '';
}

function getAccessKey(permission: AddKeyPermission) {
  if (permission === 'FullAccess') {
    return transactions.fullAccessKey();
  }

  const { receiverId, methodNames = [] } = permission;
  const allowance = permission.allowance
    ? BigInt(permission.allowance)
    : undefined;

  return transactions.functionCallAccessKey(receiverId, methodNames, allowance);
}

function createAction(action: Action) {
  switch (action.type) {
    case 'CreateAccount':
      return transactions.createAccount();
    case 'DeployContract': {
      const { code } = action.params;

      return transactions.deployContract(code);
    }
    case 'FunctionCall': {
      const { methodName, args, gas, deposit } = action.params;

      return transactions.functionCall(
        methodName,
        args,
        BigInt(gas),
        BigInt(deposit),
      );
    }
    case 'Transfer': {
      const { deposit } = action.params;

      return transactions.transfer(BigInt(deposit));
    }
    case 'Stake': {
      const { stake, publicKey } = action.params;

      return transactions.stake(BigInt(stake), utils.PublicKey.from(publicKey));
    }
    case 'AddKey': {
      const { publicKey, accessKey } = action.params;

      return transactions.addKey(
        utils.PublicKey.from(publicKey),
        // TODO: Use accessKey.nonce? near-api-js seems to think 0 is fine?
        getAccessKey(accessKey.permission),
      );
    }
    case 'DeleteKey': {
      const { publicKey } = action.params;

      return transactions.deleteKey(utils.PublicKey.from(publicKey));
    }
    case 'DeleteAccount': {
      const { beneficiaryId } = action.params;

      return transactions.deleteAccount(beneficiaryId);
    }
    default:
      throw new Error('Invalid action type');
  }
}

export async function signTransactions(
  transactions: Array<Transaction>,
  signer: Signer,
  network: NearNetworkConfig,
) {
  const provider = new nearAPI.providers.JsonRpcProvider({
    url: network.nodeUrl,
  });

  const signedTransactions: Array<nearAPI.transactions.SignedTransaction> = [];

  for (let i = 0; i < transactions.length; i++) {
    const publicKey = await signer.getPublicKey(
      transactions[i].signerId,
      network.networkId,
    );

    const [block, accessKey] = await Promise.all([
      provider.block({ finality: 'final' }),
      provider.query<AccessKeyViewRaw>({
        request_type: 'view_access_key',
        finality: 'final',
        account_id: transactions[i].signerId,
        public_key: publicKey.toString(),
      }),
    ]);

    const actions = transactions[i].actions.map((action) =>
      createAction(action),
    );

    const transaction = nearAPI.transactions.createTransaction(
      transactions[i].signerId,
      nearAPI.utils.PublicKey.from(publicKey.toString()),
      transactions[i].receiverId,
      accessKey.nonce + i + 1,
      actions,
      nearAPI.utils.serialize.base_decode(block.header.hash),
    );

    const response = await nearAPI.transactions.signTransaction(
      transaction,
      signer,
      transactions[i].signerId,
      network.networkId,
    );

    signedTransactions.push(response[1]);
  }

  return signedTransactions;
}

// Separate actions into individual transactions because not available in 0x accounts.
export function transformEthereumTransactions(
  transactions: Array<Transaction>,
): Array<Transaction> {
  return transactions
    .map((transaction) => {
      return transaction.actions.map((action) => {
        return {
          signerId: transaction.signerId,
          receiverId: transaction.receiverId,
          actions: [action],
        };
      });
    })
    .flat();
}

// Check if accessKey is usable to execute all transaction.
export function validateAccessKey({
  transactions,
  accessKey,
}: {
  transactions: Array<Omit<Transaction, 'signerId'>>;
  accessKey: AccessKeyViewRaw;
}): boolean {
  if (accessKey.permission === 'FullAccess') {
    return true;
  }
  return transactions.every((tx) => {
    const { receiver_id, method_names } = (
      accessKey.permission as FunctionCallPermissionView
    ).FunctionCall;
    if (receiver_id !== tx.receiverId) {
      return false;
    }
    return tx.actions.every((action) => {
      if (action.type !== 'FunctionCall') {
        return false;
      }
      const { methodName, deposit } = action.params;
      if (method_names.length && !method_names.includes(methodName)) {
        return false;
      }
      return BigInt(deposit) <= 0;
    });
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getErrorMessage(e: any) {
  if (e.details && typeof e.details === 'string') {
    return e.details;
  }

  // handle register error
  if (typeof e === 'object') {
    if (e.response && e.response?.data?.message) {
      console.log('e.response.data.message', e.response.data.message);
      return e.response.data.message;
    }
  }
  // handle near ExecutionError
  if (e instanceof Error) {
    try {
      const obj = JSON.parse(e.message);
      if (obj[0]?.kind?.ExecutionError) {
        console.log('obj[0].kind.ExecutionError', obj[0].kind.ExecutionError);
        return obj[0].kind.ExecutionError;
      } else if (obj.kind && obj.kind?.ExecutionError) {
        return obj.kind.ExecutionError;
      } else {
        return e.message;
      }
    } catch {
      return e.message;
    }
  } else {
    return JSON.stringify(e);
  }
}

export function fetchWithTimeout(
  url: string,
  {
    options,
    timeout = 1000 * 60,
  }: {
    timeout?: number;
    options?: RequestInit;
  } = {},
): Promise<Response> {
  const controller = new AbortController();
  const signal = controller.signal;

  const fetchPromise = fetch(url, { ...options, signal });
  const timeoutId = setTimeout(
    () => controller.abort('Request timeout'),
    timeout,
  );
  return fetchPromise.finally(() => clearTimeout(timeoutId));
}
