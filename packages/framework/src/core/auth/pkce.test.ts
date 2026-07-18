import { test, expect } from "bun:test";
import { generateCodeVerifier, codeChallenge } from "./pkce";

test("generateCodeVerifier is base64url and unique per call", () => {
  const v = generateCodeVerifier();
  expect(v).toMatch(/^[A-Za-z0-9_-]+$/); // base64url, no padding
  expect(v.length).toBeGreaterThanOrEqual(43); // RFC 7636 minimum
  expect(generateCodeVerifier()).not.toBe(v);
});

test("codeChallenge matches the RFC 7636 Appendix B S256 test vector", async () => {
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  expect(await codeChallenge(verifier)).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
});
