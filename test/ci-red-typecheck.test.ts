import { expect, it } from "vitest";
const n: number = "not a number";
it("passes at run time", () => { expect(typeof n).toBe("string"); });
