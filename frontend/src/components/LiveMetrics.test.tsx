import { render, screen } from '@testing-library/react';
import LiveMetrics from './LiveMetrics';

const baseTicker = {
  last: 100,
  bid: 99,
  ask: 101,
  percentage: 1.2,
  baseVolume: 1000,
  quoteVolume: 100000,
  high: 105,
  low: 95,
};

describe('LiveMetrics component', () => {
  it('renders loading state', () => {
    render(<LiveMetrics status="loading" />);
    expect(screen.getByText(/Loading market data/i)).toBeInTheDocument();
  });

  it('renders error state', () => {
    render(<LiveMetrics status="error" errorMessage="Ticker unavailable" />);
    expect(screen.getByText(/Ticker unavailable/)).toBeInTheDocument();
  });

  it('renders stale warning', () => {
    render(<LiveMetrics status="stale" ticker={baseTicker} />);
    expect(screen.getByText(/Market data marked stale/)).toBeInTheDocument();
  });

  it('renders live metrics', () => {
    render(<LiveMetrics status="live" symbol="BTC/USDT" ticker={baseTicker} />);
    expect(screen.getByText('BTC/USDT')).toBeInTheDocument();
    expect(screen.getByText(/\$100\.00/)).toBeInTheDocument();
  });
});
