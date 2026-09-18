import type { DecisionRequest } from './decisionContract'

// Core
import { beforeEach, describe, expect, it, vi } from 'vitest'

const queryMock = vi.hoisted(() => vi.fn())

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: queryMock,
}))

type Context = {
  chooseAction: typeof import('./chooseAction').chooseAction
  forgetGame: typeof import('./chooseAction').forgetGame
  DecisionRejectedError: typeof import('./chooseAction').DecisionRejectedError
}

/** A minimal stand-in for the one `result` message a finished turn emits. */
function resultMessage(overrides: Record<string, unknown> = {}) {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: 'session-1',
    errors: [],
    result: '',
    structured_output: { actionIndex: 1, reasoning: 'Holding up the counterspell.' },
    ...overrides,
  }
}

function stubQuery(...messageBatches: unknown[][]) {
  for (const messages of messageBatches) {
    queryMock.mockImplementationOnce(() => ({
      async *[Symbol.asyncIterator]() {
        for (const message of messages) {
          yield message
        }
      },
    }))
  }
}

function buildRequest(overrides: Partial<DecisionRequest> = {}): DecisionRequest {
  return {
    gameId: 'game-1',
    playerId: 1,
    difficulty: 'VeryHard',
    waitingFor: 'Priority',
    state: { turn_number: 3 },
    actions: [{ type: 'PassPriority' }, { type: 'PlayLand', object_id: 7 }],
    ...overrides,
  }
}

