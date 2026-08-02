# Company OS repository instructions

## Scope boundary

- This repository contains the local-only Company OS control plane. Customer SaaS source belongs in connected project repositories, never here.
- Never access a path outside the configured project roots or any path listed in `COMPANY_PROJECTS_FORBIDDEN_ROOTS`.
- Never commit secrets. Add new configuration names to `.env.example` only.

## System boundary

- Company OS is a generic local cockpit that coordinates one isolated CEO and eleven specialists per connected project.
- Every project keeps its own conversations, work, memory, decisions, deliverables, database and runtime.
- Company OS itself must never be bundled into or deployed with a customer-facing SaaS.
- No external spend, live ad campaign, production deployment, bulk outreach or irreversible financial action without explicit owner approval.

## Implementation standards

- TypeScript strict mode and Zod at trust boundaries.
- No secret, customer content or private credential may appear in logs or agent memory.
- Real local execution is the default. Test doubles are allowed only inside automated tests and must never be presented as live work.

## Verification

- Run `npm run lint`, `npm run typecheck`, `npm run test` and `npm run build` for release changes.
- Run responsive browser checks at 375, 768, 1024 and 1440 px for UI changes.
- A failed QA, safety, privacy or policy-gateway check blocks release.
