// Core
import express from 'express'

// Misc
import { API_BASE_PATH, JSON_BODY_LIMIT } from './constants'
import { environment, STRIPPED_CHILD_ENV_KEYS } from './env'
import { getHealth } from './routes/v1/health'
import { postChooseAction } from './routes/v1/chooseAction'
import { postEndGame } from './routes/v1/endGame'

const application = express()

application.use(express.json({ limit: JSON_BODY_LIMIT }))

application.get(`${API_BASE_PATH}/health`, getHealth)
application.post(`${API_BASE_PATH}/choose-action`, postChooseAction)
application.post(`${API_BASE_PATH}/end-game`, postEndGame)

const server = application.listen(environment.LLM_OPPONENT_PORT, environment.LLM_OPPONENT_HOST, () => {
  console.log(
    `LLM opponent sidecar listening on http://${environment.LLM_OPPONENT_HOST}:${environment.LLM_OPPONENT_PORT}`
      + ` (model ${environment.LLM_OPPONENT_MODEL})`,
  )

  if (!environment.CLAUDE_CODE_OAUTH_TOKEN && !environment.CLAUDE_CONFIG_DIR) {
    console.warn(
      'No CLAUDE_CODE_OAUTH_TOKEN and no CLAUDE_CONFIG_DIR — the CLI will fall back to whatever '
        + 'credentials it finds on this machine. Set one of them if the first decision fails to authenticate.',
    )
  }

  for (const key of STRIPPED_CHILD_ENV_KEYS) {
    if (process.env[key]) {
      console.warn(`${key} is set in this shell; it is stripped from the Claude subprocess on purpose.`)
    }
  }
})

// Without this a decision in flight when the operator hits Ctrl-C leaves the
// Claude subprocess orphaned and the port held.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`Received ${signal}; shutting down.`)
    server.close(() => process.exit(0))
  })
}
