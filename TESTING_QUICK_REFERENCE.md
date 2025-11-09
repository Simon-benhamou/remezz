# Testing Quick Reference

## Running Tests

### Backend
```bash
cd backend

# Build first (required for most tests)
npm run build

# All tests
npm test

# Unit tests only
npm run test:unit

# Integration tests only
npm run test:integration

# E2E tests only
npm run test:e2e

# Jest tests (after installing dependencies)
npm install  # Install Jest if not already done
npm run test:jest
npm run test:jest:watch     # Watch mode
npm run test:jest:coverage  # With coverage
```

### Python
```bash
cd backend/python

# Install dependencies first
pip install -r requirements.txt

# All tests
pytest

# From backend directory
cd ../
npm run test:python

# Unit tests only
npm run test:python:unit

# Integration tests only
npm run test:python:integration

# With coverage
npm run test:python:coverage
```

### Frontend
```bash
cd frontend

# All tests
npm test

# Watch mode
npm test -- --watch

# With coverage
npm test -- --coverage

# E2E tests (Cypress)
npm run test:e2e:open   # Interactive
npm run test:e2e        # Headless
```

## Test Structure

```
Backend:
  test/unit/          - Unit tests (120+ files)
  test/integration/   - Integration tests
  test/api/          - API tests
  test/e2e/          - End-to-end tests
  test/examples/     - Example tests (reference)

Frontend:
  src/components/__tests__/  - Component tests
  src/pages/__tests__/       - Page tests
  src/utils/__tests__/       - Utility tests
  cypress/e2e/               - E2E tests

Python:
  backend/python/tests/  - All Python tests
```

## Common Commands

### Check Test Status
```bash
# Backend build status
cd backend && npm run build

# Run quick smoke test
npm run test:unit 2>&1 | grep -E "(passed|failed)"

# Frontend test status
cd frontend && npm test -- --run
```

### Install All Dependencies
```bash
# Backend
cd backend
npm install

# Frontend
cd frontend
npm install

# Python
cd backend/python
pip install -r requirements.txt
```

### Run Full Test Suite
```bash
# From root
npm run test -w backend
npm test -w frontend
npm run test:python -w backend
```

## Test Examples Location

- **Data Validation**: `backend/test/examples/data-validation.test.ts`
- **E2E Workflows**: `frontend/cypress/e2e/examples/agent-creation-flow.cy.ts`
- **Python ML**: `backend/python/tests/test_validation_example.py`

## Documentation

- **Full Guide**: `docs/TESTING_GUIDE.md`
- **Bug Tracking**: `docs/BUG_TRACKING.md`
- **Implementation Summary**: `docs/TESTING_IMPLEMENTATION_SUMMARY.md`
- **Test README**: `backend/test/README.md`

## Troubleshooting

### "Module not found" errors
```bash
cd backend
npm install
npm run build
```

### Python tests fail
```bash
cd backend/python
pip install -r requirements.txt
```

### Cypress binary not found
```bash
cd frontend
npx cypress install
```

### Tests pass locally but fail in CI
- Check Node.js version (should be 20.x)
- Check Python version (should be 3.11+)
- Verify all dependencies are in package.json/requirements.txt

## Quick Testing Checklist

Before committing:
- [ ] Run relevant tests locally
- [ ] All tests pass
- [ ] New features have tests
- [ ] Tests are documented

Before PR:
- [ ] All tests pass
- [ ] Coverage maintained/improved
- [ ] Tests reviewed
- [ ] CI/CD passes

## Need Help?

1. Check `docs/TESTING_GUIDE.md` for comprehensive info
2. Review example tests in `test/examples/`
3. Ask in team chat
4. Create GitHub issue for infrastructure problems
