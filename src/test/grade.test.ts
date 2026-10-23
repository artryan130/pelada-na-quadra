import { describe, expect, it } from "vitest";
import { fmtMinuto, instante, montarGrade } from "@/lib/grade";

const C = "court-1";
const DIA = "2030-01-08"; // terça-feira
const at = (hhmm: string) => `${DIA}T${hhmm}:00-03:00`;
const base = {
  courtIds: [C],
  dias: [DIA],
  horarios: [{ court_id: C, dia_semana: 2, abre: "08:00:00", fecha: "23:00:00" }],
  reservas: [],
  bloqueios: [],
  mensalistas: [],
  fila: [],
  agora: Date.parse("2030-01-01T00:00:00Z"),
};
const porMinuto = (cells: ReturnType<typeof montarGrade>) =>
  Object.fromEntries(cells.map((c) => [fmtMinuto(c.minuto), c]));

describe("grade do gestor em blocos de 30 min", () => {
  it("cria um bloco a cada meia hora do funcionamento", () => {
    const cells = montarGrade(base);
    expect(cells).toHaveLength(30); // 08:00 … 22:30
    expect(cells[0]!.inicio).toBe(new Date(at("08:00")).toISOString());
    expect(fmtMinuto(cells.at(-1)!.minuto)).toBe("22:30");
  });

  it("reserva de 1h30 às 20:30 ocupa 20:30, 21:00 e 21:30", () => {
    const g = porMinuto(
      montarGrade({
        ...base,
        reservas: [
          {
            court_id: C,
            status: "pendente",
            starts_at: at("20:30"),
            ends_at: at("22:00"),
            expires_at: "2999-01-01T00:00:00Z",
          },
        ],
      }),
    );
    expect(g["20:00"]!.estado).toBe("livre");
    expect(["20:30", "21:00", "21:30"].map((h) => g[h]!.estado)).toEqual([
      "pendente",
      "pendente",
      "pendente",
    ]);
    expect(g["22:00"]!.estado).toBe("livre");
  });

  it("ignora pendente vencida e mostra bloqueio, mensalista e fila", () => {
    const g = porMinuto(
      montarGrade({
        ...base,
        reservas: [
          {
            court_id: C,
            status: "pendente",
            starts_at: at("10:00"),
            ends_at: at("11:00"),
            expires_at: "2020-01-01T00:00:00Z",
          },
        ],
        bloqueios: [{ court_id: C, starts_at: at("18:00"), ends_at: at("18:30"), nota: "Aula" }],
        mensalistas: [
          {
            court_id: C,
            dia_semana: 2,
            inicio: "09:00:00",
            fim: "10:00:00",
            nome: "Fixos",
            valido_de: "2029-01-01",
            valido_ate: null,
          },
        ],
        fila: [{ court_id: C, starts_at: at("18:00"), ends_at: at("19:00") }],
      }),
    );
    expect(g["10:00"]!.estado).toBe("livre");
    expect(g["18:00"]).toMatchObject({ estado: "bloqueado", nota: "Aula", fila: 1 });
    expect(g["18:30"]).toMatchObject({ estado: "livre", fila: 1 });
    expect(g["9:30"]).toMatchObject({ estado: "mensalista", nota: "Fixos" });
  });

  it("aceita fechar às 24:00 e meia hora quebrada na abertura", () => {
    const cells = montarGrade({
      ...base,
      horarios: [{ court_id: C, dia_semana: 2, abre: "18:30:00", fecha: "24:00:00" }],
    });
    expect(fmtMinuto(cells[0]!.minuto)).toBe("18:30");
    expect(fmtMinuto(cells.at(-1)!.minuto)).toBe("23:30");
  });

  it("converte dia + minutos para o horário de Brasília", () => {
    expect(instante("2030-01-08", 20 * 60 + 30)).toBe("2030-01-08T23:30:00.000Z");
  });
});
