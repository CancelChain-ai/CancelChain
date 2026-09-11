import { buildGrantTransaction, findGrantedAllowance, toBlockhash } from '@cancelchain/chain'
import {
  createMerchantSim,
  loadMerchantSigner,
  merchantSimConfigFromEnv,
} from '@cancelchain/merchant-sim'
import type {
  Instruction,
  Signature,
  TransactionMessageWithBlockhashLifetime,
  TransactionMessageWithFeePayerSigner,
  TransactionSigner,
} from '@solana/kit'
import {
  appendTransactionMessageInstruction,
  type compileTransaction,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransaction,
  signTransactionMessageWithSigners,
} from '@solana/kit'
import { getCreateAccountInstruction } from '@solana-program/system'
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getInitializeMintInstruction,
  getMintSize,
  getMintToInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token'

/**
 * Посів сценарію для `T028` — свій мін, свої токени, свій дозвіл.
 *
 * Потрібен саме як інструмент, а не як разовий скрипт: **кожен прогін `T028`
 * знищує дозвіл** (`SC-001` міряється на закритому акаунті), тож повторний
 * вимір щоразу вимагає нового посіву.
 *
 * Мін тут наш власний, і це не обхідний шлях, а прибирання зайвої залежності:
 * devnet-крани чужих токенів то працюють, то ні, а від активу у вимірі не
 * залежить нічого — програма однаково перевіряє стелю й закритий акаунт. Що
 * роль мерчанта грає `merchant-sim`, а актив вигаданий, називається вголос при
 * кожному показі — межа мока і справжнього проходить саме тут.
 */

/** Як у USDC — щоб числа на екрані читалися звично. */
const DECIMALS = 6
const ONE_TOKEN = 10n ** BigInt(DECIMALS)

/** Токенів власнику: свідомо багато, щоб відмова ніколи не була «немає коштів». */
const MINT_TO_OWNER = 1_000n * ONE_TOKEN

/** Стеля на період. */
const CAP_PER_PERIOD = 25n * ONE_TOKEN

/**
 * Тридцять діб. Не година й не хвилина: прогін `SC-004` триває десятки хвилин,
 * а на межі періоду `spentInPeriod` скидається — і сума, порахована як «на
 * одиницю понад залишок», раптом стала б дозволеною. Довгий період прибирає
 * цей збіг, а не маскує його.
 */
const PERIOD_SECONDS = 2_592_000

/** Рік. Дозвіл не має протермінуватися посеред виміру. */
const EXPIRES_IN_MS = 365 * 24 * 60 * 60 * 1000

type Rpc = Awaited<ReturnType<typeof createMerchantSim>>['chain']['rpc']

/**
 * Повідомлення з підписантом-платником. Тип названий явно, бо накопичувач
 * `reduce` інакше звужується першою ж інструкцією й перестає бути повідомленням.
 */
type SeedMessage = Parameters<typeof compileTransaction>[0] &
  TransactionMessageWithBlockhashLifetime &
  TransactionMessageWithFeePayerSigner

async function confirm(rpc: Rpc, signature: Signature, label: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    const { value } = await rpc.getSignatureStatuses([signature]).send()
    const status = value[0]
    if (status === null || status === undefined) continue
    if (status.err !== null) {
      throw new Error(`${label} failed on chain: ${JSON.stringify(status.err)} (${signature})`)
    }
    process.stdout.write(`${label.padEnd(28)} ${signature}\n`)
    return
  }
  throw new Error(`${label} was sent but never confirmed (${signature})`)
}

async function sendWithSigners(
  rpc: Rpc,
  payer: TransactionSigner,
  instructions: readonly Instruction[],
  label: string,
): Promise<void> {
  const { value } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()
  const message = instructions.reduce<SeedMessage>(
    (carry, instruction) => appendTransactionMessageInstruction(instruction, carry),
    pipe(
      createTransactionMessage({ version: 0 }),
      (draft) => setTransactionMessageFeePayerSigner(payer, draft),
      (draft) =>
        setTransactionMessageLifetimeUsingBlockhash(
          {
            blockhash: toBlockhash(value.blockhash),
            lastValidBlockHeight: value.lastValidBlockHeight,
          },
          draft,
        ),
    ),
  )
  const signed = await signTransactionMessageWithSigners(message)
  const signature = getSignatureFromTransaction(signed)
  await rpc
    .sendTransaction(getBase64EncodedWireTransaction(signed), {
      encoding: 'base64',
      preflightCommitment: 'confirmed',
    })
    .send()
  await confirm(rpc, signature, label)
}

