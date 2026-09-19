import { expect, test, type APIRequestContext } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/modules/core/__integration__/helpers/api'
import {
  createRoleFixture,
  createUserFixture,
  deleteRoleIfExists,
  deleteUserIfExists,
  setRoleAclFeatures,
} from '@open-mercato/core/modules/core/__integration__/helpers/authFixtures'
import { getTokenContext } from '@open-mercato/core/modules/core/__integration__/helpers/generalFixtures'

/**
 * TC-PRICING-OBJ-001: operator objectives and weights CRUD on `/api/pricing/objectives`.
 *
 * Covers the create / list / update / delete round trip, the three validations that keep a
 * scoring row from being unusable (duplicate objective code, metric outside the enum, negative
 * weight), and the `pricing.params.read` vs `pricing.params.write` split declared by the route's
 * metadata.
 */

export const integrationMeta = {
  description: 'Advisor objectives CRUD and ACL',
  requiredModules: ['pricing_engine', 'auth'],
}

const OBJECTIVES_API = '/api/pricing/objectives'

type ObjectiveRow = {
  id: string
  scope: string
  scopeRefId: string | null
  componentCode: string
  objectives: Array<{ code: string; label: string; metric: string; direction: string; weight: string }>
  objectiveCount: number
  changeNote: string
  updatedAt: string | null
}

type ObjectiveListBody = { items?: ObjectiveRow[]; total?: number }

type ValidationBody = { error?: string; details?: Array<{ path?: unknown[]; message?: string }> }

function validFrom(): string {
  return '2020-01-01T00:00:00.000Z'
}

async function readObjectiveById(
  request: APIRequestContext,
  token: string,
  id: string,
): Promise<ObjectiveRow | null> {
  const response = await apiRequest(request, 'GET', `${OBJECTIVES_API}?id=${encodeURIComponent(id)}`, { token })
  expect(response.status(), `GET ${OBJECTIVES_API}?id= should be 200`).toBe(200)
  const body = (await response.json()) as ObjectiveListBody
  return (body.items ?? [])[0] ?? null
}

async function expectRejected(
  request: APIRequestContext,
  token: string,
  data: Record<string, unknown>,
  expectation: { path: string; message?: string },
): Promise<void> {
  const response = await apiRequest(request, 'POST', OBJECTIVES_API, { token, data })
  expect(response.status(), `POST ${OBJECTIVES_API} should reject ${expectation.path}`).toBe(400)
  const body = (await response.json()) as ValidationBody
  const issues = body.details ?? []
  const matching = issues.find((issue) => (issue.path ?? []).join('.').includes(expectation.path))
  expect(matching, `rejection should name ${expectation.path}, got ${JSON.stringify(issues)}`).toBeTruthy()
  if (expectation.message) {
    expect(matching?.message).toBe(expectation.message)
  }
}

