import { expect, test, type APIRequestContext } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/modules/core/__integration__/helpers/api'
import {
  expectConflictBody,
  putWithLock,
  readUpdatedAt,
  resolveApiUrl,
} from '@open-mercato/core/modules/core/__integration__/helpers/optimisticLockUi'
import { OPTIMISTIC_LOCK_HEADER_NAME } from '@open-mercato/shared/lib/crud/optimistic-lock-headers'

/**
 * TC-PRICING-OBJ-002: optimistic locking on `/api/pricing/objectives`.
 *
 * AGENTS.md makes the lock default-ON for every user-editable entity, so the objectives route has
 * to expose `updatedAt` on the list payload and refuse a write whose expected token no longer
 * matches. Both mutating verbs are covered: `CrudForm` derives one header from `initialValues`
 * and sends it on update AND delete, so a lock that only guards PUT would leave the delete button
 * able to clobber a concurrent edit.
 */

export const integrationMeta = {
  description: 'Advisor objectives optimistic locking',
  requiredModules: ['pricing_engine'],
}

const OBJECTIVES_API = '/api/pricing/objectives'

function objectiveBody(id: string | null, label: string, changeNote: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    scope: 'global',
    objectives: [{ code: 'qa-lock', label, metric: 'marginPercent', direction: 'maximise', weight: '1' }],
    changeNote,
    validFrom: '2020-01-01T00:00:00.000Z',
  }
  if (id) body.id = id
  return body
}

/**
 * `updated_at` has millisecond resolution, so a bump that lands inside the same millisecond as the
 * previous write would produce an identical token and silently turn the conflict assertion into a
 * no-op. Retry until the token actually moves rather than asserting on a coin flip.
 */
async function bumpUntilChanged(
  request: APIRequestContext,
  token: string,
  id: string,
  previous: string,
  changeNote: string,
): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await apiRequest(request, 'PUT', OBJECTIVES_API, {
      token,
      data: objectiveBody(id, `QA bump ${attempt}`, changeNote),
    })
    expect(response.status(), 'a header-less PUT takes the additive path and must succeed').toBe(200)
    const current = await readUpdatedAt(request, token, OBJECTIVES_API, id)
    if (current !== previous) return current
  }
  throw new Error('[internal] objective updated_at did not advance across five writes')
}

test.describe('TC-PRICING-OBJ-002: advisor objectives optimistic lock', () => {
  test('a stale update and a stale delete are both refused with the 409 conflict body', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const stamp = Date.now()
    const changeNote = `QA TC-PRICING-OBJ-002 ${stamp}`
    let objectiveId: string | null = null

    try {
      const createResponse = await apiRequest(request, 'POST', OBJECTIVES_API, {
        token,
        data: objectiveBody(null, 'QA lock', changeNote),
      })
      expect(createResponse.status(), `create should be 201: ${await createResponse.text()}`).toBe(201)
      objectiveId = ((await createResponse.json()) as { id?: string }).id ?? null
      expect(typeof objectiveId, 'create should return an id').toBe('string')
      const id = objectiveId as string

      const originalUpdatedAt = await readUpdatedAt(request, token, OBJECTIVES_API, id)

      const bumpedUpdatedAt = await bumpUntilChanged(request, token, id, originalUpdatedAt, changeNote)
      expect(bumpedUpdatedAt).not.toBe(originalUpdatedAt)

      const staleUpdate = await putWithLock(
        request,
        token,
        OBJECTIVES_API,
        objectiveBody(id, 'QA stale', changeNote),
        originalUpdatedAt,
      )
      const conflict = await expectConflictBody(staleUpdate)
      expect(conflict.expectedUpdatedAt).toBe(originalUpdatedAt)
      expect(conflict.currentUpdatedAt).toBe(bumpedUpdatedAt)

      const freshUpdate = await putWithLock(
        request,
        token,
        OBJECTIVES_API,
        objectiveBody(id, 'QA fresh', changeNote),
        bumpedUpdatedAt,
      )
      expect(freshUpdate.status(), 'a write carrying the current token must pass').toBe(200)
      const afterFreshUpdate = await readUpdatedAt(request, token, OBJECTIVES_API, id)
      expect(afterFreshUpdate).not.toBe(bumpedUpdatedAt)

      const staleDelete = await request.fetch(resolveApiUrl(`${OBJECTIVES_API}?id=${encodeURIComponent(id)}`), {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          [OPTIMISTIC_LOCK_HEADER_NAME]: bumpedUpdatedAt,
        },
      })
      const deleteConflict = await expectConflictBody(staleDelete)
      expect(deleteConflict.expectedUpdatedAt).toBe(bumpedUpdatedAt)
      expect(deleteConflict.currentUpdatedAt).toBe(afterFreshUpdate)

      const freshDelete = await request.fetch(resolveApiUrl(`${OBJECTIVES_API}?id=${encodeURIComponent(id)}`), {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          [OPTIMISTIC_LOCK_HEADER_NAME]: afterFreshUpdate,
        },
      })
      expect(freshDelete.status(), 'a delete carrying the current token must pass').toBe(200)
      objectiveId = null
    } finally {
      if (objectiveId) {
        await apiRequest(request, 'DELETE', `${OBJECTIVES_API}?id=${encodeURIComponent(objectiveId)}`, {
          token,
        }).catch(() => undefined)
      }
    }
  })
})
