// All times follow Brasília (America/Sao_Paulo, UTC-3, no DST since 2019).
export const TZ = "America/Sao_Paulo";
const OFFSET_MS = 3 * 3600 * 1000;

export function todayBRT(): string {
  return new Date(Date.now() - OFFSET_MS).toISOString().slice(0, 10);
}
export function addDays(day: string, n: number): string {
  const d = new Date(day + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function mondayOf(day: string): string {
  const d = new Date(day + "T12:00:00Z");
  const dow = (d.getUTCDay() + 6) % 7;
  return addDays(day, -dow);
}
export function dayOfBRT(iso: string): string {
  return new Date(new Date(iso).getTime() - OFFSET_MS).toISOString().slice(0, 10);
}
export function hourOfBRT(iso: string): number {
  return new Date(new Date(iso).getTime() - OFFSET_MS).getUTCHours();
}
export function fmtTime(iso: string) {
  return new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}
export function fmtDateLong(iso: string) {
  return new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, weekday: "long", day: "2-digit", month: "long" }).format(new Date(iso));
}
export function fmtDateTime(iso: string) {
  return new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}
export function fmtDay(day: string, opts: Intl.DateTimeFormatOptions = { weekday: "short", day: "2-digit" }) {
  return new Intl.DateTimeFormat("pt-BR", { timeZone: "UTC", ...opts }).format(new Date(day + "T12:00:00Z"));
}
export const brl = (n: number) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(n);

export function errMsg(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as { message: string }).message);
  return "Algo deu errado";
}
