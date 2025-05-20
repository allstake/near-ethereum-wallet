import { createConfig, http, injected } from 'wagmi';
import { sepolia } from 'wagmi/chains';
import { walletConnect } from 'wagmi/connectors';

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

const projectId = import.meta.env.VITE_PROJECT_ID as string;
if (!projectId) {
  throw new Error('VITE_PROJECT_ID is not defined');
}

export const wagmiConfig = createConfig({
  chains: [sepolia, near],
  transports: {
    [sepolia.id]: http(),
    [near.id]: http(),
  },
  connectors: [
    walletConnect({
      projectId,
      metadata: {
        name: "NEAR Guest Book",
        description: "A guest book with comments stored on the NEAR blockchain",
        url: window.location.protocol + '//' + window.location.host,
        icons: ["https://near.github.io/wallet-selector/favicon.ico"],
      },
      showQrModal: false
    }),
    injected({ shimDisconnect: true }),
  ],
});
