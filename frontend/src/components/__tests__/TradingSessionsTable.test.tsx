import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import TradingSessionsTable from "../TradingSessionsTable";

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
  delete (window as unknown as { matchMedia?: unknown }).matchMedia;
  delete (window as unknown as { ResizeObserver?: unknown }).ResizeObserver;
});

describe("TradingSessionsTable", () => {
  it("filters sessions and auto-expands in advanced mode", async () => {
    render(<TradingSessionsTable />);

    expect(await screen.findByText("Helios-Delta")).toBeInTheDocument();

    const search = screen.getByPlaceholderText("Search");
    fireEvent.change(search, { target: { value: "Nova" } });

    await waitFor(() => {
      expect(screen.getByText("Nova-Spiral")).toBeInTheDocument();
      expect(screen.queryByText("Helios-Delta")).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /reset filters/i }));

    fireEvent.click(screen.getByRole("radio", { name: "Mode avancé" }));

    expect(await screen.findByText("Circuit breaker cool-down")).toBeInTheDocument();
  });
});
