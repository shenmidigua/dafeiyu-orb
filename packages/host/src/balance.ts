/**
 * The account balance the ball's `poor` frame is decided by.
 *
 * The number lives in the signed-in DeepSeek account, not in this plugin: the host reaches it through
 * the `deepseekAccount` service, which proxies the Platform web API and returns the wallets it got —
 * the topped-up wallet in `value` and the granted one in `bonusWallets`, each a decimal string with a
 * currency. Both are spendable, so both are counted; that is the reading the ball's owner asked for.
 *
 * Everything here is defensive, because every failure mode is normal rather than exceptional: the
 * service may not be mounted, nobody may be signed in, the Platform may be unreachable, a build may
 * carry no client version. None of those is a zero balance — the ball keeps its ordinary resting loop
 * when the number is unknown, and this module returns `null` for exactly that.
 */

/** What the account Remote methods carry as the identity of the calling UI. */
export interface AccountClientMetadata {
  readonly version: string
  readonly locale: string
  readonly timezoneOffsetSeconds: number
}

/** One wallet as the Platform reports it: an amount as a decimal string, and its currency. */
interface AccountWallet {
  readonly currency?: unknown
  readonly balance?: unknown
}

/** The slice of the balance outcome this plugin reads. */
interface BalanceOutcome {
  readonly status?: unknown
  readonly value?: unknown
  readonly bonusWallets?: unknown
}

/** The slice of the account service this plugin uses. */
export interface AccountService {
  getBalance?(client: AccountClientMetadata): Promise<unknown>
}

/** The decimal grammar Platform's own client accepts, and nothing else. */
const DECIMAL = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i

/** What the ball is told: the spendable balance in CNY, or `null` when it is not known. */
export interface BalanceReport {
  readonly cny: number | null
  /** When this reading was taken, so a stale number is visible as stale rather than as the truth. */
  readonly at: number
}

/**
 * The account client metadata for one call.
 *
 * `version` is the build's own `DSH_CLIENT_VERSION`, which the desktop launcher puts in the host's
 * environment. It is passed through even when it is empty rather than invented: the header is the
 * Platform's record of which build asked, and a made-up value would be a wrong record.
 */
export function accountClientMetadata(locale: string | undefined, now = new Date()): AccountClientMetadata {
  return {
    version: process.env.DSH_CLIENT_VERSION ?? '',
    locale: normalizeLocale(locale),
    timezoneOffsetSeconds: -now.getTimezoneOffset() * 60,
  }
}

/** The region-tagged locale Platform expects: anything Chinese as `zh-CN`, everything else `en-US`. */
function normalizeLocale(locale: string | undefined): string {
  return typeof locale === 'string' && locale.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US'
}

/** Sum the wallets of one list, in CNY. Anything unreadable or in another currency is skipped. */
function sumCny(wallets: unknown): number {
  if (!Array.isArray(wallets)) return 0
  let total = 0
  for (const entry of wallets as AccountWallet[]) {
    if (typeof entry !== 'object' || entry === null) continue
    if (entry.currency !== 'CNY') continue
    const text = typeof entry.balance === 'string' ? entry.balance.trim() : ''
    if (!DECIMAL.test(text)) continue
    const amount = Number(text)
    if (Number.isFinite(amount)) total += amount
  }
  return total
}

/**
 * Read the spendable balance, in CNY.
 *
 * `null` means "not known", and it covers every way this can fail: no service, no method, nothing
 * signed in (the service answers `null` for that), a `failed` outcome, a malformed payload, or a
 * thrown error. A zero is only ever returned when the account really reports no CNY money.
 */
export async function readBalance(
  account: AccountService | undefined,
  client: AccountClientMetadata,
): Promise<number | null> {
  if (typeof account?.getBalance !== 'function') return null
  let outcome: unknown
  try {
    outcome = await account.getBalance(client)
  } catch (error) {
    console.error(`dsh-orb: balance read failed: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
  if (typeof outcome !== 'object' || outcome === null) return null
  const balance = outcome as BalanceOutcome
  if (balance.status !== 'ready') return null
  // Only a payload that really carried a list is a reading: `value: undefined` with `status: 'ready'`
  // would otherwise sum to zero and paint an empty wallet the account never reported.
  if (!Array.isArray(balance.value) && !Array.isArray(balance.bonusWallets)) return null
  return sumCny(balance.value) + sumCny(balance.bonusWallets)
}
