"use client";

import {
  BaseSignerWalletAdapter,
  WalletNotConnectedError,
  WalletReadyState,
  type SendTransactionOptions,
  type SupportedTransactionVersions,
  type WalletName,
} from "@solana/wallet-adapter-base";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionSignature,
  VersionedTransaction,
  type TransactionVersion,
} from "@solana/web3.js";

declare global {
  interface Window {
    __VEIL_TEST_WALLET_SECRET__?: number[];
  }
}

const TEST_WALLET_NAME = "Veil Test Wallet" as WalletName<"Veil Test Wallet">;

const ICON =
  "data:image/svg+xml;base64," +
  btoa(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#7c3aed"/><text x="12" y="16" text-anchor="middle" font-family="monospace" font-size="11" fill="#fff">T</text></svg>',
  );

export class TestWalletAdapter extends BaseSignerWalletAdapter {
  readonly name = TEST_WALLET_NAME;
  readonly url = "https://veil.local";
  readonly icon = ICON;
  readonly supportedTransactionVersions: SupportedTransactionVersions = new Set<TransactionVersion>([
    "legacy",
    0,
  ]);

  private _keypair: Keypair | null = null;
  private _publicKey: PublicKey | null = null;
  private _connecting = false;

  get readyState(): WalletReadyState {
    if (typeof window === "undefined") return WalletReadyState.Unsupported;
    return window.__VEIL_TEST_WALLET_SECRET__
      ? WalletReadyState.Installed
      : WalletReadyState.NotDetected;
  }

  get connecting() {
    return this._connecting;
  }

  get publicKey() {
    return this._publicKey;
  }

  async connect(): Promise<void> {
    if (this.connected || this._connecting) return;
    this._connecting = true;
    try {
      const secret = typeof window !== "undefined" ? window.__VEIL_TEST_WALLET_SECRET__ : undefined;
      if (!secret) throw new Error("Test wallet secret not injected");
      this._keypair = Keypair.fromSecretKey(Uint8Array.from(secret));
      this._publicKey = this._keypair.publicKey;
      this.emit("connect", this._publicKey);
    } finally {
      this._connecting = false;
    }
  }

  async disconnect(): Promise<void> {
    this._keypair = null;
    this._publicKey = null;
    this.emit("disconnect");
  }

  async signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
    if (!this._keypair) throw new WalletNotConnectedError();
    if (tx instanceof VersionedTransaction) {
      tx.sign([this._keypair]);
    } else {
      tx.partialSign(this._keypair);
    }
    return tx;
  }

  async signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]> {
    return Promise.all(txs.map((t) => this.signTransaction(t)));
  }

  async sendTransaction(
    tx: Transaction | VersionedTransaction,
    connection: Connection,
    options: SendTransactionOptions = {},
  ): Promise<TransactionSignature> {
    if (!this._keypair) throw new WalletNotConnectedError();
    const signed = await this.signTransaction(tx);
    const raw = signed.serialize();
    const sig = await connection.sendRawTransaction(raw, options);
    return sig;
  }
}
