// Core
import { config as loadDotenv } from 'dotenv'
import { z } from 'zod'

loadDotenv()

/**
 * The credential the Claude Code CLI will actually resolve, and the one env var
 * that must NOT leak through from the operator's shell.
 *
 * The CLI's resolution order is ANTHROPIC_AUTH_TOKEN → CLAUDE_CODE_OAUTH_TOKEN →
 * CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR → the stored `.credentials.json`. An
 * ANTHROPIC_API_KEY in the environment shortcuts all of that and bills a Console
 * account instead of the subscription this sidecar exists to use, so the child
 * process is spawned without it. CLAUDECODE is scrubbed for a different reason:
 * it is set inside a Claude Code session, and a CLI that sees it refuses to
 * nest — which would make the sidecar work from a plain terminal and fail from
 * the one place a developer is most likely to start it.
 */
export const STRIPPED_CHILD_ENV_KEYS = ['ANTHROPIC_API_KEY', 'CLAUDECODE'] as const

const environmentSchema = z.object({
  CLAUDE_CODE_OAUTH_TOKEN: z.string().trim().optional(),
  CLAUDE_CONFIG_DIR: z.string().trim().optional(),
  LLM_OPPONENT_MODEL: z.string().trim().default('claude-opus-5'),
  LLM_OPPONENT_PORT: z.coerce.number().int().positive().default(8788),
  LLM_OPPONENT_HOST: z.string().trim().default('127.0.0.1'),
  LLM_OPPONENT_MAX_TURNS: z.coerce.number().int().positive().default(4),
  LLM_OPPONENT_ALLOW_WEB_SEARCH: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  LLM_OPPONENT_MAX_REQUEST_BYTES: z.coerce.number().int().positive().default(1_048_576),
})

const parsed = environmentSchema.safeParse(process.env)

if (!parsed.success) {
  console.error('Invalid sidecar environment:', parsed.error.flatten().fieldErrors)
  process.exit(1)
}

export const environment = parsed.data

/**
 * The environment handed to the Claude Code subprocess. Built by subtraction
 * rather than by listing what to keep: the CLI reads a long and moving set of
 * variables (proxy settings, HOME, PATH, terminal hints), and an allowlist that
 * misses one fails in a way that looks like a network or auth bug.
 */
export function buildChildEnvironment(): Record<string, string | undefined> {
  const childEnvironment: Record<string, string | undefined> = { ...process.env }

  for (const key of STRIPPED_CHILD_ENV_KEYS) {
    delete childEnvironment[key]
  }

  if (environment.CLAUDE_CODE_OAUTH_TOKEN) {
    childEnvironment.CLAUDE_CODE_OAUTH_TOKEN = environment.CLAUDE_CODE_OAUTH_TOKEN
  }

  if (environment.CLAUDE_CONFIG_DIR) {
    childEnvironment.CLAUDE_CONFIG_DIR = environment.CLAUDE_CONFIG_DIR
  }

  return childEnvironment
}
