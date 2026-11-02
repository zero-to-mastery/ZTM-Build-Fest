# Review Checklist

## Architecture
- [ ] Responsibility is in the correct layer.
- [ ] No duplicate canonical model was introduced.
- [ ] AI remains optional.
- [ ] Browser-native capabilities were considered.
- [ ] Rust usage has a concrete benefit.

## Contracts
- [ ] API/schema changes are versioned or compatible.
- [ ] Migration is documented where needed.
- [ ] Errors are structured/actionable.
- [ ] external sizes/ranges are bounded.

## Rust/WASM
- [ ] Invalid input cannot ordinarily panic.
- [ ] Non-finite numbers are handled.
- [ ] retained state has lifecycle/invalidation rules.
- [ ] boundary is not unnecessarily chatty.
- [ ] size/performance checked for material changes.

## AI
- [ ] Model output validated before mutation.
- [ ] No arbitrary generated code execution.
- [ ] Tool outputs bounded.
- [ ] Repair/tool loops bounded/cancellable.
- [ ] Secrets stay outside core/spec/scene.
- [ ] Fake-provider test path exists.

## Web/accessibility
- [ ] Keyboard behavior correct.
- [ ] Reduced motion respected.
- [ ] Errors/status accessible.
- [ ] Meaning not color-only.
- [ ] Shadow DOM isolation preserved.

## Evidence integrity
- [ ] Facts vs interpretations are distinguishable.
- [ ] No unsupported ability/seniority/job-fit claims.
- [ ] User-declared roles remain identifiable as user intent.

## Testing
- [ ] Unit tests.
- [ ] Offline fixtures.
- [ ] Package tests where relevant.
- [ ] Browser tests where relevant.
- [ ] Docs updated.
