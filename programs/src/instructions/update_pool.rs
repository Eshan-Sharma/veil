/*!
Update risk and interest-rate parameters for an existing lending pool.
Only the pool authority may call this.

Accounts:
  [0]  authority  signer
  [1]  pool       writable

Instruction data (after discriminator 0x0D, all little-endian):
  base_rate:             u128  (16 bytes)
  optimal_utilization:   u128  (16 bytes)
  slope1:                u128  (16 bytes)
  slope2:                u128  (16 bytes)
  reserve_factor:        u128  (16 bytes)
  ltv:                   u128  (16 bytes)
  liquidation_threshold: u128  (16 bytes)
  liquidation_bonus:     u128  (16 bytes)
  protocol_liq_fee:      u128  (16 bytes)
  close_factor:          u128  (16 bytes)
  flash_fee_bps:         u64   (8 bytes)
  Total: 168 bytes
*/

use pinocchio::{account::AccountView, error::ProgramError, Address, ProgramResult};

use crate::{
    errors::LendError,
    math::WAD,
    state::LendingPool,
};

pub struct UpdatePool {
    pub base_rate: u128,
    pub optimal_utilization: u128,
    pub slope1: u128,
    pub slope2: u128,
    pub reserve_factor: u128,
    pub ltv: u128,
    pub liquidation_threshold: u128,
    pub liquidation_bonus: u128,
    pub protocol_liq_fee: u128,
    pub close_factor: u128,
    pub flash_fee_bps: u64,
}

impl UpdatePool {
    pub const DISCRIMINATOR: u8 = 13;
    const DATA_LEN: usize = 16 * 10 + 8; // 168

    pub fn from_data(data: &[u8]) -> Result<Self, ProgramError> {
        if data.len() < Self::DATA_LEN {
            return Err(LendError::InvalidInstructionData.into());
        }
        let read_u128 = |offset: usize| {
            u128::from_le_bytes(data[offset..offset + 16].try_into().unwrap())
        };
        let read_u64 = |offset: usize| {
            u64::from_le_bytes(data[offset..offset + 8].try_into().unwrap())
        };
        Ok(Self {
            base_rate:             read_u128(0),
            optimal_utilization:   read_u128(16),
            slope1:                read_u128(32),
            slope2:                read_u128(48),
            reserve_factor:        read_u128(64),
            ltv:                   read_u128(80),
            liquidation_threshold: read_u128(96),
            liquidation_bonus:     read_u128(112),
            protocol_liq_fee:      read_u128(128),
            close_factor:          read_u128(144),
            flash_fee_bps:         read_u64(160),
        })
    }

    pub fn process(self, _program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
        if accounts.len() < 2 {
            return Err(LendError::InvalidInstructionData.into());
        }
        if !accounts[0].is_signer() {
            return Err(LendError::MissingSignature.into());
        }

        // ── Validate params ───────────────────────────────────────────────
        // ltv must be strictly below liquidation_threshold (else liquidation is impossible)
        if self.ltv >= self.liquidation_threshold {
            return Err(LendError::InvalidInstructionData.into());
        }
        // liquidation_threshold must be < WAD (can't be 100%+)
        if self.liquidation_threshold >= WAD {
            return Err(LendError::InvalidInstructionData.into());
        }
        // reserve_factor and close_factor must be < WAD
        if self.reserve_factor >= WAD || self.close_factor > WAD {
            return Err(LendError::InvalidInstructionData.into());
        }
        // flash_fee_bps ≤ 10000 (100%)
        if self.flash_fee_bps > 10_000 {
            return Err(LendError::InvalidInstructionData.into());
        }

        // ── Authority check ───────────────────────────────────────────────
        let pool = LendingPool::from_account_mut(&accounts[1])?;
        if pool.authority != *accounts[0].address() {
            return Err(LendError::Unauthorized.into());
        }

        // ── Apply ─────────────────────────────────────────────────────────
        pool.base_rate             = self.base_rate;
        pool.optimal_utilization   = self.optimal_utilization;
        pool.slope1                = self.slope1;
        pool.slope2                = self.slope2;
        pool.reserve_factor        = self.reserve_factor;
        pool.ltv                   = self.ltv;
        pool.liquidation_threshold = self.liquidation_threshold;
        pool.liquidation_bonus     = self.liquidation_bonus;
        pool.protocol_liq_fee      = self.protocol_liq_fee;
        pool.close_factor          = self.close_factor;
        pool.flash_fee_bps         = self.flash_fee_bps;

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::*;

    fn make_data(
        base_rate: u128, optimal_utilization: u128, slope1: u128, slope2: u128,
        reserve_factor: u128, ltv: u128, liquidation_threshold: u128,
        liquidation_bonus: u128, protocol_liq_fee: u128, close_factor: u128,
        flash_fee_bps: u64,
    ) -> Vec<u8> {
        let mut d = Vec::with_capacity(168);
        for v in [base_rate, optimal_utilization, slope1, slope2, reserve_factor,
                  ltv, liquidation_threshold, liquidation_bonus, protocol_liq_fee, close_factor] {
            d.extend_from_slice(&v.to_le_bytes());
        }
        d.extend_from_slice(&flash_fee_bps.to_le_bytes());
        d
    }

    fn valid_data() -> Vec<u8> {
        make_data(BASE_RATE, OPTIMAL_UTIL, SLOPE1, SLOPE2, RESERVE_FACTOR,
                  LTV, LIQ_THRESHOLD, LIQ_BONUS, PROTOCOL_LIQ_FEE, CLOSE_FACTOR, 9)
    }

    #[test]
    fn from_data_parses_correctly() {
        let d = valid_data();
        let ix = UpdatePool::from_data(&d).unwrap();
        assert_eq!(ix.base_rate, BASE_RATE);
        assert_eq!(ix.ltv, LTV);
        assert_eq!(ix.liquidation_threshold, LIQ_THRESHOLD);
        assert_eq!(ix.flash_fee_bps, 9);
    }

    #[test]
    fn from_data_too_short_returns_err() {
        assert!(UpdatePool::from_data(&[0u8; 167]).is_err());
    }

    #[test]
    fn from_data_empty_returns_err() {
        assert!(UpdatePool::from_data(&[]).is_err());
    }

    #[test]
    fn discriminator_is_13() {
        assert_eq!(UpdatePool::DISCRIMINATOR, 13);
    }
}
