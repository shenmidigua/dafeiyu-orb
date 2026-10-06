import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { accountClientMetadata, readBalance, type AccountService } from '../src/balance.ts'

/** An account service that answers with one fixed value, or throws. */
function account(value: unknown, throws = false): AccountService {
  return {
    getBalance: async () => {
      if (throws) throw new Error('platform is unreachable')
      return value
    },
  }
}

describe('the account balance the poor face is decided by', () => {
  it('adds the topped-up wallet and the granted one, in CNY', async () => {
    const outcome = {
      status: 'ready',
      value: [{ currency: 'CNY', balance: '41.30' }],
      bonusWallets: [{ currency: 'CNY', balance: '12.70' }],
    }
    assert.equal(await readBalance(account(outcome), accountClientMetadata('zh-CN')), 54)
  })

  it('counts one without the other, and reports a real zero as zero', async () => {
    assert.equal(await readBalance(
      account({ status: 'ready', value: [{ currency: 'CNY', balance: '88' }] }),
      accountClientMetadata('en-US'),
    ), 88)
    assert.equal(await readBalance(
      account({ status: 'ready', value: [], bonusWallets: [{ currency: 'CNY', balance: '0.00' }] }),
      accountClientMetadata('en-US'),
    ), 0)
  })

  it('leaves another currency out rather than adding it to yuan', async () => {
    // The platform reports one wallet per currency and the ball's line is in yuan. Converting is
    // nobody's job here, and counting dollars as yuan would move the line by the exchange rate.
    const outcome = {
      status: 'ready',
      value: [{ currency: 'CNY', balance: '30' }, { currency: 'USD', balance: '99' }],
      bonusWallets: [{ currency: 'USD', balance: '5' }],
    }
    assert.equal(await readBalance(account(outcome), accountClientMetadata('zh-CN')), 30)
  })

  it('ignores amounts that are not decimal strings', async () => {
    const outcome = {
      status: 'ready',
      value: [{ currency: 'CNY', balance: '1e1' }, { currency: 'CNY', balance: '2.5' }],
      bonusWallets: [{ currency: 'CNY', balance: '  ' }, { currency: 'CNY', balance: 42 }],
    }
    // `1e1` is in the grammar the platform's own client accepts; `42` as a number is not.
    assert.equal(await readBalance(account(outcome), accountClientMetadata('zh-CN')), 12.5)
  })

  it('answers "not known" for every way the read can fail', async () => {
    const client = accountClientMetadata('zh-CN')
    const failures: readonly (AccountService | undefined)[] = [
      undefined,
      {},
      account(null),
      account({ status: 'failed' }),
      account({ status: 'ready' }),
      account({ status: 'ready', value: 'not a list' }),
      account({}, true),
    ]
    for (const service of failures) {
      assert.equal(await readBalance(service, client), null, JSON.stringify(service))
    }
  })

  it('writes the client metadata Platform expects', () => {
    const metadata = accountClientMetadata('zh_TW', new Date('2026-01-02T03:04:05Z'))
    assert.equal(metadata.locale, 'zh-CN')
    assert.equal(accountClientMetadata('en-GB').locale, 'en-US')
    assert.equal(accountClientMetadata(undefined).locale, 'en-US')
    // East of UTC is positive, which is the inverse of what the platform's own browser client sends.
    assert.equal(metadata.timezoneOffsetSeconds, -new Date('2026-01-02T03:04:05Z').getTimezoneOffset() * 60)
    assert.equal(typeof metadata.version, 'string')
  })
})
