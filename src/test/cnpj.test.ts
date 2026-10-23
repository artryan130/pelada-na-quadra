import { describe, expect, it } from "vitest";
import { formatCnpj, isValidCnpj, normalizeCnpj } from "@/lib/cnpj";

describe("CNPJ", () => {
  it("accepts valid numeric CNPJs, with or without punctuation", () => {
    expect(isValidCnpj("11.222.333/0001-81")).toBe(true);
    expect(isValidCnpj("11222333000181")).toBe(true);
  });

  it("accepts the alphanumeric format (Receita's example)", () => {
    expect(isValidCnpj("12.ABC.345/01DE-35")).toBe(true);
    expect(isValidCnpj("12abc34501de35")).toBe(true);
  });

  it("rejects wrong check digits, wrong lengths and repeated characters", () => {
    expect(isValidCnpj("11.222.333/0001-82")).toBe(false);
    expect(isValidCnpj("12.ABC.345/01DE-36")).toBe(false);
    expect(isValidCnpj("1122233300018")).toBe(false);
    expect(isValidCnpj("00.000.000/0000-00")).toBe(false);
    expect(isValidCnpj("12.ABC.345/01DE-3A")).toBe(false);
    expect(isValidCnpj("")).toBe(false);
  });

  it("normalizes and formats", () => {
    expect(normalizeCnpj("12.abc.345/01de-35")).toBe("12ABC34501DE35");
    expect(formatCnpj("11222333000181")).toBe("11.222.333/0001-81");
    expect(formatCnpj("12abc")).toBe("12.ABC");
  });
});
