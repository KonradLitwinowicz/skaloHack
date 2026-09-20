import { abortedResponse, isClientGone } from '../lib/api/quoteHandler'

function request(signal?: { aborted: boolean }): Request {
  return { signal } as unknown as Request
}

describe('abandoned pricing requests', () => {
  it('recognises a caller that has hung up', () => {
    expect(isClientGone(request({ aborted: true }))).toBe(true)
  })

  it('treats a live caller, and one with no signal at all, as present', () => {
    expect(isClientGone(request({ aborted: false }))).toBe(false)
    expect(isClientGone(request(undefined))).toBe(false)
  })

  /**
   * 499 rather than 200: nobody reads this body, but answering "here is your quote" with no quote
   * would put a lie into the response contract and into anything that logs status codes.
   */
  it('answers 499 instead of pretending to have priced the basket', async () => {
    const response = abortedResponse()

    expect(response.status).toBe(499)
    await expect(response.json()).resolves.toEqual({ error: 'pricing_engine.errors.clientAborted' })
  })
})
