# NEAR Ethereum Wallet

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

### Main Functions

#### `signIn({contractId: string}): Promise<AccountInfo | null>`

#### `signOut(): Promise<void>`

#### `signAndSendTransactions(transactions: Transaction[]): Promise<signAndSendTransactions[]>`

### Usage Example

```typescript
import { createConfig, http, injected } from 'wagmi';
import { sepolia } from 'wagmi/chains';
import { walletConnect } from 'wagmi/connectors';

// Testnet
const near = {
  id: 398,
  name: 'NEAR Protocol Testnet',
  nativeCurrency: {
    decimals: 18,
    name: 'NEAR',
    symbol: 'NEAR',
  },
  rpcUrls: {
    default: { http: ['https://eth-rpc.testnet.near.org'] },
    public: { http: ['https://eth-rpc.testnet.near.org'] },
  },
  blockExplorers: {
    default: {
      name: 'NEAR Explorer',
      url: 'https://eth-explorer-testnet.near.org',
    },
  },
  testnet: true,
};

// Mainnet
// const near: Chain = {
//   id: 397,
//   name: "NEAR Protocol",
//   nativeCurrency: {
//     decimals: 18,
//     name: "NEAR",
//     symbol: "NEAR",
//   },
//   rpcUrls: {
//     default: { http: ["https://eth-rpc.mainnet.near.org"] },
//     public: { http: ["https://eth-rpc.mainnet.near.org"] },
//   },
//   blockExplorers: {
//     default: {
//       name: "NEAR Explorer",
//       url: "https://eth-explorer.near.org",
//     },
//   },
// }

// Get a project ID at https://cloud.walletconnect.com
const projectId = '';

const wagmiConfig: Config = createConfig({
  chains: [near],
  transports: {
    [near.id]: http(),
  },
  connectors: [
    walletConnect({
      projectId,
      metadata: {
        name: 'NEAR Guest Book',
        description: 'A guest book with comments stored on the NEAR blockchain',
        url: 'https://near.github.io/wallet-selector',
        icons: ['https://near.github.io/wallet-selector/favicon.ico'],
      },
      showQrModal: false,
    }),
    injected({ shimDisconnect: true }),
  ],
});

const wallet = new NearEthereumWallet({
  nearNetwork: {
    networkId: 'testnet',
    nodeUrl: 'https://neart.lava.build',
    walletUrl: 'https://testnet.mynearwallet.com',
    helperUrl: 'https://helper.testnet.near.org',
  },
  wagmiConfig,
  keyStore: new keyStores.BrowserLocalStorageKeyStore(),
  onError(error) {
    console.error('Error', error);
    alert(JSON.stringify(error));
  },
  debug: true,
});

// You can refer to the example specifically.
```

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
