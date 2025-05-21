import './App.css';

import { keyStores } from 'near-api-js';
import { NearEthereumWallet } from 'near-ethereum-wallet';
import { useEffect, useState } from 'react';
import { useAccount, useChainId, useConnect, useDisconnect } from 'wagmi';

import { wagmiConfig } from './config';

import type { Connector } from 'wagmi';

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
  debug: true
})


function App() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [nearAccount, setNearAccount] = useState<any>(null);
  const [nearConnecting, setNearConnecting] = useState(false);
  const chainId = useChainId();
  const { connectors, connectAsync } = useConnect();
  const { disconnect } = useDisconnect();
  const { address } = useAccount()
  console.log('chainId', chainId, 'connectors', connectors);

  if (nearAccount) {
    return <div>
      <h2>Near Connected</h2>
      <p>Address: {nearAccount.accountId}</p>
      <div>
        <button
          type="button" onClick={async () => {
            await wallet.signAndSendTransactions([
              {
                signerId: nearAccount.accountId,
                receiverId: 'hello.near-examples.testnet',
                actions: [
                  {
                    type: 'FunctionCall',
                    params: {
                      methodName: 'set_greeting',
                      args: { greeting: 'Hello' },
                      gas: "30000000000000",
                      deposit: "0",
                    },
                  },
                ]
              }
            ])
          }}>
          Call
        </button>
        <button
          type="button" onClick={async () => {
            await wallet.signOut()
            setNearAccount(null)
          }}>
          Disconnect
        </button>
      </div>
    </div>
  }

  if (address) {
    return <div>
      <h2>Connected</h2>
      <p>Address: {address}</p>
      <div>
        <button
          type="button" onClick={() => {
            disconnect()
          }}>
          Disconnect
        </button>
        <button
          className={nearConnecting ? 'disabled' : ''}
          type="button" onClick={async () => {
            if (nearConnecting) return
            setNearConnecting(true);
            const nearAccount = await wallet.signIn({
              contractId: 'hello.near-examples.testnet',
            })
            if (!nearAccount) {
              setNearConnecting(false)
              alert('No account found');
              return;
            }
            setNearAccount(nearAccount);
            setNearConnecting(false)
          }}>
          Connect Near
        </button>
      </div>
    </div>
  }

  return (
    <div>
      <div className="connectors">
        {connectors.map((connector) => (
          <ConnectorButton
            key={connector.uid}
            connector={connector}
            onClick={async () => {
              const resp = await connectAsync({ connector, chainId })
              console.log('connect', resp);
            }}
          />
        ))}
      </div>
  </div>
  )
}


function ConnectorButton({
  connector,
  onClick,
}: {
  connector: Connector;
  onClick: () => void;
}) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    (async () => {
      const provider = await connector.getProvider();
      setReady(!!provider);
    })();
  }, [connector, setReady]);

  if (!ready) return null

  return (
    <button
      className="button"
      disabled={!ready}
      onClick={onClick}
      type="button"
    >
      {connector.name}
    </button>
  );
}


export default App
