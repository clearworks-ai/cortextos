# Playbook: Slack-to-JobTread Rollout
**Distilled from:** Northwind rollout exercise · **Last updated:** 2026-08-05
**Use when:** A client wants Slack-triggered task creation wired into an external work-management system.

## Outcome
A working task-creation flow that users can trigger from Slack and verify in the target system without manual coordinator cleanup.

## Prerequisites
Slack workspace access, target work-management access, isolated test channel, validation checklist, one real user for confirmation.

## The Method
1. Map the trigger and destination fields before writing code. Good looks like a signed-off field map. Time estimate: 45 minutes.
2. Stand up an isolated test channel before live-user testing. Good looks like zero noisy tags outside the test lane. Time estimate: 30 minutes.
3. Ship the first create-task path and verify visibility in the destination system with one user. Good looks like an active visible task, not just a successful webhook log. Time estimate: 2 hours.
4. Record a short operator demo once the visibility check passes. Good looks like a self-serve walkthrough for the client team. Time estimate: 30 minutes.

## Gotchas
- Symptom: tasks appear to create successfully but never show up for end users. Cause: backend state mismatch. Fix: validate active/visible state, not just API success.
- Symptom: test notifications annoy the client team. Cause: no isolated lane. Fix: create the private test channel before any live testing.

## Estimate
Half-day for first-path rollout, plus follow-up time if visibility bugs surface.
