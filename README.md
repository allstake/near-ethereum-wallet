# Near Ethereum Wallet

A TypeScript package that facilitates sending NEAR transactions with your Ethereum wallet


## Features

- Send NEAR transactions using your Ethereum wallet
- TypeScript support
- Compatible with wagmi and viem
- Modern web3 integration

## Installation

```bash
npm install near-ethereum-wallet
# or
yarn add near-ethereum-wallet
# or
pnpm add near-ethereum-wallet
```


## API Documentation

### Core Types

```typescript
interface AccountInfo {
  accountId: string;
  balance: string;
  codeHash: string;
  storageUsage: number;
  storagePaidAt: number;
  blockHeight: number;
  blockHash: string;
}

interface SwitchChainResult {
  changed: boolean;
  prevChainId: number | null;
  curChainId: number;
}
```

### Main Functions

#### `getNearAddress(ethereumAddress: string): string`
Converts an Ethereum address to a NEAR address.

#### `validateAccessKey(accessKey: AccessKeyViewRaw): boolean`
Validates if an access key is valid for transactions.

#### `signTransactions(transactions: Transaction[]): Promise<SignedTransaction[]>`
Signs an array of NEAR transactions.

#### `transformEthereumTransactions(transactions: Transaction[]): Promise<Transaction[]>`
Transforms Ethereum-style transactions into NEAR-compatible transactions.

### Transaction Types

```typescript
type Action =
  | CreateAccountAction
  | DeployContractAction
  | FunctionCallAction
  | TransferAction
  | StakeAction
  | AddKeyAction
  | DeleteKeyAction
  | DeleteAccountAction;

interface Transaction {
  signerId: string;
  publicKey: PublicKey;
  nonce: number;
  receiverId: string;
  actions: Action[];
  blockHash: Uint8Array;
}
```

### Constants

```typescript
const DEFAULT_ACCESS_KEY_ALLOWANCE = '250000000000000000000000';
const MAX_TGAS = '300000000000000';
const RLP_EXECUTE = 'rlp_execute';
```

### Usage Example

```typescript
import { NearEthereumWallet } from 'near-ethereum-wallet';
import { createConfig, http } from 'wagmi';
import { sepolia } from 'wagmi/chains';

// Configure wagmi
const config = createConfig({
  chains: [sepolia],
  transports: {
    [sepolia.id]: http(),
  },
});

// Initialize wallet
const wallet = new NearEthereumWallet({
  config,
  // Additional options
});

// Send a transaction
const result = await wallet.sendTransaction({
  receiverId: 'example.near',
  actions: [{
    type: 'FunctionCall',
    params: {
      methodName: 'example_method',
      args: {},
      gas: '300000000000000',
      deposit: '0'
    }
  }]
});
```

## Dependencies

- @wagmi/core: ^2.17.2
- near-api-js: ^5.1.1
- viem: ^2.29.2
- big.js: ^7.0.1
- bn.js: ^5.2.2
- buffer: ^6.0.3

## Development

```bash
# Install dependencies
pnpm install

# Build the package
pnpm build

# Run tests
pnpm test
```

## License

MIT License - see the [LICENSE](LICENSE) file for details.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
