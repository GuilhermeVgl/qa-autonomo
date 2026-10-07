import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// vitest sem `globals`: o cleanup automático do Testing Library não se registra sozinho.
afterEach(cleanup);
