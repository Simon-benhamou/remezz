# Testing Infrastructure Guide

## Overview

QuantAILabs implements a comprehensive multi-layered testing strategy to ensure reliability, correctness, and quality of the trading platform. This document outlines the testing infrastructure, protocols, and best practices.

## Testing Layers

### 1. Unit Testing

**Purpose**: Validate individual components, functions, and classes in isolation.

**Frameworks**:
- **Backend (TypeScript)**: Custom test runners (`tsx`) for existing tests, Jest for new tests
- **Frontend (TypeScript/React)**: Vitest with React Testing Library
- **Python (ML Modules)**: pytest

**What to Test**:
- Mathematical calculations and transformations
- Logical conditions and business rules
- Data validation and sanitization
- Utility functions
- Strategy scoring and decision logic
- Risk calculations
- State management

**Running Tests**:

```bash
# Backend unit tests
cd backend
npm run test:unit

# Frontend unit tests  
cd frontend
npm test

# Python unit tests
cd backend/python
pytest -m unit
```

### 2. Integration Testing

**Purpose**: Test interactions between components, modules, and external services.

**What to Test**:
- API endpoint integration
- Database operations with Prisma
- Exchange API interactions (mocked)
- WebSocket connections
- Frontend-Backend communication
- Service layer interactions
- Agent lifecycle management

**Running Tests**:

```bash
# Backend integration tests
cd backend
npm run test:integration

# Python integration tests
cd backend/python
pytest -m integration
```

### 3. End-to-End (E2E) Testing

**Purpose**: Simulate real user workflows and verify complete system behavior.

**Frameworks**:
- **Frontend**: Cypress
- **Backend**: Custom E2E test scripts

**What to Test**:
- User authentication flows
- Agent creation and configuration
- Strategy execution workflows
- Dashboard data display
- Real-time updates via WebSocket
- Error handling and recovery
- Adaptive meta strategy execution
- Strategy optimizer workflows

**Running Tests**:

```bash
# Backend E2E tests
cd backend
npm run test:e2e

# Frontend E2E tests (interactive)
cd frontend
npm run test:e2e:open

# Frontend E2E tests (headless)
cd frontend
npm run test:e2e
```

### 4. Data & Logic Validation

**Purpose**: Ensure data integrity and correctness of trading logic.

**What to Validate**:
- Input data format and constraints
- Backtesting results accuracy
- Strategy parameter bounds
- Trade execution logic
- Risk limit enforcement
- Performance metric calculations
- Market regime classification

**Example Tests**:
- `backend/test/api-data-validation.test.ts`
- `backend/test/unit/overfitting-detection.spec.ts`
- `backend/test/unit/regime-classification.spec.ts`

## Test Structure

### Backend Test Organization

```
backend/
├── test/
│   ├── setup.ts                 # Jest setup file
│   ├── unit/                    # Unit tests
│   │   ├── *.spec.ts
│   │   └── *.test.ts
│   ├── integration/             # Integration tests
│   │   ├── *.spec.ts
│   │   └── *.test.ts
│   ├── e2e/                     # End-to-end tests
│   ├── api/                     # API route tests
│   ├── capital/                 # Capital management tests
│   ├── helpers/                 # Test utilities
│   └── performance/             # Performance tests
├── jest.config.js               # Jest configuration
└── python/
    ├── tests/                   # Python tests
    │   ├── test_*.py
    │   └── conftest.py
    ├── pytest.ini               # Pytest configuration
    └── requirements.txt         # Python dependencies
```

### Frontend Test Organization

```
frontend/
├── src/
│   ├── components/
│   │   └── __tests__/          # Component tests
│   ├── pages/
│   │   └── __tests__/          # Page tests
│   ├── utils/
│   │   └── __tests__/          # Utility tests
│   └── hooks/
│       └── __tests__/          # Hook tests
├── cypress/                     # E2E tests
│   ├── e2e/                    # Test specs
│   └── support/                # Cypress support files
└── cypress.config.ts           # Cypress configuration
```

## Writing Tests

### Unit Test Example (Backend)

```typescript
// test/unit/example.spec.ts
import { describe, it, expect } from '@jest/globals';
import { calculateSharpeRatio } from '../../src/utils/metrics';

describe('calculateSharpeRatio', () => {
  it('should calculate Sharpe ratio correctly', () => {
    const returns = [0.01, 0.02, -0.01, 0.03];
    const riskFreeRate = 0.0;
    
    const sharpe = calculateSharpeRatio(returns, riskFreeRate);
    
    expect(sharpe).toBeCloseTo(1.5, 1);
  });

  it('should handle empty returns array', () => {
    const sharpe = calculateSharpeRatio([], 0.0);
    expect(sharpe).toBe(0);
  });
});
```

### Integration Test Example (Backend)

```typescript
// test/integration/api-example.spec.ts
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import request from 'supertest';
import app from '../../src/app';

describe('Agent API Integration', () => {
  let server: any;

  beforeAll(async () => {
    server = app.listen(0);
  });

  afterAll(async () => {
    await server.close();
  });

  it('should create a new agent', async () => {
    const response = await request(app)
      .post('/api/agents')
      .send({
        symbol: 'BTC/USDT',
        strategy: 'metaAdaptive',
        capital: 1000,
      });

    expect(response.status).toBe(201);
    expect(response.body).toHaveProperty('agentId');
  });
});
```

### Component Test Example (Frontend)

