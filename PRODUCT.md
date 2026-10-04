# Centralign Worker

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Delegated by the user. Node.js 24, TypeScript, Express, Playwright and a small browser-native dashboard keep setup and deployment short. The worker calls a real language model and controls a real Chromium browser.

## Users

An internship evaluator needs to run a prototype, inspect its actions, and verify that it completed a requested business task. The submitter has a two-hour deadline.

## Product purpose

Accept a natural-language goal, work in a limited simulated company application, request approval before changing business data, and return evidence of the outcome.

## Operating context

The company application contains synthetic email messages, invoices and contacts. Initial demonstrations import the latest invoice and prepare a report from source documents. The company application is simulated. The browser, model calls, stored records and verification are real.

## Capabilities and constraints

- The user approved a compact dashboard focused on execution evidence rather than visual extras.
- A generic observe, decide, act loop chooses browser actions at runtime.
- The task view shows the plan, observations, errors, pending approvals and verified results.
- Writes need user approval. Navigation and generated files stay inside the allowed environment.
- Runtime data and credentials must not enter the public repository.
- The user authorized a new public GitHub repository after verification.
- Public hosting is not assumed. A real recorded browser demo is acceptable under the assignment.

## Evidence on hand

The assignment is the specification. There is no incumbent interface, brand artwork or real customer data. Demo records must be labeled synthetic. Test results and recordings may be described only after they have actually been observed.

## Product principles

- Complete a narrow task rather than claim universal computer control.
- Do not call a task complete because the model says it is.
- Show useful evidence and recoverable errors.
- Keep model reasoning summaries separate from private chain of thought.
