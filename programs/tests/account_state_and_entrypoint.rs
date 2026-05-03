use pinocchio::{account::RuntimeAccount, error::ProgramError, AccountView, Address};
use veil_lending::{
    entrypoint::process_instruction,
    errors::LendError,
    fhe::{
        self,
        context::{EncryptContext, CPI_AUTHORITY_SEED, ENCRYPT_PROGRAM_ID_BYTES},
        types::{EBool, EUint64},
    },
    ika,
    state::{ika_position, EncryptedPosition, IkaDwalletPosition, UserPosition},
};

const PROGRAM: Address = Address::new_from_array([9u8; 32]);
const OWNER: [u8; 32] = [1u8; 32];
const POOL: [u8; 32] = [2u8; 32];
const DWALLET: [u8; 32] = [3u8; 32];
const ACCOUNT_HEADER: usize = 88;
const BACKING_OFFSET: usize = 8;

struct RawAccount {
    backing: Vec<u128>,
}

impl RawAccount {
    fn new(key: [u8; 32], is_signer: bool, is_writable: bool, data: &[u8]) -> Self {
        let total_bytes = BACKING_OFFSET + ACCOUNT_HEADER + data.len();
        let words = total_bytes.div_ceil(16);
        let mut backing = vec![0u128; words];

        let bytes = unsafe {
            core::slice::from_raw_parts_mut(backing.as_mut_ptr() as *mut u8, total_bytes)
        };
        let hdr = &mut bytes[BACKING_OFFSET..];
        hdr[0] = 0xFF;
        hdr[1] = u8::from(is_signer);
        hdr[2] = u8::from(is_writable);
        hdr[8..40].copy_from_slice(&key);
        hdr[72..80].copy_from_slice(&1_000_000u64.to_le_bytes());
        hdr[80..88].copy_from_slice(&(data.len() as u64).to_le_bytes());
        if !data.is_empty() {
            hdr[88..88 + data.len()].copy_from_slice(data);
        }

        Self { backing }
    }

    unsafe fn view(&mut self) -> AccountView {
        let ptr = unsafe { (self.backing.as_mut_ptr() as *mut u8).add(BACKING_OFFSET) };
        unsafe { AccountView::new_unchecked(ptr as *mut RuntimeAccount) }
    }

    unsafe fn read_data_as<T>(&self) -> T {
        let ptr = unsafe { (self.backing.as_ptr() as *const u8).add(BACKING_OFFSET + ACCOUNT_HEADER) };
        unsafe { core::ptr::read(ptr as *const T) }
    }
}

fn update_pool_data() -> Vec<u8> {
    let mut data = vec![0u8; 168];
    data[160..168].copy_from_slice(&9u64.to_le_bytes());
    data
}

fn ika_register_data() -> Vec<u8> {
    let mut data = Vec::with_capacity(14);
    data.extend_from_slice(&1_000u64.to_le_bytes());
    data.extend_from_slice(&ika_position::curve::SECP256K1.to_le_bytes());
    data.extend_from_slice(&ika_position::scheme::ECDSA_SHA256.to_le_bytes());
    data.push(7);
    data.push(8);
    data
}

fn ika_sign_data() -> Vec<u8> {
    let mut data = vec![0u8; 100];
    data[96..98].copy_from_slice(&ika_position::scheme::ECDSA_SHA256.to_le_bytes());
    data[98] = 11;
    data[99] = 12;
    data
}

#[test]
fn entrypoint_rejects_empty_and_unknown_instruction_data() {
    let empty = process_instruction(&PROGRAM, &mut [], &[]);
    assert_eq!(empty, Err(ProgramError::InvalidInstructionData));

    let unknown = process_instruction(&PROGRAM, &mut [], &[0xff]);
    assert_eq!(unknown, Err(ProgramError::InvalidInstructionData));
}

