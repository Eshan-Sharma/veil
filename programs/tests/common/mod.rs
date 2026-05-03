/*!
Shared helpers for integration tests.

`RuntimeAccount` layout (repr C, 88-byte header):
  offset  0 : borrow_state  u8   (0xFF = NOT_BORROWED / non-duplicate)
  offset  1 : is_signer     u8
  offset  2 : is_writable   u8
  offset  3 : executable    u8
  offset  4 : padding       [u8; 4]
  offset  8 : address       [u8; 32]
  offset 40 : owner         [u8; 32]
  offset 72 : lamports      u64 LE
  offset 80 : data_len      u64 LE
  offset 88 : data          [u8; data_len]

Alignment: `LendingPool` contains u128 fields (align=16). We start the
RuntimeAccount at byte offset 8 inside a `Vec<u128>` (16-byte aligned by the
allocator), so data lands at byte 96 = 6×16. ✓
*/

use pinocchio::{account::RuntimeAccount, AccountView, Address};
use veil_lending::{math::WAD, state::LendingPool};

const ACCOUNT_HEADER: usize = 88;
const BACKING_OFFSET: usize = 8; // data at 8+88=96 (multiple of 16)

// Each integration test binary in `tests/` is compiled separately. Helpers
// here are exercised by some binaries (e.g. `protocol_tests.rs`) and not by
// others (e.g. `scenarios_ika_encrypt.rs`), so per-binary dead-code lints
// fire spuriously. Suppress them at the API surface — the items ARE used,
// just not by every test crate that pulls in this module.
#[allow(dead_code)]
pub struct RawAccount {
    backing: Vec<u128>,
}

#[allow(dead_code)]

impl RawAccount {
    pub fn new(key: [u8; 32], is_signer: bool, is_writable: bool, data: &[u8]) -> Self {
        Self::new_with_owner(key, [0u8; 32], is_signer, is_writable, data)
    }

    pub fn new_with_owner(
        key: [u8; 32],
        owner: [u8; 32],
        is_signer: bool,
        is_writable: bool,
        data: &[u8],
    ) -> Self {
        let total_bytes = BACKING_OFFSET + ACCOUNT_HEADER + data.len();
        let words = (total_bytes + 15) / 16;
        let mut backing = vec![0u128; words];

        let bytes = unsafe {
            core::slice::from_raw_parts_mut(backing.as_mut_ptr() as *mut u8, total_bytes)
        };
        let hdr = &mut bytes[BACKING_OFFSET..];
        hdr[0] = 0xFF; // NOT_BORROWED
        hdr[1] = if is_signer { 1 } else { 0 };
        hdr[2] = if is_writable { 1 } else { 0 };
        hdr[8..40].copy_from_slice(&key);
        hdr[40..72].copy_from_slice(&owner);
        hdr[72..80].copy_from_slice(&1_000_000u64.to_le_bytes()); // lamports
        hdr[80..88].copy_from_slice(&(data.len() as u64).to_le_bytes());
        if !data.is_empty() {
            hdr[88..88 + data.len()].copy_from_slice(data);
        }
        Self { backing }
    }

    pub unsafe fn view(&mut self) -> AccountView {
        let ptr = (self.backing.as_mut_ptr() as *mut u8).add(BACKING_OFFSET);
        AccountView::new_unchecked(ptr as *mut RuntimeAccount)
    }

    /// Read the data region back as `T`. Guaranteed 16-byte aligned.
    pub unsafe fn read_data_as<T>(&self) -> T {
        let ptr = (self.backing.as_ptr() as *const u8).add(BACKING_OFFSET + ACCOUNT_HEADER);
        core::ptr::read(ptr as *const T)
    }
}

// ── Convenience builders ──────────────────────────────────────────────────────

#[allow(dead_code)]
pub fn pool_bytes(pool: &LendingPool) -> Vec<u8> {
    unsafe {
        core::slice::from_raw_parts(
            pool as *const LendingPool as *const u8,
            LendingPool::SIZE,
        )
        .to_vec()
    }
}

pub fn make_pool(authority: [u8; 32], accumulated_fees: u64) -> LendingPool {
    let mut pool: LendingPool = unsafe { core::mem::zeroed() };
    pool.discriminator = LendingPool::DISCRIMINATOR;
    pool.authority = Address::new_from_array(authority);
    pool.borrow_index = WAD;
    pool.supply_index = WAD;
    pool.accumulated_fees = accumulated_fees;
    pool
}
