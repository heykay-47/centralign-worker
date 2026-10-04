# Acceptance checks

This checklist was written before implementation. The README's "Tests and evidence" section records which checks were observed passing.

## Required end-to-end behavior

1. Enter a natural-language invoice goal through the dashboard.
2. Observe actual model decisions and browser interactions.
3. Read both older and newer Northstar invoices. Select NS-1042 by issue date.
4. Stop before a business mutation. Show the exact fields being proposed.
5. Reject approval and confirm no invoice was stored.
6. On a new approved run, encounter the injected HTTP 503, retain the form, recover and save.
7. Verify one stored NS-1042 record, USD 1840.50, due 2026-10-20, linked to the correct source message.
8. Repeat the import without creating a duplicate.
9. Generate a report through the same worker. Check each company's latest invoice and its amount and due date against the stored source messages.
10. Request Company X and ask for clarification before changing anything.

## Safety and reliability

- Approval grants apply to the exact pending write, not every future mutation.
- A failure does not consume permission in a way that permits a different write.
- The model cannot call the shell or use its provider transport to browse around the app's tool policy.
- External navigation and generated-file path traversal fail closed.
- The untrusted message body cannot override approval or navigation rules.
- Cancellation prevents later mutations and removes pending approvals.
- A false completion claim fails the independent verifier.
- Invalid model JSON, missing browser references and transport errors are visible and bounded.
- Persisted events explain what was attempted and what actually happened.

## Submission checks

- A clean installation follows the README without hidden local dependencies.
- The recorded demo shows real model execution, approval, a save failure, recovery and verified completion.
- The source repository includes no keys, cookies, provider tokens or private runtime data.
- The README covers setup, architecture, decisions, limitations, assumptions, next steps and external components.
- Documentation distinguishes tested behavior from planned work.