#[test]
fn entrypoint_dispatches_each_known_discriminator_to_its_handler() {
    let cases: [(u8, Vec<u8>); 21] = [
        (0, vec![1, 2, 3]),
        (1, [500u64.to_le_bytes().as_slice(), &[4]].concat()),
        (2, 600u64.to_le_bytes().to_vec()),
        (3, 700u64.to_le_bytes().to_vec()),
        (4, 800u64.to_le_bytes().to_vec()),
        (5, vec![]),
        (6, 900u64.to_le_bytes().to_vec()),
        (7, vec![]),
        (8, vec![5, 6]),
        (9, [1_000u64.to_le_bytes().as_slice(), &[7]].concat()),
        (10, [1_100u64.to_le_bytes().as_slice(), &[8]].concat()),
        (11, [1_200u64.to_le_bytes().as_slice(), &[9]].concat()),
        (12, [1_300u64.to_le_bytes().as_slice(), &[10]].concat()),
        (13, update_pool_data()),
        (14, vec![]),
        (15, vec![]),
        (16, vec![]),
        (17, ika_register_data()),
        (18, vec![13]),
        (19, ika_sign_data()),
        (20, vec![]),
    ];

    for (discriminator, body) in cases {
        let mut data = vec![discriminator];
        data.extend_from_slice(&body);
        let result = process_instruction(&PROGRAM, &mut [], &data);
        assert_eq!(
            result,
            Err(LendError::InvalidInstructionData.into()),
            "discriminator {} did not route to the expected handler",
            discriminator
        );
    }
}

#[test]
fn user_position_account_init_and_binding_checks_work() {
    let owner = Address::new_from_array(OWNER);
    let pool = Address::new_from_array(POOL);
    let mut account = RawAccount::new([21u8; 32], false, true, &[0xff; UserPosition::SIZE]);

    let view = unsafe { account.view() };
    UserPosition::init(&view, &owner, &pool, 7, 123, 456).unwrap();

    let position = UserPosition::from_account(&view).unwrap();
    assert_eq!(position.owner, owner);
    assert_eq!(position.pool, pool);
    assert_eq!(position.bump, 7);
    assert_eq!(position.deposit_index_snapshot, 123);
    assert_eq!(position.borrow_index_snapshot, 456);
    assert_eq!(position.verify_binding(&owner, &pool), Ok(()));
    assert_eq!(
        position.verify_binding(&Address::new_from_array([99u8; 32]), &pool),
        Err(LendError::Unauthorized.into())
    );
    assert_eq!(
        position.verify_binding(&owner, &Address::new_from_array([98u8; 32])),
        Err(ProgramError::InvalidAccountData)
    );

    let position_mut = UserPosition::from_account_mut(&view).unwrap();
    position_mut.deposit_shares = 42;
    position_mut.borrow_principal = 24;
    let stored = unsafe { account.read_data_as::<UserPosition>() };
    assert_eq!(stored.deposit_shares, 42);
    assert_eq!(stored.borrow_principal, 24);
}

#[test]
fn user_position_rejects_short_and_bad_discriminator_accounts() {
    let mut short = RawAccount::new([22u8; 32], false, true, &[0u8; UserPosition::SIZE - 1]);
    let short_view = unsafe { short.view() };
    assert_eq!(
        UserPosition::from_account(&short_view).err().unwrap(),
        ProgramError::InvalidAccountData
    );

    let mut wrong_disc = RawAccount::new([23u8; 32], false, true, &[0u8; UserPosition::SIZE]);
    let wrong_view = unsafe { wrong_disc.view() };
    assert_eq!(
        UserPosition::from_account(&wrong_view).err().unwrap(),
        ProgramError::InvalidAccountData
    );
}

#[test]
fn user_position_init_rejects_short_account() {
    let owner = Address::new_from_array(OWNER);
    let pool = Address::new_from_array(POOL);
    let mut short = RawAccount::new([20u8; 32], false, true, &[0u8; UserPosition::SIZE - 1]);
    let short_view = unsafe { short.view() };
    assert_eq!(
        UserPosition::init(&short_view, &owner, &pool, 1, 2, 3),
        Err(ProgramError::InvalidAccountData)
    );
}

