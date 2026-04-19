/*!
Lightweight Pyth legacy push-oracle reader.

Reads the aggregate price directly from the raw account data without pulling
in the pyth-sdk crate (which would conflict with our pinocchio version).

Legacy `PriceAccount` layout offsets used here:
  0   u32  magic  (must be 0xa1b2c3d4)
  8   u32  atype  (must be 3 = Price)
 20   i32  expo
208   i64  agg.price
216   u64  agg.conf
224   u32  agg.status  (must be 1 = Trading)
*/

use pinocchio::{account::AccountView, error::ProgramError};

use crate::errors::LendError;

const MAGIC: u32 = 0xa1b2c3d4;
const ATYPE_PRICE: u32 = 3;
const STATUS_TRADING: u32 = 1;

/// Minimum data length: we read up to agg.status at bytes [224, 228).
const MIN_LEN: usize = 228;

pub struct PythPrice {
    pub price: i64,
    pub conf:  u64,
    pub expo:  i32,
}

/// Read and validate the aggregate price from a Pyth legacy push-oracle account.
pub fn read_price(account: &AccountView) -> Result<PythPrice, ProgramError> {
    if account.data_len() < MIN_LEN {
        return Err(LendError::OracleInvalid.into());
    }

    let data = unsafe {
        core::slice::from_raw_parts(account.data_ptr(), account.data_len())
    };

    // Validate magic.
    let magic = u32::from_le_bytes(data[0..4].try_into().unwrap());
    if magic != MAGIC {
        return Err(LendError::OracleInvalid.into());
    }

    // Validate account type.
    let atype = u32::from_le_bytes(data[8..12].try_into().unwrap());
    if atype != ATYPE_PRICE {
        return Err(LendError::OracleInvalid.into());
    }

    let expo  = i32::from_le_bytes(data[20..24].try_into().unwrap());
    let price = i64::from_le_bytes(data[208..216].try_into().unwrap());
    let conf  = u64::from_le_bytes(data[216..224].try_into().unwrap());

    // Aggregate status must be Trading.
    let status = u32::from_le_bytes(data[224..228].try_into().unwrap());
    if status != STATUS_TRADING {
        return Err(LendError::OraclePriceStale.into());
    }

    if price <= 0 {
        return Err(LendError::OracleInvalid.into());
    }

    Ok(PythPrice { price, conf, expo })
}
