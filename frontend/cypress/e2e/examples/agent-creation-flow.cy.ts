/**
 * Example E2E Test - Agent Creation Flow
 * 
 * This test demonstrates a complete user workflow for creating a trading agent.
 * It verifies the UI interactions and data flow from frontend to backend.
 * 
 * NOTE: This is an example test. Update selectors and assertions based on actual UI.
 */

describe('Agent Creation Flow', () => {
  beforeEach(() => {
    // Visit the application
    cy.visit('/');
    
    // In a real scenario, you might need to login first
    // cy.login('testuser@example.com', 'password123');
  });

  it('should successfully create a new trading agent', () => {
    // Step 1: Navigate to agent creation page
    cy.get('[data-testid="create-agent-button"]', { timeout: 10000 })
      .should('be.visible')
      .click();

    // Step 2: Verify we're on the agent creation form
    cy.url().should('include', '/agents/create');
    cy.contains('Create New Agent').should('be.visible');

    // Step 3: Fill in agent details
    cy.get('[data-testid="agent-name-input"]')
      .should('be.visible')
      .type('Test Agent BTC');

    // Select trading symbol
    cy.get('[data-testid="symbol-select"]')
      .click();
    cy.contains('BTC/USDT').click();

    // Select strategy
    cy.get('[data-testid="strategy-select"]')
      .click();
    cy.contains('Meta Adaptive').click();

    // Set initial capital
    cy.get('[data-testid="capital-input"]')
      .clear()
      .type('1000');

    // Set risk parameters (optional)
    cy.get('[data-testid="max-position-size"]')
      .clear()
      .type('0.1');

    // Step 4: Submit the form
    cy.get('[data-testid="create-agent-submit"]')
      .should('not.be.disabled')
      .click();

    // Step 5: Verify success
    cy.contains('Agent created successfully', { timeout: 10000 })
      .should('be.visible');

    // Step 6: Verify agent appears in the list
    cy.url().should('include', '/agents');
    cy.contains('Test Agent BTC').should('be.visible');
    cy.contains('BTC/USDT').should('be.visible');
    cy.contains('Meta Adaptive').should('be.visible');
  });

  it('should show validation errors for invalid inputs', () => {
    // Navigate to create form
    cy.get('[data-testid="create-agent-button"]')
      .should('be.visible')
      .click();

    // Try to submit without filling required fields
    cy.get('[data-testid="create-agent-submit"]')
      .click();

    // Verify validation errors are displayed
    cy.contains('Agent name is required').should('be.visible');
    cy.contains('Symbol is required').should('be.visible');
    cy.contains('Strategy is required').should('be.visible');
    cy.contains('Initial capital is required').should('be.visible');
  });

  it('should validate capital amount constraints', () => {
    cy.get('[data-testid="create-agent-button"]').click();

    // Test minimum capital validation
    cy.get('[data-testid="capital-input"]')
      .type('10');
    
    cy.get('[data-testid="create-agent-submit"]').click();
    
    cy.contains('Capital must be at least $100').should('be.visible');

    // Test maximum capital validation
    cy.get('[data-testid="capital-input"]')
      .clear()
      .type('10000000');
    
    cy.get('[data-testid="create-agent-submit"]').click();
    
    cy.contains('Capital exceeds maximum allowed').should('be.visible');
  });

  it('should allow canceling agent creation', () => {
    cy.get('[data-testid="create-agent-button"]').click();

    // Fill in some data
    cy.get('[data-testid="agent-name-input"]').type('Canceled Agent');
    cy.get('[data-testid="capital-input"]').type('500');

    // Click cancel
    cy.get('[data-testid="cancel-button"]').click();

    // Verify we're back at agents list
    cy.url().should('match', /\/agents\/?$/);
    
    // Verify agent was not created
    cy.contains('Canceled Agent').should('not.exist');
  });
});

describe('Agent Management', () => {
  beforeEach(() => {
    cy.visit('/agents');
  });

  it('should display existing agents', () => {
    // Verify agents table is visible
    cy.get('[data-testid="agents-table"]')
      .should('be.visible');

    // Check for table headers
    cy.contains('Agent Name').should('be.visible');
    cy.contains('Symbol').should('be.visible');
    cy.contains('Strategy').should('be.visible');
    cy.contains('Status').should('be.visible');
    cy.contains('P&L').should('be.visible');
  });

  it('should filter agents by status', () => {
    // Click active filter
    cy.get('[data-testid="filter-active"]').click();
    
    // Verify only active agents are shown
    cy.get('[data-testid="agent-status"]').each(($el) => {
      cy.wrap($el).should('contain', 'Active');
    });

    // Click stopped filter
    cy.get('[data-testid="filter-stopped"]').click();
    
    // Verify only stopped agents are shown
    cy.get('[data-testid="agent-status"]').each(($el) => {
      cy.wrap($el).should('contain', 'Stopped');
    });
  });

  it('should navigate to agent details on click', () => {
    // Click on first agent row
    cy.get('[data-testid="agent-row"]')
      .first()
      .click();

    // Verify we're on agent details page
    cy.url().should('match', /\/agents\/[a-zA-Z0-9]+$/);
    
    // Verify details are displayed
    cy.contains('Agent Details').should('be.visible');
    cy.get('[data-testid="performance-chart"]').should('be.visible');
  });
});

describe('Strategy Optimizer E2E', () => {
  beforeEach(() => {
    cy.visit('/');
  });

  it('should complete strategy optimization workflow', () => {
    // Navigate to optimizer
    cy.get('[data-testid="nav-optimizer"]').click();
    cy.url().should('include', '/optimizer');

    // Select symbol
    cy.get('[data-testid="optimizer-symbol"]')
      .click();
    cy.contains('BTC/USDT').click();

    // Select strategy to optimize
    cy.get('[data-testid="optimizer-strategy"]')
      .click();
    cy.contains('Meta Adaptive').click();

    // Set optimization parameters
    cy.get('[data-testid="optimizer-trials"]')
      .clear()
      .type('10');

    cy.get('[data-testid="optimizer-timeframe"]')
      .click();
    cy.contains('1 Month').click();

    // Start optimization
    cy.get('[data-testid="start-optimization"]')
      .click();

    // Wait for optimization to complete
    cy.contains('Optimization in progress', { timeout: 5000 })
      .should('be.visible');

    // Verify results are displayed (may take time)
    cy.contains('Optimization Results', { timeout: 60000 })
      .should('be.visible');

    cy.get('[data-testid="best-parameters"]')
      .should('be.visible');

    cy.get('[data-testid="performance-improvement"]')
      .should('be.visible');
  });
});