#[test]
fn encrypted_position_account_init_and_ciphertext_verification_work() {
    let owner = Address::new_from_array(OWNER);
    let pool = Address::new_from_array(POOL);
    let enc_deposit = [31u8; 32];
    let enc_debt = [32u8; 32];
    let mut account =
        RawAccount::new([24u8; 32], false, true, &[0xa5; EncryptedPosition::SIZE]);

    let view = unsafe { account.view() };
    EncryptedPosition::init(&view, &owner, &pool, enc_deposit, enc_debt, 9).unwrap();

    let position = EncryptedPosition::from_account(&view).unwrap();
    assert_eq!(position.owner, owner);
    assert_eq!(position.pool, pool);
    assert_eq!(position.enc_deposit, enc_deposit);
    assert_eq!(position.enc_debt, enc_debt);
    assert_eq!(position.verify_binding(&owner, &pool), Ok(()));

    let mut deposit_ct = RawAccount::new(enc_deposit, false, true, &[]);
    let mut debt_ct = RawAccount::new(enc_debt, false, true, &[]);
    let mut wrong_ct = RawAccount::new([33u8; 32], false, true, &[]);
    let deposit_view = unsafe { deposit_ct.view() };
    let debt_view = unsafe { debt_ct.view() };
    let wrong_view = unsafe { wrong_ct.view() };

    assert_eq!(position.verify_deposit_ct(&deposit_view), Ok(()));
    assert_eq!(position.verify_debt_ct(&debt_view), Ok(()));
    assert_eq!(
        position.verify_deposit_ct(&wrong_view),
        Err(ProgramError::InvalidArgument)
    );
    assert_eq!(
        position.verify_debt_ct(&wrong_view),
        Err(ProgramError::InvalidArgument)
    );
}

#[test]
fn encrypted_position_rejects_short_and_bad_discriminator_accounts() {
    let mut short =
        RawAccount::new([25u8; 32], false, true, &[0u8; EncryptedPosition::SIZE - 1]);
    let short_view = unsafe { short.view() };
    assert_eq!(
        EncryptedPosition::from_account(&short_view).err().unwrap(),
        ProgramError::InvalidAccountData
    );

    let mut wrong_disc =
        RawAccount::new([26u8; 32], false, true, &[0u8; EncryptedPosition::SIZE]);
    let wrong_view = unsafe { wrong_disc.view() };
    assert_eq!(
        EncryptedPosition::from_account(&wrong_view).err().unwrap(),
        ProgramError::InvalidAccountData
    );
}

#[test]
fn encrypted_position_init_rejects_short_account_and_wrong_binding() {
    let owner = Address::new_from_array(OWNER);
    let pool = Address::new_from_array(POOL);
    let mut short =
        RawAccount::new([30u8; 32], false, true, &[0u8; EncryptedPosition::SIZE - 1]);
    let short_view = unsafe { short.view() };
    assert_eq!(
        EncryptedPosition::init(&short_view, &owner, &pool, [1u8; 32], [2u8; 32], 1),
        Err(ProgramError::InvalidAccountData)
    );

    let mut account = RawAccount::new([31u8; 32], false, true, &[0u8; EncryptedPosition::SIZE]);
    let view = unsafe { account.view() };
    EncryptedPosition::init(&view, &owner, &pool, [3u8; 32], [4u8; 32], 2).unwrap();
    let position = EncryptedPosition::from_account_mut(&view).unwrap();
    position.bump = 9;
    assert_eq!(
        position.verify_binding(&Address::new_from_array([8u8; 32]), &pool),
        Err(LendError::Unauthorized.into())
    );
    assert_eq!(
        position.verify_binding(&owner, &Address::new_from_array([9u8; 32])),
        Err(ProgramError::InvalidAccountData)
    );
}

#[test]
fn ika_dwallet_position_account_init_sets_expected_fields() {
    let owner = Address::new_from_array(OWNER);
    let pool = Address::new_from_array(POOL);
    let dwallet = Address::new_from_array(DWALLET);
    let mut account =
        RawAccount::new([27u8; 32], false, true, &[0x5a; IkaDwalletPosition::SIZE]);

    let view = unsafe { account.view() };
    IkaDwalletPosition::init(
        &view,
        &owner,
        &pool,
        &dwallet,
        55_000,
        ika_position::curve::SECP256K1,
        ika_position::scheme::ECDSA_SHA256,
        4,
    )
    .unwrap();

    let position = IkaDwalletPosition::from_account(&view).unwrap();
    assert_eq!(position.owner, owner);
    assert_eq!(position.pool, pool);
    assert_eq!(position.dwallet, dwallet);
    assert_eq!(position.usd_value, 55_000);
    assert_eq!(position.curve, ika_position::curve::SECP256K1);
    assert_eq!(position.signature_scheme, ika_position::scheme::ECDSA_SHA256);
    assert_eq!(position.status, ika_position::status::ACTIVE);
    assert_eq!(position.bump, 4);

    let position_mut = IkaDwalletPosition::from_account_mut(&view).unwrap();
    position_mut.status = ika_position::status::RELEASED;
    let stored = unsafe { account.read_data_as::<IkaDwalletPosition>() };
    assert_eq!(stored.status, ika_position::status::RELEASED);
}

