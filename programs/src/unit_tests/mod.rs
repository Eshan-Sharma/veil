//! Unit tests for the Veil lending program — exercise `pub(crate)` helpers
//! that the external `tests/` integration suite cannot reach.
//!
//! Each submodule mirrors a source module under `crate::`. Integration tests
//! that drive the entrypoint or full scenarios live in the top-level `tests/`
//! directory instead.

mod math;

mod state_lending_pool;
mod state_user_position;
mod state_ika_position;

mod ika;

mod instructions_deposit;
mod instructions_withdraw;
mod instructions_borrow;
mod instructions_liquidate;
mod instructions_collect_fees;
mod instructions_cross_borrow;
mod instructions_cross_repay;
mod instructions_cross_withdraw;
mod instructions_cross_liquidate;
