---
name: Test Failure Report
about: Report a failing test case
title: '[TEST FAILURE] '
labels: bug, test-failure, needs-triage
assignees: ''
---

## Test Information

- **Test Type**: [Unit / Integration / E2E]
- **Test File**: [e.g., `backend/test/unit/strategy.spec.ts`]
- **Test Name**: [e.g., "should calculate correct position size"]
- **Component**: [Backend / Frontend / Python]

## Failure Description

A clear description of the test failure.

## Test Output

```
[Paste the full test output/error message here]
```

## Steps to Reproduce

```bash
# Commands to reproduce the failure
cd backend
npm run test:unit -- path/to/failing-test.spec.ts
```

## Expected Behavior

What should the test verify and what result is expected?

## Actual Behavior

What is the test actually doing and what unexpected result is occurring?

## Environment

- **OS**: [e.g., Ubuntu 22.04]
- **Node Version**: [e.g., v20.11.0]
- **Python Version** (if applicable): [e.g., 3.12.3]
- **Commit Hash**: [e.g., abc123def]

## Failure Consistency

- [ ] Fails consistently every time
- [ ] Fails intermittently
- [ ] Fails only in specific environments
- [ ] Fails only in CI/CD

## Impact

- [ ] **Blocking** - Prevents merging/deployment
- [ ] **High** - Critical test coverage lost
- [ ] **Medium** - Important test but workaround exists
- [ ] **Low** - Minor test or edge case

## Additional Context

Any other information that might help diagnose the issue (recent changes, environment differences, etc.).

## Related Issues

Link to any related issues: #123