#[test]
fn ika_dwallet_position_rejects_short_and_bad_discriminator_accounts() {
    let mut short =
        RawAccount::new([28u8; 32], false, true, &[0u8; IkaDwalletPosition::SIZE - 1]);
    let short_view = unsafe { short.view() };
    assert_eq!(
        IkaDwalletPosition::from_account(&short_view).err().unwrap(),
        ProgramError::InvalidAccountData
    );

    let mut wrong_disc =
        RawAccount::new([29u8; 32], false, true, &[0u8; IkaDwalletPosition::SIZE]);
    let wrong_view = unsafe { wrong_disc.view() };
    assert_eq!(
        IkaDwalletPosition::from_account(&wrong_view).err().unwrap(),
        ProgramError::InvalidAccountData
    );
}

#[test]
fn ika_dwallet_position_init_rejects_short_account() {
    let owner = Address::new_from_array(OWNER);
    let pool = Address::new_from_array(POOL);
    let dwallet = Address::new_from_array(DWALLET);
    let mut short =
        RawAccount::new([40u8; 32], false, true, &[0u8; IkaDwalletPosition::SIZE - 1]);
    let short_view = unsafe { short.view() };
    assert_eq!(
        IkaDwalletPosition::init(
            &short_view,
            &owner,
            &pool,
            &dwallet,
            10,
            ika_position::curve::SECP256K1,
            ika_position::scheme::ECDSA_SHA256,
            1,
        ),
        Err(ProgramError::InvalidAccountData)
    );
}

#[test]
fn fhe_handle_helpers_and_constants_match_expected_values() {
    let key = [41u8; 32];
    let uint = EUint64::from_pubkey(key);
    let boolean = EBool::from_pubkey(key);

    assert_eq!(uint.id(), &key);
    assert!(!uint.is_zero());
    assert!(EUint64::zero().is_zero());
    assert_eq!(boolean.id(), &key);
    assert_eq!(EBool::zero().id(), &[0u8; 32]);

    assert_eq!(fhe::BPS_DENOM, 10_000);
    assert_eq!(fhe::LIQ_THRESHOLD_BPS, 8_000);
    assert_eq!(fhe::LTV_BPS, 7_500);
    assert_eq!(CPI_AUTHORITY_SEED, b"__encrypt_cpi_authority");
    assert_eq!(ENCRYPT_PROGRAM_ID_BYTES.len(), 32);
}

#[test]
fn ika_manual_cpi_builders_return_ok_on_host() {
    let mut ika_program = RawAccount::new([70u8; 32], false, false, &[]);
    let mut message_approval = RawAccount::new([72u8; 32], false, true, &[]);
    let mut dwallet = RawAccount::new([73u8; 32], false, true, &[]);
    let mut caller_program = RawAccount::new([74u8; 32], false, false, &[]);
    let mut cpi_authority = RawAccount::new([75u8; 32], false, false, &[]);
    let mut payer = RawAccount::new([76u8; 32], true, true, &[]);
    let mut system_program = RawAccount::new([77u8; 32], false, false, &[]);
    let mut partial_sig = RawAccount::new([78u8; 32], false, true, &[]);

    let ika_program_view = unsafe { ika_program.view() };
    let message_approval_view = unsafe { message_approval.view() };
    let dwallet_view = unsafe { dwallet.view() };
    let caller_program_view = unsafe { caller_program.view() };
    let cpi_authority_view = unsafe { cpi_authority.view() };
    let payer_view = unsafe { payer.view() };
    let system_program_view = unsafe { system_program.view() };
    let partial_sig_view = unsafe { partial_sig.view() };

    assert_eq!(
        ika::approve_message(
            &ika_program_view,
            &message_approval_view,
            &dwallet_view,
            &caller_program_view,
            &cpi_authority_view,
            &payer_view,
            &system_program_view,
            &[1u8; 32],
            &[3u8; 32],
            ika_position::scheme::ECDSA_SHA256 as u8,
            4,
            5,
        ),
        Ok(())
    );

    assert_eq!(
        ika::transfer_dwallet(
            &ika_program_view,
            &caller_program_view,
            &cpi_authority_view,
            &dwallet_view,
            &Address::new_from_array([88u8; 32]),
            6,
        ),
        Ok(())
    );

    assert_eq!(
        ika::transfer_future_sign(
            &ika_program_view,
            &caller_program_view,
            &cpi_authority_view,
            &partial_sig_view,
            &Address::new_from_array([89u8; 32]),
            7,
        ),
        Ok(())
    );
}

