# Contracts

The interfaces every component builds against. Change these first, then the code.

| File | Defines | Used by |
| --- | --- | --- |
| `api.md` | Every HTTP endpoint (API, probe, watcher control), auth, errors, signing, trust checks, evidence card, watcher maths | all |
| `types.ts` | TypeScript types for the payload and responses (type-only, no runtime code) | `apps/sweep`, `apps/dashboard`, `supabase/functions` |
| `test-payload.schema.json` | JSON Schema (draft 2020-12) for `POST /v1/tests` | `supabase/functions`, `apps/sweep` tests |

Import the types with `import type { ... } from "<relative path>/contracts/types.ts"` so bundlers erase them.
