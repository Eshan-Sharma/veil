import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The Ika pre-alpha Solana client ships .ts sources via package "exports",
  // so Next has to transpile them inside node_modules. (Its `.js` extension
  // imports are stripped by `scripts/patch-ika-sdk.mjs` postinstall.)
  transpilePackages: ["@ika.xyz/pre-alpha-solana-client"],
};

export default nextConfig;