#[test]
fn fhe_context_constructs_with_expected_shape() {
    // The Encrypt CPI is real now (vendored `encrypt-pinocchio`), so calling
    // `add_deposit` / `sub_deposit` / `is_healthy` etc. would invoke
    // `invoke_signed_with_bounds` and panic on host runtime where there is
    // no Solana validator. This test therefore covers only what's safe to
    // assert without firing a CPI: the struct can be built from the right
    // account slots in the right positions, and reads its own fields back.
    //
    // Real per-method behaviour is exercised by:
    //   - `programs/tests/scenarios.rs` (pure-state path, no CPI)
    //   - `veil-landing/scripts/e2e-cross-encrypt.ts` (live localnet)
    let mut encrypt_program = RawAccount::new([51u8; 32], false, false, &[]);
    let mut config = RawAccount::new([52u8; 32], false, false, &[]);
    let mut deposit = RawAccount::new([53u8; 32], false, true, &[]);
    let mut cpi_authority = RawAccount::new([54u8; 32], false, false, &[]);
    let mut caller_program = RawAccount::new([55u8; 32], false, false, &[]);
    let mut network_key = RawAccount::new([56u8; 32], false, false, &[]);
    let mut payer = RawAccount::new([57u8; 32], true, true, &[]);
    let mut event_authority = RawAccount::new([58u8; 32], false, false, &[]);
    let mut system_program = RawAccount::new([59u8; 32], false, false, &[]);

    let encrypt_program_view = unsafe { encrypt_program.view() };
    let config_view = unsafe { config.view() };
    let deposit_view = unsafe { deposit.view() };
    let cpi_authority_view = unsafe { cpi_authority.view() };
    let caller_program_view = unsafe { caller_program.view() };
    let network_key_view = unsafe { network_key.view() };
    let payer_view = unsafe { payer.view() };
    let event_authority_view = unsafe { event_authority.view() };
    let system_program_view = unsafe { system_program.view() };

    let ctx = EncryptContext {
        encrypt_program: &encrypt_program_view,
        config: &config_view,
        deposit: &deposit_view,
        cpi_authority: &cpi_authority_view,
        caller_program: &caller_program_view,
        network_encryption_key: &network_key_view,
        payer: &payer_view,
        event_authority: &event_authority_view,
        system_program: &system_program_view,
        cpi_authority_bump: 7,
    };

    assert_eq!(ctx.cpi_authority_bump, 7);
    assert_eq!(ctx.encrypt_program.address().as_ref(), &[51u8; 32]);
    assert_eq!(ctx.config.address().as_ref(),          &[52u8; 32]);
    assert_eq!(ctx.deposit.address().as_ref(),         &[53u8; 32]);
    assert_eq!(ctx.cpi_authority.address().as_ref(),   &[54u8; 32]);
    assert_eq!(ctx.caller_program.address().as_ref(),  &[55u8; 32]);
    assert_eq!(ctx.network_encryption_key.address().as_ref(), &[56u8; 32]);
    assert_eq!(ctx.payer.address().as_ref(),           &[57u8; 32]);
    assert_eq!(ctx.event_authority.address().as_ref(), &[58u8; 32]);
    assert_eq!(ctx.system_program.address().as_ref(),  &[59u8; 32]);
}
