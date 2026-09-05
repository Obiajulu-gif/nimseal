// Final consistency check: does the deployed SITE agree with the deployed CHAIN?
// Every value is fetched independently from each source and compared.

import { createPublicClient, http, getAddress } from "viem";

// Point this at your deployed site and chain. Defaults target a Sepolia test deployment; override
// for Polygon production:
//   VERIFY_SITE=https://your-app.example VERIFY_CHAIN_ID=137 VERIFY_RPC=https://polygon-rpc.com npm run verify-live
const SITE = process.env.VERIFY_SITE ?? "http://localhost:3000";
const CHAIN_ID = Number(process.env.VERIFY_CHAIN_ID ?? 11155111);
const RPC =
  process.env.VERIFY_RPC ??
  (CHAIN_ID === 137 ? "https://polygon-rpc.com" : "https://rpc.sepolia.org");

const ESCROW_ABI = [
  { type: "function", name: "attestorAddress", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  { type: "function", name: "SETTLEMENT_TOKEN", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  { type: "function", name: "tokenScale", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "owner", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  { type: "function", name: "nextInvoiceId", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "totalEscrowed", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "paused", inputs: [], outputs: [{ type: "bool" }], stateMutability: "view" },
];
const ERC20_ABI = [
  { type: "function", name: "symbol", inputs: [], outputs: [{ type: "string" }], stateMutability: "view" },
  { type: "function", name: "decimals", inputs: [], outputs: [{ type: "uint8" }], stateMutability: "view" },
];

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
  ok ? pass++ : fail++;
};

const chain = {
  id: CHAIN_ID,
  name: CHAIN_ID === 137 ? "Polygon" : "Sepolia",
  nativeCurrency:
    CHAIN_ID === 137
      ? { name: "POL", symbol: "POL", decimals: 18 }
      : { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
};
const client = createPublicClient({ chain, transport: http(RPC) });

console.log("Site reachability");
const infoRes = await fetch(`${SITE}/api/attestor/info`);
check("GET /api/attestor/info", infoRes.ok, `HTTP ${infoRes.status}`);
const info = await infoRes.json();

const homeRes = await fetch(SITE);
const homeHtml = await homeRes.text();
check("home page serves", homeRes.ok && homeHtml.includes("nimSeal"), `HTTP ${homeRes.status}`);
check("home page is not an auth wall", !homeHtml.includes("Vercel Authentication") && !homeHtml.includes("_vercel/sso"));
check("no Flare branding in served HTML", !/flare|coston|ftso|fxrp/i.test(homeHtml));

console.log("\nChain reachability");
const block = await client.getBlockNumber();
check("RPC head", block > 0n, `block ${block}`);
check("chain id", (await client.getChainId()) === CHAIN_ID, String(CHAIN_ID));

console.log("\nSite ↔ chain agreement");
const escrow = getAddress(info.escrowContract);
const code = await client.getBytecode({ address: escrow });
check("escrow has code on chain", !!code && code !== "0x", escrow);
check("site chainId matches RPC", info.chainId === CHAIN_ID, String(info.chainId));

const read = (functionName) => client.readContract({ address: escrow, abi: ESCROW_ABI, functionName });

const onChainAttestor = await read("attestorAddress");
check("attestor: site == chain",
  getAddress(onChainAttestor) === getAddress(info.attestorAddress),
  getAddress(onChainAttestor));

// The public key the browser encrypts to must derive to the address the escrow verifies.
// If these ever diverge, every invoice is unrelayable and the failure is silent until relay.
const { publicKeyToAddress } = await import("viem/utils");
const derived = publicKeyToAddress(info.publicKey);
check("published pubkey derives to that attestor", getAddress(derived) === getAddress(onChainAttestor));

const token = await read("SETTLEMENT_TOKEN");
const [symbol, decimals] = await Promise.all([
  client.readContract({ address: token, abi: ERC20_ABI, functionName: "symbol" }),
  client.readContract({ address: token, abi: ERC20_ABI, functionName: "decimals" }),
]);
check("settlement token", ["USDT", "USDT0"].includes(symbol) && decimals === 6, `${token} ${symbol}/${decimals}d`);
check("tokenScale matches decimals", (await read("tokenScale")) === 10n ** BigInt(decimals));

console.log("\nEscrow state");
check("not paused", (await read("paused")) === false);
check("owner set", (await read("owner")) !== "0x0000000000000000000000000000000000000000", await read("owner"));
const next = await read("nextInvoiceId");
check("has settled invoices", next > 1n, `${next - 1n} invoice(s) created`);
check("no funds stranded in escrow", (await read("totalEscrowed")) === 0n);

console.log("\nAttestor behaviour");
const bad = await fetch(`${SITE}/api/attestor/create`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ ciphertext: "0xdeadbeef" }),
});
const badBody = await bad.json();
check("garbage ciphertext refused", bad.status === 400 && badBody.ok === false, `${bad.status} ${badBody.error}`);
check("error leaks no internals", !JSON.stringify(badBody).toLowerCase().includes("private"));

console.log(fail === 0
  ? `\nALL ${pass} CHECKS PASSED — site and chain agree, demo is live.`
  : `\n${fail} of ${pass + fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
