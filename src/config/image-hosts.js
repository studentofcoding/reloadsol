/** @type {string[]} */
const IMAGE_REMOTE_HOSTS = [
  "raw.githubusercontent.com",
  "github.com",
  "assets.coingecko.com",
  "coin-images.coingecko.com",
  "cryptologos.cc",
  "tokens.1inch.io",
  "jupiter-aggregator.vercel.app",
  "s3.coinmarketcap.com",
  "pbs.twimg.com",
  "ipfs.io",
  "arweave.net",
  "cdn.jsdelivr.net",
  "i.degencdn.com",
  "proxy.duckduckgo.com",
  "ipfs.filebase.io",
  "image-cdn.solana.fm",
  "cf-ipfs.com",
  "kuji44lsf4frvko7srm7jdj6nqy2jzvdl5hy5dsodi7nva75rbtq.arweave.net",
];

/** Hosts with flaky/missing assets — load directly in browser, skip /_next/image upstream fetch. */
const UNOPTIMIZED_IMAGE_HOSTS = ["static-create.jup.ag"];

module.exports = { IMAGE_REMOTE_HOSTS, UNOPTIMIZED_IMAGE_HOSTS };