async function main(): Promise<void> {
  const ownerKeypairPath = process.env.E2E_OWNER_KEYPAIR_PATH
  if (ownerKeypairPath === undefined || ownerKeypairPath === '') {
    throw new Error('E2E_OWNER_KEYPAIR_PATH is not set: the allowance is granted by its owner')
  }
  // Той самий конфіг, що й у merchant-sim: mainnet заборонений тричі.
  const merchant = await createMerchantSim(merchantSimConfigFromEnv(process.env))
  const owner = await loadMerchantSigner(ownerKeypairPath)
  const { rpc } = merchant.chain

  process.stdout.write(
    `cluster:      ${merchant.cluster}\nmerchant:     ${merchant.address}\nowner:        ${owner.address}\n\n`,
  )

  // 1. Власний мін. Ключ міну одноразовий і нікуди не зберігається: після
  //    створення він більше не потрібен, а mint authority — мерчант.
  const mint = await generateKeyPairSigner()
  const rent = await rpc.getMinimumBalanceForRentExemption(BigInt(getMintSize())).send()
  await sendWithSigners(
    rpc,
    merchant.signer,
    [
      getCreateAccountInstruction({
        lamports: rent,
        newAccount: mint,
        payer: merchant.signer,
        programAddress: TOKEN_PROGRAM_ADDRESS,
        space: BigInt(getMintSize()),
      }),
      getInitializeMintInstruction({
        decimals: DECIMALS,
        mint: mint.address,
        mintAuthority: merchant.address,
      }),
    ],
    'mint created',
  )

  // 2. Токен-акаунти обох сторін. Ідемпотентні: повторний посів не падає.
  const [ownerAta] = await findAssociatedTokenPda({
    mint: mint.address,
    owner: owner.address,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  })
  await sendWithSigners(
    rpc,
    merchant.signer,
    await Promise.all(
      [owner.address, merchant.address].map((wallet) =>
        getCreateAssociatedTokenIdempotentInstructionAsync({
          mint: mint.address,
          owner: wallet,
          payer: merchant.signer,
        }),
      ),
    ),
    'token accounts ready',
  )

  // 3. Токени власнику — щоб відмова у списанні ніколи не була «немає коштів».
  await sendWithSigners(
    rpc,
    merchant.signer,
    [
      getMintToInstruction({
        amount: MINT_TO_OWNER,
        mint: mint.address,
        mintAuthority: merchant.signer,
        token: ownerAta,
      }),
    ],
    'tokens minted',
  )

  /*
   * 4. Авторитет підписок і сам дозвіл — однією транзакцією. `nonce` береться з
   *    годинника: повторний посів має дати **новий** дозвіл, а не впертися в
   *    `DelegationAlreadyExists` на тій самій адресі.
   */
  const nonce = BigInt(Date.now())
  const { value: lifetime } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()
  const grant = await buildGrantTransaction({
    authorityInitId: 'same-transaction',
    bounds: {
      capAmount: CAP_PER_PERIOD,
      delegatee: merchant.address,
      expiresAt: new Date(Date.now() + EXPIRES_IN_MS).toISOString(),
      kind: 'recurring',
      periodSeconds: PERIOD_SECONDS,
      startsAt: null,
    },
    delegator: owner,
    initAuthority: { tokenProgram: TOKEN_PROGRAM_ADDRESS, userAta: ownerAta },
    lifetime: {
      blockhash: toBlockhash(lifetime.blockhash),
      lastValidBlockHeight: lifetime.lastValidBlockHeight,
    },
    nonce,
    tokenMint: mint.address,
  })
  const signedGrant = await signTransaction([owner.keyPair], grant.transaction)
  const grantSignature = getSignatureFromTransaction(signedGrant)
  await rpc
    .sendTransaction(getBase64EncodedWireTransaction(signedGrant), {
      encoding: 'base64',
      preflightCommitment: 'confirmed',
    })
    .send()
  await confirm(rpc, grantSignature, 'allowance granted')

  const allowance = await findGrantedAllowance({
    delegatee: merchant.address,
    delegator: owner.address,
    nonce,
    tokenMint: mint.address,
  })

  process.stdout.write(
    [
      '',
      'Seeded. Run T028 with:',
      `  USDC_MINT=${mint.address}`,
      `  E2E_ALLOWANCE_PDA=${allowance.address}`,
      `  E2E_CHARGE_AMOUNT=${ONE_TOKEN}`,
      '',
      `cap per period:  ${CAP_PER_PERIOD} (${CAP_PER_PERIOD / ONE_TOKEN} tokens)`,
      `owner balance:   ${MINT_TO_OWNER / ONE_TOKEN} tokens`,
      `period:          ${PERIOD_SECONDS}s`,
      `nonce:           ${nonce}`,
      '',
    ].join('\n'),
  )
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
})
