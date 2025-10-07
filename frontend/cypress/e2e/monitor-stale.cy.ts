describe('Monitor page ticker states', () => {
  it('shows error badge when ticker API returns 502', () => {
    cy.intercept('POST', '/api/market/ticker', {
      statusCode: 502,
      body: { error: 'ticker_unavailable', details: 'ticker_validation_failed' },
    }).as('ticker');

    cy.visit('/monitor/cmggwt4040013grlov4myatn2'); // sample session id

    cy.contains(/Loading session data/i).should('exist');
    cy.wait('@ticker');
    cy.contains(/Live ticker unavailable/i).should('exist');
  });
});
