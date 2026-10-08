import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Node, CHAIN_VERSION } from './node.js';
import { Blockchain } from './chain/blockchain.js';
import { encodeBlock, encodeHeader, hashHeader, HEADER_LEN, type Block } from './chain/block.js';
import { getAccount, serializeState, serializeLocks } from './chain/state.js';
import { generateKeyPair } from './crypto/keys.js';
import { bytesToHex } from './util/binary.js';
import { emptyMine } from './chain/testutil.js';

// Only the browser storage boundary is replaced; chain validation and Node's
// snapshot/header restore paths are real. Tests never contact live peers.
const storage = vi.hoisted(() => ({
  meta: new Map<string, unknown>(),
  blocks: new Map<string, { hash: string; height: number; encoded: Uint8Array }>(),
}));
vi.mock('./storage/idb.js', () => ({
  getMeta: async (key: string) => structuredClone(storage.meta.get(key)),
  putMeta: async (key: string, value: unknown) => { storage.meta.set(key, structuredClone(value)); },
  delMeta: async (key: string) => { storage.meta.delete(key); },
  clearAll: async () => { storage.meta.clear(); storage.blocks.clear(); },
  getAllBlocksOrdered: async () => [...storage.blocks.values()].sort((a, b) => a.height - b.height),
  putBlock: async (hash: string, height: number, encoded: Uint8Array) => {
    storage.blocks.set(hash, { hash, height, encoded });
  },
  listCachedPeers: async () => [],
  recordPeerFailure: async () => {},
  recordPeerSeen: async () => {},
}));

const miner = generateKeyPair();
const reference = new Blockchain();
const blocks: Block[] = [];
let staleFork: Block;

beforeAll(async () => {
  for (let i = 0; i < 4; i++) {
    const block = await emptyMine(reference, miner.publicKey);
    expect(await reference.addBlock(block)).toBeNull();
    blocks.push(block);
  }
  const branch = new Blockchain();
  expect(await branch.addBlock(blocks[0]!)).toBeNull();
  staleFork = await emptyMine(branch, generateKeyPair().publicKey);
}, 180_000);

beforeEach(() => {
  storage.meta.clear();
  storage.blocks.clear();
  const wallet = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => wallet.get(key) ?? null,
    setItem: (key: string, value: string) => { wallet.set(key, value); },
    removeItem: (key: string) => { wallet.delete(key); },
  });
  vi.useFakeTimers(); // Keep debounced snapshot writes out of reload assertions.
  storage.meta.set('chainVersion', CHAIN_VERSION);
  const anchor = reference.snapshotAt(3)!;
  storage.meta.set('stateSnapshot', {
    v: 1, chainVersion: CHAIN_VERSION,
    finalizedHeight: anchor.height, finalizedHashHex: anchor.hashHex,
    accounts: serializeState(anchor.state), locks: serializeLocks(anchor.state),
  });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function restore(node: Node): Promise<void> {
  await (node as unknown as { restoreFromIdb(): Promise<void> }).restoreFromIdb();
}

function cacheBlocks(from: number): void {
  for (const block of blocks.slice(from)) {
    const hash = bytesToHex(hashHeader(block.header));
    storage.blocks.set(hash, { hash, height: block.header.height, encoded: encodeBlock(block) });
  }
}

function cacheHeaders(): void {
  const anchor = reference.snapshotAt(3)!;
  const bytes = new Uint8Array(3 * HEADER_LEN);
  blocks.slice(0, 3).forEach((block, i) => bytes.set(encodeHeader(block.header), i * HEADER_LEN));
  storage.meta.set('headerChain', {
    v: 1, chainVersion: CHAIN_VERSION,
    anchorHeight: anchor.height, anchorHashHex: anchor.hashHex, bytes,
  });
}

describe('Node snapshot persistence after rejected peer forks', () => {
  it.each(['snapshot', 'header-chain'] as const)(
    'keeps the %s cache usable on reload after an old fork is rejected',
    async (mode) => {
      cacheBlocks(mode === 'snapshot' ? 0 : 3);
      if (mode === 'header-chain') cacheHeaders();
      const cached = structuredClone(storage.meta);
      const node = new Node();
      await restore(node);
      const tipHash = bytesToHex(node.chain.tip.hash);
      expect(node.chain.getBlock(bytesToHex(hashHeader(blocks[0]!.header)))!.state).toBeNull();

      expect(await node.chain.addBlock(staleFork)).toMatch(/parent state unavailable/);
      expect(bytesToHex(node.chain.tip.hash)).toBe(tipHash);
      expect(storage.meta).toEqual(cached);

      const reopened = new Node();
      await restore(reopened);
      expect(bytesToHex(reopened.chain.tip.hash)).toBe(bytesToHex(reference.tip.hash));
      expect(getAccount(reopened.chain.tipState, miner.address).balance)
        .toBe(getAccount(reference.tipState, miner.address).balance);
      // A full replay would materialize this prefix; staying null proves the
      // preserved snapshot was actually used, even with missing block bodies.
      expect(reopened.chain.getBlock(bytesToHex(hashHeader(blocks[0]!.header)))!.state).toBeNull();
    },
  );

  it.each(['snapshot', 'header-chain'] as const)(
    'still discards a corrupt %s cache and reconstructs the verified state',
    async (mode) => {
      cacheBlocks(0);
      if (mode === 'header-chain') cacheHeaders();
      (storage.meta.get('stateSnapshot') as { accounts: unknown[] }).accounts = [];
      const node = new Node();
      await restore(node);
      expect(storage.meta.has('stateSnapshot')).toBe(false);
      expect(storage.meta.has('headerChain')).toBe(false);
      expect(bytesToHex(node.chain.tip.hash)).toBe(bytesToHex(reference.tip.hash));
      expect(getAccount(node.chain.tipState, miner.address).balance)
        .toBe(getAccount(reference.tipState, miner.address).balance);
      expect(node.chain.getBlock(bytesToHex(hashHeader(blocks[0]!.header)))!.state).not.toBeNull();
    },
  );
});
