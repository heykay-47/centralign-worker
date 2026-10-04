# Demo walkthrough

This is the recording plan. Actual execution results belong in the evidence file produced after the run.

## Main recording

1. Show the task dashboard and its model connection. Explain that the company environment and source data are synthetic, but execution is real.
2. Submit: "Find the latest invoice from Northstar Labs, extract the amount and due date, enter it into accounting, and tell me once it is done."
3. Keep "Fail the first save" enabled. Show the worker reading invoice emails and choosing actions from the page.
4. When the worker asks for approval, inspect the proposed company, invoice number, amount and due date. Approve that change.
5. Show the real save failure and the worker's recovery. Approve the retried change again if the controller requires a fresh grant.
6. Show independent verification and the persisted accounting row. The expected latest invoice is NS-1042, USD 1840.50, due October 20, 2026.
7. Open the source screenshot or run evidence. A model-generated summary is not the only proof.

## Second task

Submit: "Read the invoice emails and create a Markdown report listing each company's latest invoice, amount, and due date."

Open the generated file. Explain that the same controller and browser tools perform this task. The model chooses a different action sequence, while completion checks remain explicit.

## Safety demonstration

If recording time permits, request Company X and show the clarification state. Alternatively, reject an invoice write and show that accounting remains unchanged.

## What to say about the architecture

"The model proposes the next action after each observation. The controller validates the action and runs it through Playwright. Approval lives outside the model. Completion requires reading stored effects and checking them against the source, rather than trusting the model's claim."

## Honest disclosure

- Do not describe unit-test planners as live AI execution.
- Do not conceal a failed run. Record a successful run only after correcting the cause and keep the test evidence accurate.
- A recording may compress waiting time only if its description says so.
- Do not record credentials, browser profiles or real customer data.
