# Centralign Worker

A small autonomous AI worker that completes business tasks through a real browser. Give it a goal, inspect its actions, approve a proposed change, and review the verified result.

**Live replay:** https://centralign-worker.vercel.app is a read-only replay of the recorded live runs, using the real dashboard and company app. Pick a run under "Select a recent run" to see its steps, screenshots, approval, retry and verified result. Starting new runs needs a local install, because the worker keeps Chromium running and calls the model through your own credentials. Rebuild the replay with `node scripts/build-replay.mjs` and deploy the `replay-site/` folder.

The environment is a simulated company application with synthetic email, invoice and contact data. Model requests, Chromium interactions, record persistence and completion checks are real. The prototype does not claim to control arbitrary websites or desktop applications.

## Quick start

Requires Node.js 24 or later and npm.

```bash
npm ci
npx playwright install chromium
cp .env.example .env
npm run dev
```

Open `http://localhost:3000`. The company application is at `http://localhost:3000/company`.

### Connect a model

The default connection uses the OpenCode 2.x CLI and its existing provider authentication. If needed, install it and sign in:

```bash
npm install -g @opencode/cli
opencode auth login
```

Choose a provider and complete its sign-in flow. If OpenCode is already installed and signed in, skip these two commands. The prototype was developed against OpenCode 2.0.22.

The default runtime model is `openai/gpt-6-luna#low`. Change `WORKER_MODEL` to a model available through your provider. The worker's model and provider appear in the dashboard. This path does not require copying subscription credentials into the application. See the [OpenCode documentation](https://opencode.ai/v2/docs/) for alternative installation methods.

An OpenAI-compatible API connection is also supported. Configure `WORKER_PROVIDER=openai-compatible`, `OPENAI_API_KEY`, `OPENAI_BASE_URL` and a bare API model ID in `WORKER_MODEL`, without the OpenCode provider prefix or variant suffix. Do not commit credentials. API usage may incur charges.

Other settings in `.env.example` control the local port, company URL, step budget, decision timeout and data directory. The app binds to `127.0.0.1` by default.

If port 3000 is occupied, change both `PORT` and `WORKER_COMPANY_URL` in `.env`, for example to `3017` and `http://127.0.0.1:3017/company`. Open the matching dashboard URL. Model access is required; there is no scripted fallback.

## Try it

**Import an invoice**

> Find the latest invoice from Northstar Labs, extract the amount and due date, enter it into accounting, and tell me once it is done.

Leave "Fail the first save" enabled to exercise recovery. The worker reads source messages, selects the latest invoice by issue date, fills the accounting form and pauses before submitting. Approve the specific proposed change in the dashboard. A failed save must not count as completion.

**Create a report**

> Read the invoice emails and create a Markdown report listing each company's latest invoice, amount, and due date.

This uses the same worker loop and browser tools, with no invoice-import action sequence.

For these examples, "latest" means the greatest invoice issue date in the source inbox, not the email's arrival order. The report covers source invoices, including those not yet imported into accounting.

**Ask for clarification**

> Import the latest invoice from Company X.

The worker should ask which company you mean rather than invent a source or change a record.

## Architecture

```text
Task dashboard
    |
Run controller and persisted event log
    |
Observe -> model decision -> validated tool action -> observe again
    |                                |
Browser snapshot                     Approval gate for writes
    |                                |
Playwright Chromium -> simulated company app -> persisted records
    |
Independent completion checks -> summary and evidence
```

The model receives the user's goal, recent observations, available tools and relevant memory. It chooses the next action at runtime. Tools operate on observed browser element references, not model-invented selectors. The controller validates arguments, applies safety rules and records each result before the next decision.

The worker has no unrestricted shell tool. Its browser stays in the company environment, and generated files stay inside a run's artifact directory. Company mutations also pass server-side approval checks. Page content is untrusted task data, not authority to change the user's goal or bypass approval.

The worker cannot navigate to the task dashboard or its approval controls. An approval applies to the exact proposed operation and values. It is not permission for the model to perform arbitrary later writes.

Completion is a separate operation. The controller checks claimed invoice fields against stored records and source data, or checks the generated report against the source invoices. A screenshot or a model's success sentence alone is insufficient.

## Design decisions

