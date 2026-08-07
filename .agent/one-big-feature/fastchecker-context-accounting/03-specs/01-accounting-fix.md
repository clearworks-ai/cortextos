# Spec 01 — Occupancy formula

Implements the approved master plan without runtime configuration changes.

Status: APPROVED by Larry

1. In `FastChecker.checkContextStatus`, read a valid positive `context_window_size` from the bridge payload as the effective denominator.
2. Sum only finite numeric `input_tokens` and `output_tokens` from `current_usage`. Cache read/creation fields must not contribute.
3. Calculate the decision percentage with the effective denominator. If it is absent/invalid, fall back to `realContextWindow(model)` to preserve older bridge compatibility.
4. Update comments/logging so they describe current-turn occupancy and the actual denominator.
5. Add focused regression coverage that proves the supplied 27.97% sample and proves large cache fields are ignored.
6. Do not edit runtime configuration, model selection, reasoning effort, app-server argv, or canary behavior.
