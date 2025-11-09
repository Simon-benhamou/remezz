# QuantAILabs Testing Infrastructure

This directory contains the comprehensive testing infrastructure for QuantAILabs, including unit tests, integration tests, end-to-end tests, and example test cases.

## Quick Start

### Backend Tests

```bash
# Install dependencies (if not already done)
cd backend
npm install

# Build the project (required for tests)
npm run build

# Run all backend tests
npm test

# Run specific test suites
npm run test:unit           # Unit tests only
npm run test:integration    # Integration tests only
npm run test:e2e           # E2E tests only

# Run Jest tests (new test framework)
npm run test:jest          # Run Jest tests
npm run test:jest:watch    # Watch mode
npm run test:jest:coverage # With coverage report
```

### Python ML Tests

```bash
# Install Python dependencies
cd backend/python
pip install -r requirements.txt

# Run all Python tests
npm run test:python  # From backend directory
# OR
cd backend/python
pytest

# Run specific test types
pytest -m unit          # Unit tests only
pytest -m integration   # Integration tests only
pytest -m ml           # ML-specific tests

# Run with coverage
pytest --cov=. --cov-report=html
```

### Frontend Tests

```bash
# Install dependencies
cd frontend
npm install

# Run all frontend tests
npm test

# Run in watch mode
npm test -- --watch

# Run with coverage
npm test -- --coverage

# Run E2E tests with Cypress
npm run test:e2e:open  # Interactive mode
npm run test:e2e       # Headless mode
```

## Test Organization

### Backend Tests (`backend/test/`)

```
test/
├── setup.ts                 # Jest setup configuration
├── examples/                # Example test cases for reference
│   └── data-validation.test.ts
├── unit/                    # Unit tests
│   ├── overfitting-detection.spec.ts
│   ├── regime-classification.spec.ts
│   └── ... (120+ unit tests)
├── integration/             # Integration tests
│   └── regime-classification-e2e.spec.ts
├── api/                     # API endpoint tests
│   └── capital.routes.spec.ts
├── capital/                 # Capital management tests
│   ├── capitalManager.spec.ts
│   └── capitalManagerLeverage.spec.ts
├── e2e/                     # End-to-end tests
└── helpers/                 # Test utilities
```

### Python Tests (`backend/python/tests/`)

```
tests/
├── test_prediction_engine.py    # ML prediction tests
├── test_training_workflow.py    # Training pipeline tests
└── test_validation_example.py   # Example validation tests
```

### Frontend Tests (`frontend/`)

```
src/
├── components/__tests__/    # Component tests
├── pages/__tests__/        # Page tests
├── utils/__tests__/        # Utility function tests
└── hooks/__tests__/        # Custom hook tests

cypress/
├── e2e/                    # E2E test specs
│   └── examples/           # Example E2E tests
│       └── agent-creation-flow.cy.ts
└── support/                # Cypress support files
```

## Test Types

### 1. Unit Tests

**Purpose**: Test individual functions and components in isolation.

**Examples**:
- Mathematical calculations (Sharpe ratio, returns, etc.)
- Strategy scoring logic
- Risk calculations
- Data validation functions
- State management

**Running**:
```bash
npm run test:unit  # Backend
npm test          # Frontend
pytest -m unit    # Python
```

### 2. Integration Tests

**Purpose**: Test interactions between components and services.

**Examples**:
- API endpoints with database
- Exchange API integrations (mocked)
- WebSocket communication
- Agent lifecycle management
- Frontend-backend data flow

**Running**:
```bash
npm run test:integration  # Backend
pytest -m integration     # Python
```

### 3. End-to-End Tests

**Purpose**: Test complete user workflows and system behavior.

**Examples**:
- Agent creation workflow
- Strategy optimization process
- Dashboard data display
- Real-time updates
- Error handling flows

**Running**:
```bash
npm run test:e2e          # Backend
npm run test:e2e:open     # Frontend (interactive)
```

## Test Coverage

Current test coverage status:

### Backend
- **Unit Tests**: 120+ test files covering core logic
- **Integration Tests**: API routes, database operations
- **E2E Tests**: Agent lifecycle, strategy execution