test.describe('TC-PRICING-OBJ-001: advisor objectives CRUD and ACL', () => {
  test('creates, lists, updates and deletes an objective row', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const stamp = Date.now()
    const changeNote = `QA TC-PRICING-OBJ-001 ${stamp}`
    let objectiveId: string | null = null

    try {
      const createResponse = await apiRequest(request, 'POST', OBJECTIVES_API, {
        token,
        data: {
          scope: 'global',
          objectives: [
            { code: 'qa-margin', label: 'QA margin', metric: 'marginPercent', direction: 'maximise', weight: '1.5' },
            { code: 'qa-cost', label: 'QA cost', metric: 'warehouseCost', direction: 'minimise', weight: '0.5' },
          ],
          changeNote,
          validFrom: validFrom(),
        },
      })
      expect(createResponse.status(), `create should be 201: ${await createResponse.text()}`).toBe(201)
      const created = (await createResponse.json()) as { id?: string }
      expect(typeof created.id).toBe('string')
      objectiveId = created.id as string

      const listed = await readObjectiveById(request, token, objectiveId)
      expect(listed, 'created objective should be listed').toBeTruthy()
      expect(listed?.componentCode).toBe('objective_weights')
      expect(listed?.scope).toBe('global')
      expect(listed?.scopeRefId).toBeNull()
      expect(listed?.changeNote).toBe(changeNote)
      expect(listed?.objectiveCount).toBe(2)
      expect(listed?.objectives.map((objective) => objective.code)).toEqual(['qa-margin', 'qa-cost'])
      expect(listed?.objectives[0]?.weight).toBe('1.5')

      const searchResponse = await apiRequest(
        request,
        'GET',
        `${OBJECTIVES_API}?search=${encodeURIComponent(changeNote)}&pageSize=100`,
        { token },
      )
      expect(searchResponse.status()).toBe(200)
      const searchBody = (await searchResponse.json()) as ObjectiveListBody
      expect(
        (searchBody.items ?? []).some((item) => item.id === objectiveId),
        'the new row should show up in an unfiltered search listing',
      ).toBe(true)

      const updateResponse = await apiRequest(request, 'PUT', OBJECTIVES_API, {
        token,
        data: {
          id: objectiveId,
          scope: 'global',
          objectives: [
            { code: 'qa-margin', label: 'QA margin v2', metric: 'profitNet', direction: 'maximise', weight: '3' },
          ],
          changeNote: `${changeNote} updated`,
          validFrom: validFrom(),
        },
      })
      expect(updateResponse.status(), `update should be 200: ${await updateResponse.text()}`).toBe(200)
      expect(await updateResponse.json()).toEqual({ ok: true })

      const updated = await readObjectiveById(request, token, objectiveId)
      expect(updated?.objectiveCount).toBe(1)
      expect(updated?.objectives[0]?.label).toBe('QA margin v2')
      expect(updated?.objectives[0]?.metric).toBe('profitNet')
      expect(updated?.objectives[0]?.weight).toBe('3')
      expect(updated?.changeNote).toBe(`${changeNote} updated`)

      const deleteResponse = await apiRequest(
        request,
        'DELETE',
        `${OBJECTIVES_API}?id=${encodeURIComponent(objectiveId)}`,
        { token },
      )
      expect(deleteResponse.status(), 'delete should be 200').toBe(200)
      expect(await readObjectiveById(request, token, objectiveId), 'deleted row should leave the list').toBeFalsy()
      objectiveId = null
    } finally {
      if (objectiveId) {
        await apiRequest(request, 'DELETE', `${OBJECTIVES_API}?id=${encodeURIComponent(objectiveId)}`, {
          token,
        }).catch(() => undefined)
      }
    }
  })

  test('rejects a duplicate objective code, an unknown metric and a negative weight', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const stamp = Date.now()

    await expectRejected(
      request,
      token,
      {
        scope: 'global',
        objectives: [
          { code: 'qa-dup', label: 'A', metric: 'marginPercent', direction: 'maximise', weight: '1' },
          { code: 'qa-dup', label: 'B', metric: 'profitNet', direction: 'maximise', weight: '1' },
        ],
        changeNote: `QA duplicate ${stamp}`,
        validFrom: validFrom(),
      },
      { path: 'objectives', message: 'pricing_engine.params.errors.duplicateObjectiveCode' },
    )

    await expectRejected(
      request,
      token,
      {
        scope: 'global',
        objectives: [{ code: 'qa-metric', label: 'A', metric: 'noSuchMetric', direction: 'maximise', weight: '1' }],
        changeNote: `QA metric ${stamp}`,
        validFrom: validFrom(),
      },
      { path: 'objectives.0.metric' },
    )

    await expectRejected(
      request,
      token,
      {
        scope: 'global',
        objectives: [{ code: 'qa-weight', label: 'A', metric: 'marginPercent', direction: 'maximise', weight: '-1' }],
        changeNote: `QA weight ${stamp}`,
        validFrom: validFrom(),
      },
      { path: 'objectives.0.weight', message: 'pricing_engine.params.errors.invalidWeight' },
    )
  })

  test('pricing.params.read grants the list but not the write', async ({ request }) => {
    const adminToken = await getAuthToken(request, 'admin')
    const { organizationId, tenantId } = getTokenContext(adminToken)
    expect(organizationId, 'admin token should carry an organization id').toBeTruthy()

    const stamp = Date.now()
    const email = `qa.pricing.obj001.${stamp}@example.com`
    const password = 'Secret123!'
    let roleId: string | null = null
    let userId: string | null = null

    try {
      roleId = await createRoleFixture(request, adminToken, { name: `QA Pricing Read ${stamp}`, tenantId })
      await setRoleAclFeatures(request, adminToken, { roleId, features: ['pricing.params.read'] })
      userId = await createUserFixture(request, adminToken, {
        email,
        password,
        organizationId,
        roles: [roleId],
        name: `QA Pricing Read ${stamp}`,
      })

      const readerToken = await getAuthToken(request, email, password)

      const listResponse = await apiRequest(request, 'GET', `${OBJECTIVES_API}?pageSize=1`, { token: readerToken })
      expect(listResponse.status(), 'pricing.params.read should allow the list').toBe(200)

      const writeResponse = await apiRequest(request, 'POST', OBJECTIVES_API, {
        token: readerToken,
        data: {
          scope: 'global',
          objectives: [
            { code: 'qa-denied', label: 'Denied', metric: 'marginPercent', direction: 'maximise', weight: '1' },
          ],
          changeNote: `QA denied ${stamp}`,
          validFrom: validFrom(),
        },
      })
      expect(writeResponse.status(), 'a reader must not be able to create an objective row').toBe(403)
      const denied = (await writeResponse.json()) as { requiredFeatures?: string[] }
      expect(denied.requiredFeatures).toContain('pricing.params.write')
    } finally {
      await deleteUserIfExists(request, adminToken, userId)
      await deleteRoleIfExists(request, adminToken, roleId)
    }
  })
})
