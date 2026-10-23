import { describe, expect, it } from "vitest";
import { acharBairro, chaveBairro, fmtDuracao, fmtKm } from "@/lib/busca";

describe("busca utils", () => {
  it("compara bairros sem acento nem maiúscula", () => {
    expect(chaveBairro("  São Bento ")).toBe("sao bento");
    const bairros = [{ nome: "Funcionários", lat: -19.93, lng: -43.93 }];
    expect(acharBairro(bairros, "funcionarios")?.nome).toBe("Funcionários");
    expect(acharBairro(bairros, "")).toBeUndefined();
  });

  it("formata duração e distância", () => {
    expect(fmtDuracao(90)).toBe("1h30");
    expect(fmtDuracao(120)).toBe("2h");
    expect(fmtKm(0.42)).toBe("420 m");
    expect(fmtKm(2.25)).toBe("2,3 km");
    expect(fmtKm(null)).toBeNull();
  });
});