- **A limited environment.** The assignment favors narrow, working autonomy. The company application gives us reproducible data, faults and independently inspectable effects.
- **Real browser execution.** The worker reads pages, follows links and fills forms. It does not import invoices through an invisible domain-specific shortcut.
- **A generic decision loop.** Invoice import and report creation use the same planner and tools. Domain-aware verification is intentionally separate from generic execution.
- **Explicit write approval.** The worker can gather information autonomously. A person controls changes to business records.
- **Deterministic checks.** A model can misunderstand its own result. Persisted records and source fields provide a stronger completion test.
- **Bounded recovery.** Errors return to the model with a fresh observation. Timeouts and a step budget prevent indefinite loops.
- **Small deployment footprint.** One local Node process serves the dashboard, company app and run API. There is no distributed infrastructure to configure.

## Tests and evidence

```bash
npm run typecheck   # passes
npm test            # 14/14 pass
```

The automated tests use scripted planners to cover exact-payload approval and denial, blocked worker self-approval, duplicate-safe retries, rejected fake completions, cancellation, malformed model responses and report download safety. Scripted planners exist only in tests. They never serve as a fallback for live runs.

**Demo video:** [`docs/demo.mp4`](docs/demo.mp4) is an unedited 14.5-minute browser recording of live runs using `openai/gpt-6-luna#low` through OpenCode. Model calls take several seconds each, so feel free to skip ahead through the waits. The run records and state snapshots are in [`docs/evidence/`](docs/evidence/).

Observed on 2026-10-04 with the real model:

1. **Invoice import with recovery** (`final-invoice-run.json`, 7 steps). The worker read both Northstar invoices and chose NS-1042 by issue date. It then paused to request approval of the exact payload. The first save returned HTTP 503, and the company state showed zero invoices afterward. The worker requested approval again for the same payload, saved it, and the verifier confirmed exactly one stored record: USD 1,840.50, due 2026-10-20.
2. **Different task, same worker** (`final-report-run.json`, 4 steps). The worker produced `invoice-report.md` with the latest invoice for each company. It made no business writes and requested no approvals. The verifier compared every row against the source inbox.
3. **Clarification and idempotency** (`final-clarification-question.json`, `final-clarification-run.json`). For "Company X", the worker asked which company was meant. After the answer "Northstar Labs", it noticed that NS-1042 was already in accounting and finished without a duplicate write. The verifier confirmed it.

Earlier failed live runs are also kept (`initial-*.json`). They exposed lost context after navigation and malformed or multi-part model output. Those problems led to the observation history and the bounded response retry.

## Known limitations

- The worker supports one local company environment, not arbitrary third-party websites.
- Autonomous tasks are limited to invoice imports and latest-invoice reports. Contacts can be edited manually in the simulator; payments, email sending and arbitrary business changes are not supported.
- A small goal recognizer defines the supported verification contract. The model still has to inspect the browser and choose the action sequence; the recognizer is not a general natural-language intent engine.
- It reads visible document text. Scanned PDFs, OCR, desktop control and CAPTCHA are outside scope.
- Model decisions can be slow, fail or choose poor actions. The controller bounds execution and refuses unverified completion.
- Prototype memory is local task information, not a production retrieval system.
- Approval and domain verification are designed for the included application. A new application needs its own reliable mutation and outcome checks.
- The app is intended for local evaluation. It is not a multi-user, internet-facing service.
- Cancellation stops further work but cannot roll back a record that has already committed. The run must retain evidence of any committed effect.
- The demo contains synthetic data. It does not send emails, make payments or access real customer systems.
- Reports use a normalized table schema so their source coverage and values can be checked independently.
- The authenticated OpenCode model path is the live-demo path. The optional OpenAI-compatible transport requires your own key and was not live-tested against a paid endpoint.

## With more time

Add more company adapters with explicit success predicates, durable recovery after process interruption, better handling of untrusted documents, model regression evaluations, PDF extraction and scoped multi-user authentication. Extend coverage only after each added workflow has meaningful outcome checks.

## Assumptions

The evaluator can run Node.js and download Chromium. A supported model connection is available. Human approval is an acceptable safety boundary for business mutations. Synthetic source data is acceptable because the assignment explicitly allows a simulated company application.

## Models and external components

- GPT-6.1 Sol Max handled planning and technical supervision.
- GPT-6 Luna Max authored implementation code under Sol's review.
- The runtime model is configurable and is disclosed per run. The recorded demo used `openai/gpt-6-luna#low` through OpenCode 2.0.22.
- OpenCode provides the optional authenticated model transport. The app does not implement or store Codex authentication.
- Playwright controls Chromium. Express serves the local application. TypeScript describes the controller and tools. Zod validates structured data.
- Browser recording and FFmpeg provide the demo evidence. No generated animation substitutes for execution footage.

No real company service, production data or paid hosting is required for the prototype.
