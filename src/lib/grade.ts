// Builds the gestor's week grid in 30-minute blocks from the raw schedule rows.
// Mirrors the rules of public.disponibilidade_quadra (Brasília time, fecha may be 24:00).

export const BLOCO_MS = 30 * 60_000;

export type Estado = "livre" | "bloqueado" | "mensalista" | "pendente" | "confirmada";

export type Celula = {
  court_id: string;
  dia: string;
  minuto: number;
  inicio: string;
  estado: Estado;
  booking_inicio: string | null;
  booking_fim: string | null;
  nota: string | null;
  fila: number;
};

type Horario = { court_id: string; dia_semana: number; abre: string; fecha: string };
type Reserva = {
  court_id: string;
  status: string;
  starts_at: string;
  ends_at: string;
  expires_at: string;
};
type Bloqueio = { court_id: string; starts_at: string; ends_at: string; nota: string | null };
type Mensalista = {
  court_id: string;
  dia_semana: number;
  inicio: string;
  fim: string;
  nome: string;
  valido_de: string;
  valido_ate: string | null;
};
type Fila = { court_id: string; starts_at: string; ends_at: string };

export const minutosDe = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

export function fmtMinuto(m: number): string {
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
}

/** ISO instant of a Brasília calendar day plus minutes since midnight. */
export function instante(dia: string, minuto: number): string {
  const hh = String(Math.floor(minuto / 60)).padStart(2, "0");
  const mm = String(minuto % 60).padStart(2, "0");
  return new Date(`${dia}T${hh}:${mm}:00-03:00`).toISOString();
}

const toca = (a: { starts_at: string; ends_at: string }, ini: number, fim: number) =>
  Date.parse(a.starts_at) < fim && Date.parse(a.ends_at) > ini;

export function montarGrade(input: {
  courtIds: string[];
  dias: string[];
  horarios: Horario[];
  reservas: Reserva[];
  bloqueios: Bloqueio[];
  mensalistas: Mensalista[];
  fila: Fila[];
  agora?: number;
}): Celula[] {
  const agora = input.agora ?? Date.now();
  const ativas = input.reservas.filter(
    (r) =>
      r.status === "confirmada" || (r.status === "pendente" && Date.parse(r.expires_at) > agora),
  );
  const out: Celula[] = [];
  for (const courtId of input.courtIds) {
    for (const dia of input.dias) {
      const dow = new Date(dia + "T12:00:00Z").getUTCDay();
      const abertos = input.horarios.filter((h) => h.court_id === courtId && h.dia_semana === dow);
      for (let m = 0; m < 24 * 60; m += 30) {
        if (!abertos.some((h) => minutosDe(h.abre) <= m && m + 30 <= minutosDe(h.fecha))) continue;
        const inicio = instante(dia, m);
        const ini = Date.parse(inicio);
        const fim = ini + BLOCO_MS;
        const reserva = ativas
          .filter((r) => r.court_id === courtId && toca(r, ini, fim))
          .sort((a, b) => (a.status === "confirmada" ? -1 : b.status === "confirmada" ? 1 : 0))[0];
        const bloqueio = input.bloqueios.find((b) => b.court_id === courtId && toca(b, ini, fim));
        const mensalista = input.mensalistas.find(
          (x) =>
            x.court_id === courtId &&
            x.dia_semana === dow &&
            minutosDe(x.inicio) < m + 30 &&
            minutosDe(x.fim) > m &&
            x.valido_de <= dia &&
            (!x.valido_ate || x.valido_ate >= dia),
        );
        const estado: Estado = reserva
          ? (reserva.status as "pendente" | "confirmada")
          : bloqueio
            ? "bloqueado"
            : mensalista
              ? "mensalista"
              : "livre";
        out.push({
          court_id: courtId,
          dia,
          minuto: m,
          inicio,
          estado,
          booking_inicio: reserva?.starts_at ?? null,
          booking_fim: reserva?.ends_at ?? null,
          nota: bloqueio?.nota ?? (mensalista?.nome || null),
          fila: input.fila.filter((f) => f.court_id === courtId && toca(f, ini, fim)).length,
        });
      }
    }
  }
  return out;
}