### Frontend
- **Component Tests**: 27 passing tests
- **Utility Tests**: Data formatting, calculations
- **E2E Tests**: Example workflows provided

### Python
- **ML Module Tests**: Prediction engine, training workflow
- **Data Validation**: Feature processing, model I/O

## Writing New Tests

### Backend Unit Test Example

```typescript
// test/unit/my-feature.spec.ts
import { describe, it, expect } from '@jest/globals';
import { myFunction } from '../../src/utils/myFeature';

describe('MyFeature', () => {
  it('should handle valid input', () => {
    const result = myFunction('valid input');
    expect(result).toBe('expected output');
  });

  it('should reject invalid input', () => {
    expect(() => myFunction(null)).toThrow();
  });
});
```

### Frontend Component Test Example

```typescript
// src/components/__tests__/MyComponent.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import MyComponent from '../MyComponent';

describe('MyComponent', () => {
  it('renders correctly', () => {
    render(<MyComponent />);
    expect(screen.getByText('Expected Text')).toBeInTheDocument();
  });
});
```

### Python Test Example

```python
# backend/python/tests/test_my_feature.py
import pytest

def test_my_function():
    """Test my function with valid input"""
    result = my_function('input')
    assert result == 'expected'

@pytest.mark.ml
def test_model_prediction():
    """Test ML model prediction"""
    model = MyModel()
    prediction = model.predict([[1, 2, 3, 4]])
    assert prediction in ['buy', 'sell', 'hold']
```

## Test Configuration Files

- **Backend Jest**: `jest.config.js`
- **Backend Custom**: Scripts in `scripts/run-*-tests.mjs`
- **Frontend Vitest**: `vite.config.ts` (vitest config included)
- **Frontend Cypress**: `cypress.config.ts`
- **Python pytest**: `python/pytest.ini`

## Continuous Integration

Tests run automatically on:
- Pull request creation
- Commits to main/development branches
- Before deployments

### GitHub Actions

Configure in `.github/workflows/test.yml`:

```yaml
name: Tests
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '20'
      
      - name: Install & Build
        run: |
          npm install -w backend
          npm run build -w backend
      
      - name: Run Tests
        run: |
          npm run test:unit -w backend
          npm test -w frontend
```

## Best Practices

1. **Write tests first** (Test-Driven Development)
2. **Keep tests isolated** - no shared state
3. **Use descriptive names** - explain what's being tested
4. **Test edge cases** - not just happy paths
5. **Mock external dependencies** - APIs, databases, etc.
6. **Keep tests fast** - unit tests in milliseconds
7. **Clean up resources** - close connections, clear mocks
8. **Maintain tests** - update when code changes

## Troubleshooting

### Tests fail after fresh clone

```bash
# Backend tests need to be built first
cd backend
npm install
npm run build
npm test
```

### Module not found errors

```bash
# Regenerate Prisma client
cd backend
npm run prisma:gen
npm run build
```

### Cypress binary not found

```bash
# Install Cypress manually
cd frontend
npx cypress install
```

### Python tests fail

```bash
# Install Python dependencies
cd backend/python
pip install -r requirements.txt
pytest
```

## Resources

- [Testing Guide](../../docs/TESTING_GUIDE.md) - Comprehensive testing documentation
- [Bug Tracking](../../docs/BUG_TRACKING.md) - Bug management workflow
- [Jest Documentation](https://jestjs.io/)
- [Vitest Documentation](https://vitest.dev/)
- [Cypress Documentation](https://www.cypress.io/)
- [pytest Documentation](https://docs.pytest.org/)

## Contributing

When adding new features:
1. Write tests for new functionality
2. Ensure all tests pass before submitting PR
3. Update test documentation if needed
4. Maintain test coverage above 80% for critical paths

## Getting Help

- Review existing test examples in `test/examples/`
- Check [Testing Guide](../../docs/TESTING_GUIDE.md) for patterns
- Ask in team chat for testing questions
- Create an issue for test infrastructure problems

---

**Last Updated**: November 2025