```typescript
// src/components/__tests__/Example.test.tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import ExampleComponent from '../ExampleComponent';

describe('ExampleComponent', () => {
  it('renders and handles interaction', () => {
    render(<ExampleComponent />);
    
    const button = screen.getByRole('button', { name: /click me/i });
    fireEvent.click(button);
    
    expect(screen.getByText(/clicked/i)).toBeInTheDocument();
  });
});
```

### E2E Test Example (Cypress)

```typescript
// cypress/e2e/agent-creation.cy.ts
describe('Agent Creation Flow', () => {
  beforeEach(() => {
    cy.visit('/');
    cy.login(); // Custom command
  });

  it('creates a new trading agent', () => {
    cy.get('[data-testid="create-agent-btn"]').click();
    cy.get('[data-testid="symbol-select"]').select('BTC/USDT');
    cy.get('[data-testid="strategy-select"]').select('metaAdaptive');
    cy.get('[data-testid="capital-input"]').type('1000');
    cy.get('[data-testid="submit-btn"]').click();
    
    cy.contains('Agent created successfully').should('be.visible');
  });
});
```

### Python Test Example

```python
# backend/python/tests/test_example.py
import pytest
from prediction_engine import PredictionEngine

class TestPredictionEngine:
    def test_prediction_output_shape(self):
        """Test that predictions have correct shape"""
        engine = PredictionEngine()
        features = [[1.0, 2.0, 3.0, 4.0]]
        
        predictions = engine.predict(features)
        
        assert len(predictions) == 1
        assert predictions[0] in ['buy', 'sell', 'hold']
    
    @pytest.mark.ml
    def test_model_confidence_threshold(self):
        """Test confidence threshold filtering"""
        engine = PredictionEngine(confidence_threshold=0.7)
        features = [[1.0, 2.0, 3.0, 4.0]]
        
        predictions, confidences = engine.predict_with_confidence(features)
        
        assert all(c >= 0.7 for c in confidences if predictions != 'hold')
```

## Test Coverage

### Running Coverage Reports

```bash
# Backend coverage (Jest)
cd backend
npm run test:coverage  # Add this script to package.json

# Frontend coverage
cd frontend
npm run test -- --coverage

# Python coverage
cd backend/python
pytest --cov=. --cov-report=html
```

### Coverage Goals

- **Unit Tests**: Aim for 80%+ coverage on core business logic
- **Integration Tests**: Cover all critical API endpoints and service interactions
- **E2E Tests**: Cover primary user workflows and happy paths

## Continuous Integration

Tests should run automatically on:
- Pull request creation
- Commits to main/development branches
- Before deployments

### GitHub Actions Workflow Example

```yaml
name: Test Suite
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '20'
      
      - name: Install dependencies
        run: |
          npm install -w backend
          npm install -w frontend
      
      - name: Build backend
        run: npm run build -w backend
      
      - name: Run backend tests
        run: npm test -w backend
      
      - name: Run frontend tests
        run: npm test -w frontend
```

## Best Practices

### General
1. **Write tests first** (TDD) when possible
2. **Keep tests isolated** - no shared state between tests
3. **Use descriptive test names** that explain what is being tested
4. **Test edge cases** and error conditions, not just happy paths
5. **Mock external dependencies** (APIs, databases) in unit tests
6. **Keep tests fast** - unit tests should complete in milliseconds

### Backend Specific
1. **Test business logic separately** from infrastructure
2. **Use factories** for test data generation
3. **Test async code properly** with async/await
4. **Clean up resources** in afterEach/afterAll hooks
5. **Use environment variables** for test configuration

### Frontend Specific
1. **Test user behavior**, not implementation details
2. **Use semantic queries** (getByRole, getByLabelText)
3. **Avoid snapshot tests** for rapidly changing UI
4. **Test accessibility** with aria-label checks
5. **Mock API calls** consistently

### Python Specific
1. **Use fixtures** for reusable test setup
2. **Parametrize tests** for multiple input scenarios
3. **Test ML models** with known inputs/outputs
4. **Separate training tests** from inference tests
5. **Mock expensive operations** (model loading, training)

## Debugging Tests

### Failed Tests
```bash
# Run specific test file
npm test -- path/to/test.spec.ts

# Run tests matching pattern
npm test -- --testNamePattern="should calculate"

# Run with verbose output
npm test -- --verbose

# Run in watch mode
npm test -- --watch
```

### Using Debugger
```bash
# Backend (Node.js)
node --inspect-brk node_modules/.bin/jest --runInBand

# Frontend
npm test -- --no-coverage
```

## Test Maintenance

### Regular Activities
1. **Review and update tests** when requirements change
2. **Remove obsolete tests** for deprecated features
3. **Refactor tests** to reduce duplication
4. **Update test data** to reflect current market conditions
5. **Monitor test execution time** and optimize slow tests

### When to Write Tests
- **Always** for bug fixes (regression tests)
- **Before** implementing new features (TDD)
- **After** refactoring to ensure behavior unchanged
- **When** adding new API endpoints
- **For** critical calculation logic

## Resources

- [Jest Documentation](https://jestjs.io/)
- [Vitest Documentation](https://vitest.dev/)
- [Cypress Documentation](https://www.cypress.io/)
- [pytest Documentation](https://docs.pytest.org/)
- [React Testing Library](https://testing-library.com/react)

## Getting Help

For questions about testing:
1. Check this documentation
2. Review existing test examples in the codebase
3. Ask in team chat or create a GitHub discussion
4. Refer to framework-specific documentation

---

**Remember**: Good tests are an investment in code quality and team velocity. They catch bugs early, enable confident refactoring, and serve as living documentation.
