import { describe, expect, it } from "vitest";
import { decrypt, encrypt } from "../src/core/crypto.js";

describe("secret encryption", () => {
  it("round-trips and never stores plaintext when SECRET_KEY is set", () => {
    const stored = encrypt("sk-ant-very-secret");
    expect(stored.startsWith("v1:")).toBe(true);
    expect(stored).not.toContain("very-secret");
    expect(decrypt(stored)).toBe("sk-ant-very-secret");
  });

  it("uses a fresh IV each time", () => {
    expect(encrypt("x")).not.toBe(encrypt("x"));
  });

  it("detects tampering", () => {
    const [v, iv, tag, data] = encrypt("hello").split(":");
    const flipped = Buffer.from(data!, "base64");
    flipped[0] = flipped[0]! ^ 1;
    expect(() => decrypt([v, iv, tag, flipped.toString("base64")].join(":"))).toThrow();
  });

  it("still reads values stored without a key", () => {
    expect(decrypt(`plain:${Buffer.from("legacy").toString("base64")}`)).toBe("legacy");
  });
});
