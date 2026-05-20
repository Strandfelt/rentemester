// Vitest global setup — adds jest-dom matchers and resets DOM/mocks between
// tests so each spec runs against a clean slate.
import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