describe('chooseAction', () => {
  beforeEach<Context>(async (context) => {
    vi.resetModules()
    queryMock.mockReset()

    const module = await import('./chooseAction')
    context.chooseAction = module.chooseAction
    context.forgetGame = module.forgetGame
    context.DecisionRejectedError = module.DecisionRejectedError
  })

  it<Context>('returns the index Claude chose', async (context) => {
    stubQuery([resultMessage()])

    const decision = await context.chooseAction(buildRequest())

    expect(decision.actionIndex).toBe(1)
    expect(decision.reasoning).toBe('Holding up the counterspell.')
    expect(decision.sessionId).toBe('session-1')
  })

  it<Context>('starts fresh, then resumes the same game session', async (context) => {
    stubQuery([resultMessage()], [resultMessage({ session_id: 'session-1' })])

    await context.chooseAction(buildRequest())
    await context.chooseAction(buildRequest())

    expect(queryMock.mock.calls[0]?.[0].options.resume).toBeUndefined()
    expect(queryMock.mock.calls[1]?.[0].options.resume).toBe('session-1')
  })

  it<Context>('keeps games in separate sessions', async (context) => {
    stubQuery([resultMessage({ session_id: 'a' })], [resultMessage({ session_id: 'b' })])

    await context.chooseAction(buildRequest({ gameId: 'game-a' }))
    await context.chooseAction(buildRequest({ gameId: 'game-b' }))

    expect(queryMock.mock.calls[1]?.[0].options.resume).toBeUndefined()
  })

  // Sharing one transcript across seats would let seat 2 read seat 1's
  // redacted-but-visible hand out of the conversation history.
  it<Context>('keeps seats at one table in separate sessions', async (context) => {
    stubQuery([resultMessage({ session_id: 'seat-1' })], [resultMessage({ session_id: 'seat-2' })])

    await context.chooseAction(buildRequest({ playerId: 1 }))
    await context.chooseAction(buildRequest({ playerId: 2 }))

    expect(queryMock.mock.calls[1]?.[0].options.resume).toBeUndefined()
  })

  it<Context>('forgetGame drops every seat at that table', async (context) => {
    stubQuery(
      [resultMessage({ session_id: 'seat-1' })],
      [resultMessage({ session_id: 'seat-2' })],
      [resultMessage()],
      [resultMessage()],
    )

    await context.chooseAction(buildRequest({ playerId: 1 }))
    await context.chooseAction(buildRequest({ playerId: 2 }))
    context.forgetGame('game-1')
    await context.chooseAction(buildRequest({ playerId: 1 }))
    await context.chooseAction(buildRequest({ playerId: 2 }))

    expect(queryMock.mock.calls[2]?.[0].options.resume).toBeUndefined()
    expect(queryMock.mock.calls[3]?.[0].options.resume).toBeUndefined()
  })

  // `allowedTools` only governs auto-approval; `tools` is what removes the
  // built-in set. Without it Claude can still call Bash/Read and burn turns.
  it<Context>('hands the CLI an empty built-in toolset by default', async (context) => {
    stubQuery([resultMessage()])

    await context.chooseAction(buildRequest())

    expect(queryMock.mock.calls[0]?.[0].options.tools).toEqual([])
    expect(queryMock.mock.calls[0]?.[0].options.settingSources).toEqual([])
  })

  it<Context>('forgetGame drops the session so the next decision starts over', async (context) => {
    stubQuery([resultMessage()], [resultMessage()])

    await context.chooseAction(buildRequest())
    context.forgetGame('game-1')
    await context.chooseAction(buildRequest())

    expect(queryMock.mock.calls[1]?.[0].options.resume).toBeUndefined()
  })

  it<Context>('rejects an index past the end of the offered actions', async (context) => {
    stubQuery([resultMessage({ structured_output: { actionIndex: 2, reasoning: 'off the end' } })])

    await expect(context.chooseAction(buildRequest())).rejects.toBeInstanceOf(context.DecisionRejectedError)
  })

  it<Context>('rejects an answer that does not match the decision schema', async (context) => {
    stubQuery([resultMessage({ structured_output: { reasoning: 'no index at all' } })])

    await expect(context.chooseAction(buildRequest())).rejects.toBeInstanceOf(context.DecisionRejectedError)
  })

  it<Context>('rejects a turn that ended early and does not latch its session id', async (context) => {
    stubQuery(
      [resultMessage({ subtype: 'error_max_turns', errors: ['hit the turn cap'], session_id: 'bad' })],
      [resultMessage()],
    )

    await expect(context.chooseAction(buildRequest())).rejects.toBeInstanceOf(context.DecisionRejectedError)

    await context.chooseAction(buildRequest())
    expect(queryMock.mock.calls[1]?.[0].options.resume).toBeUndefined()
  })

  it<Context>('rejects a session that produced no result message', async (context) => {
    stubQuery([[{ type: 'assistant' }]].flat())

    await expect(context.chooseAction(buildRequest())).rejects.toBeInstanceOf(context.DecisionRejectedError)
  })

  it<Context>('serializes concurrent decisions for one game', async (context) => {
    const inFlight: string[] = []

    queryMock.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        inFlight.push('start')
        await new Promise((resolve) => setTimeout(resolve, 5))
        inFlight.push('end')
        yield resultMessage()
      },
    }))

    await Promise.all([
      context.chooseAction(buildRequest()),
      context.chooseAction(buildRequest()),
    ])

    // Interleaving would read start,start,end,end — the lock forces full turns.
    expect(inFlight).toEqual(['start', 'end', 'start', 'end'])
  })

  // A query that never yields a result must not hold the seat's lock forever:
  // every later decision would queue behind it and the opponent would go
  // silently dead for the rest of the game.
  it<Context>('aborts a hung query and frees the lock for the next decision', async (context) => {
    vi.useFakeTimers()

    queryMock.mockImplementationOnce(({ options }) => ({
      async *[Symbol.asyncIterator]() {
        await new Promise<void>((resolve) => {
          options.abortController.signal.addEventListener('abort', () => resolve())
        })
      },
    }))
    stubQuery([resultMessage()])

    // Attach the rejection handler BEFORE advancing the clock. Advancing
    // settles the promise, and a rejection observed only afterwards is flagged
    // unhandled in the interim.
    const hung = expect(context.chooseAction(buildRequest())).rejects.toBeInstanceOf(
      context.DecisionRejectedError,
    )
    await vi.advanceTimersByTimeAsync(110_000)
    await hung

    vi.useRealTimers()
    await expect(context.chooseAction(buildRequest())).resolves.toMatchObject({ actionIndex: 1 })
  })

  it<Context>('keeps the queue alive after a failed decision', async (context) => {
    stubQuery([resultMessage({ structured_output: { actionIndex: 99, reasoning: 'bad' } })], [resultMessage()])

    await expect(context.chooseAction(buildRequest())).rejects.toThrow()
    await expect(context.chooseAction(buildRequest())).resolves.toMatchObject({ actionIndex: 1 })
  })
})
