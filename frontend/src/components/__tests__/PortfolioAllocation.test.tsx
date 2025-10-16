import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import PortfolioAllocation from "../PortfolioAllocation";

beforeAll(() => {
  if (typeof window.matchMedia !== "function") {
    window.matchMedia = () => ({
      matches: false,
      media: "",
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    });
  }
  if (typeof window.ResizeObserver === "undefined") {
    class ResizeObserverPolyfill {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    window.ResizeObserver = ResizeObserverPolyfill as unknown as typeof ResizeObserver;
  }
});

afterAll(() => {
  // Reset polyfills for subsequent tests
  delete (window as unknown as { matchMedia?: unknown }).matchMedia;
  delete (window as unknown as { ResizeObserver?: unknown }).ResizeObserver;
});

describe("PortfolioAllocation", () => {
  it("renders KPIs and updates paper balance", () => {
    render(<PortfolioAllocation />);

    expect(screen.getByText("$250,000.00")).toBeInTheDocument();
    expect(screen.getByText("BTC")).toBeInTheDocument();

    const input = screen.getByLabelText("Paper balance") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "300000" } });
    fireEvent.click(screen.getByRole("button", { name: /update/i }));

    expect(screen.getByText("$300,000.00")).toBeInTheDocument();
  });
});
