import { ethers } from 'ethers';

const pk = process.env.POLYMARKET_ACCOUNT_PRIVATE_KEY ?? '';
const wallet = new ethers.Wallet(pk);
const ts = Math.floor(Date.now() / 1000).toString();

const domain = { name: 'ClobAuthDomain', version: '1', chainId: 137 };
const types = {
  ClobAuth: [
    { name: 'address', type: 'address' },
    { name: 'timestamp', type: 'string' },
    { name: 'nonce', type: 'uint256' },
    { name: 'message', type: 'string' },
  ],
};
const value = {
  address: wallet.address,
  timestamp: ts,
  nonce: 0,
  message: 'This message attests that I control the given wallet',
};

const sig = await wallet.signTypedData(domain, types, value);
const recovered = ethers.verifyTypedData(domain, types, value, sig);

console.log('Wallet address  :', wallet.address);
console.log('Recovered addr  :', recovered);
console.log('Match           :', wallet.address.toLowerCase() === recovered.toLowerCase());
console.log('Sig v byte      :', parseInt(sig.slice(-2), 16), '(27 ou 28 attendu)');
console.log('');

// Test avec headers frais
const res = await fetch('https://clob.polymarket.com/auth/derive-api-key', {
  headers: {
    'POLY-ADDRESS': wallet.address,
    'POLY-SIGNATURE': sig,
    'POLY-TIMESTAMP': ts,
    'POLY-NONCE': '0',
  },
  signal: AbortSignal.timeout(15_000),
});
console.log('HTTP status :', res.status);
console.log('Response    :', await res.text());
