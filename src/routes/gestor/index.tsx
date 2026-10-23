import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Eye, EyeOff, Lock, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { useCourts, useMyVenue } from "@/lib/booking";
import { addDays, errMsg, fmtDay, fmtTime, mondayOf, todayBRT } from "@/lib/time";
import { EmptyState } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/gestor/")({
  head: () => ({ meta: [{ title: "Agenda da semana · Gestor" }] }),
  component: WeekAgenda,
});

type Cell = Database["public"]["Functions"]["agenda_gestor"]["Returns"][number];
type Estado = "livre" | "bloqueado" | "mensalista" | "pendente" | "confirmada";
const HORA = 3600_000;

const CELL_CLASS: Record<Estado, string> = {
  livre: "bg-card border-border hover:border-primary",
  bloqueado: "bg-pitch text-pitch-foreground border-pitch",
  mensalista: "bg-secondary text-secondary-foreground border-secondary",
  pendente: "bg-warning text-warning-foreground border-warning",
  confirmada: "bg-success text-success-foreground border-success",
};
const CELL_TEXT: Record<Estado, string> = {
  livre: "",
  bloqueado: "Ocup.",
  mensalista: "Mensal",
  pendente: "Pend.",
  confirmada: "Pago",
};

function WeekAgenda() {
  const today = todayBRT();
  const [offset, setOffset] = useState(0);
  const monday = addDays(mondayOf(today), offset * 7);
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(monday, i)), [monday]);
  const [courtId, setCourtId] = useState<string | null>(null);
  const [mode, setMode] = useState<"block" | "detail">("block");
  const { data: venue, isLoading: venueLoading } = useMyVenue();
  const venueId = venue?.id;
  const { data: courts = [], isLoading: courtsLoading } = useCourts(venueId ? { venueId } : {});
  const qc = useQueryClient();
  const navigate = useNavigate();
  const key = ["week", venueId, monday];

  const { data, isLoading } = useQuery({
    queryKey: key,
    enabled: !!venueId,
    queryFn: async () => {
      await supabase.rpc("expire_bookings");
      const [cells, pub] = await Promise.all([
        supabase.rpc("agenda_gestor", { _venue: venueId!, _monday: monday }),
        supabase
          .from("semanas_publicadas")
          .select("segunda")
          .eq("venue_id", venueId!)
          .eq("segunda", monday)
          .maybeSingle(),
      ]);
      if (cells.error) throw cells.error;
      if (pub.error) throw pub.error;
      return { cells: cells.data, publicada: !!pub.data };
    },
  });

  const activeCourt = courtId ?? courts[0]?.id;
  const all = data?.cells ?? [];
  const courtCells = all.filter((c) => c.court_id === activeCourt);
  const isPublished = !!data?.publicada;
  const hours = useMemo(
    () => [...new Set(courtCells.map((c) => c.hora))].sort((a, b) => a - b),
    [courtCells],
  );
  const grid = new Map(courtCells.map((c) => [`${c.dia}|${c.hora}`, c]));

  const occupancy = (cid: string) => {
    const list = all.filter((c) => c.court_id === cid);
    if (!list.length) return null;
    return Math.round((list.filter((c) => c.estado !== "livre").length / list.length) * 100);
  };

  const publish = useMutation({
    mutationFn: async (value: boolean) => {
      const { error } = await supabase.rpc("publish_week", {
        _monday: monday,
        _venue: venueId!,
        _publish: value,
      });
      if (error) throw error;
      return value;
    },
    onSuccess: (v) => {
      toast.success(
        v ? "Semana publicada! Os organizadores já podem reservar." : "Semana despublicada.",
      );
      qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => toast.error(errMsg(e)),
  });

  const toggleBlock = useMutation({
    mutationFn: async (c: Cell) => {
      const { error } = await supabase.rpc("set_bloqueio", {
        _court: c.court_id,
        _inicio: c.inicio,
        _fim: new Date(new Date(c.inicio).getTime() + HORA).toISOString(),
        _bloquear: c.estado === "livre",
      });
      if (error) throw error;
    },
    onMutate: async (c) => {
      await qc.cancelQueries({ queryKey: key });
      qc.setQueryData<{ cells: Cell[]; publicada: boolean }>(key, (old) =>
        old
          ? {
              ...old,
              cells: old.cells.map((x) =>
                x.court_id === c.court_id && x.inicio === c.inicio
                  ? { ...x, estado: c.estado === "livre" ? "bloqueado" : "livre" }
                  : x,
              ),
            }
          : old,
      );
    },
    onError: (e) => {
      toast.error(errMsg(e));
      qc.invalidateQueries({ queryKey: key });
    },
  });

  const onCell = (c: Cell) => {
    const toggles = c.estado === "livre" || c.estado === "bloqueado";
    if (mode === "block" && toggles) {
      if (new Date(c.inicio).getTime() > Date.now()) toggleBlock.mutate(c);
    } else {
      navigate({
        to: "/gestor/horario/$courtId",
        params: { courtId: c.court_id },
        search: { inicio: c.inicio },
      });
    }
  };

  const weekLabel =
    offset === 0
      ? "Esta semana"
      : offset === 1
        ? "Próxima semana"
        : offset === -1
          ? "Semana passada"
          : null;

  if (venueLoading || courtsLoading)
    return <Loader2 className="mx-auto size-6 animate-spin text-muted-foreground" />;
  if (!venue)
    return (
      <EmptyState title="Cadastre seu local primeiro">
        <Link to="/gestor/configuracao" className="font-semibold text-primary">
          Ir para Configuração
        </Link>
      </EmptyState>
    );
  if (!courts.length)
    return (
      <EmptyState title="Cadastre suas quadras primeiro">
        <p>
          A agenda é montada a partir do horário de funcionamento de cada quadra ativa do seu local.
          Adicione suas quadras com nome, piso e preço.
        </p>
        <Button asChild className="mt-4">
          <Link to="/gestor/configuracao">Cadastrar quadras</Link>
        </Button>
      </EmptyState>
    );

  return (
    <div>
      <p className="mb-2 text-center text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {venue.name}
      </p>
      <div className="flex items-center justify-between gap-2">
        <Button
          variant="outline"
          size="icon"
          aria-label="Semana anterior"
          onClick={() => setOffset(offset - 1)}
        >
          <ChevronLeft />
        </Button>
        <div className="text-center">
          <h1 className="text-xl font-black">{weekLabel ?? "Semana"}</h1>
          <p className="text-xs text-muted-foreground">
            {fmtDay(monday, { day: "2-digit", month: "short" })} –{" "}
            {fmtDay(addDays(monday, 6), { day: "2-digit", month: "short" })}
          </p>
        </div>
        <Button
          variant="outline"
          size="icon"
          aria-label="Próxima semana"
          onClick={() => setOffset(offset + 1)}
        >
          <ChevronRight />
        </Button>
      </div>

      {isLoading ? (
        <Loader2 className="mx-auto mt-8 size-6 animate-spin text-muted-foreground" />
      ) : !all.length ? (
        <div className="mt-6">
          <EmptyState title="Nenhuma quadra aberta nessa semana">
            Confira o funcionamento de cada quadra em{" "}
            <Link to="/gestor/configuracao" className="font-semibold text-primary">
              Configuração → Horários e preços
            </Link>
            .
          </EmptyState>
        </div>
      ) : (
        <>
          <div
            className={cn(
              "mt-4 flex items-center justify-between gap-3 rounded-xl p-3 text-sm",
              isPublished ? "bg-success/10" : "bg-warning/20",
            )}
          >
            <span>
              {isPublished
                ? "Publicada: organizadores podem reservar essa semana."
                : "Rascunho: marque o que já está ocupado e publique."}
            </span>
            <Button
              size="sm"
              variant={isPublished ? "outline" : "default"}
              disabled={publish.isPending}
              onClick={() => publish.mutate(!isPublished)}
            >
              {isPublished ? <EyeOff /> : <Eye />}
              {isPublished ? "Despublicar" : "Publicar semana"}
            </Button>
          </div>

          <div className="-mx-4 mt-4 flex gap-2 overflow-x-auto px-4">
            {courts.map((c) => {
              const occ = occupancy(c.id);
              return (
                <button
                  key={c.id}
                  onClick={() => setCourtId(c.id)}
                  className={cn(
                    "shrink-0 rounded-lg border bg-card px-3 py-1.5 text-left text-sm",
                    c.id === activeCourt && "border-primary bg-primary text-primary-foreground",
                  )}
                >
                  <div className="font-semibold">{c.name}</div>
                  {occ !== null && <div className="text-[11px] opacity-75">{occ}% ocupada</div>}
                </button>
              );
            })}
          </div>

          <div className="mt-3 flex rounded-lg border bg-card p-0.5 text-xs">
            <button
              className={cn(
                "flex flex-1 items-center justify-center gap-1 rounded-md px-2.5 py-1 font-medium",
                mode === "block" && "bg-secondary",
              )}
              onClick={() => setMode("block")}
            >
              <Lock className="size-3" /> Tocar marca ocupado
            </button>
            <button
              className={cn(
                "flex flex-1 items-center justify-center gap-1 rounded-md px-2.5 py-1 font-medium",
                mode === "detail" && "bg-secondary",
              )}
              onClick={() => setMode("detail")}
            >
              <Eye className="size-3" /> Tocar abre detalhe
            </button>
          </div>

          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[22rem] border-separate border-spacing-1 text-xs">
              <thead>
                <tr>
                  <th className="w-10" />
                  {days.map((d) => (
                    <th
                      key={d}
                      className={cn("font-medium capitalize", d === today && "text-primary")}
                    >
                      <div>{fmtDay(d, { weekday: "short" }).replace(".", "")}</div>
                      <div className="font-display text-sm font-bold">
                        {fmtDay(d, { day: "2-digit" })}
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {hours.map((h) => (
                  <tr key={h}>
                    <td className="pr-1 text-right font-display font-bold text-muted-foreground">
                      {h}h
                    </td>
                    {days.map((d) => {
                      const c = grid.get(`${d}|${h}`);
                      if (!c) return <td key={d} className="h-9 rounded-md bg-muted/40" />;
                      const estado = c.estado as Estado;
                      const past = new Date(c.inicio).getTime() + HORA <= Date.now();
                      const faixa =
                        c.booking_inicio && c.booking_fim
                          ? `${fmtTime(c.booking_inicio)}–${fmtTime(c.booking_fim)}`
                          : undefined;
                      return (
                        <td key={d} className="p-0">
                          <button
                            onClick={() => onCell(c)}
                            title={[faixa, c.nota].filter(Boolean).join(" · ") || undefined}
                            className={cn(
                              "relative flex h-9 w-full items-center justify-center rounded-md border text-[10px] font-semibold transition-colors",
                              CELL_CLASS[estado],
                              !isPublished && "border-dashed",
                              past && "opacity-40",
                            )}
                          >
                            {CELL_TEXT[estado]}
                            {c.fila > 0 && (
                              <span className="absolute right-0.5 top-0.5 flex size-3.5 items-center justify-center rounded-full bg-accent text-[9px] text-accent-foreground">
                                {c.fila}
                              </span>
                            )}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-4 flex flex-wrap gap-3 text-xs text-muted-foreground">
            <Legend className="bg-card border">Livre</Legend>
            <Legend className="bg-pitch">Ocupado por fora</Legend>
            <Legend className="bg-secondary">Mensalista</Legend>
            <Legend className="bg-warning">Aguardando Pix</Legend>
            <Legend className="bg-success">Pago</Legend>
            <Legend className="bg-accent rounded-full">Fila de espera</Legend>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Cada célula é 1 hora. Reservas pelo app podem durar 1h, 1h30 ou 2h e começar na meia
            hora; toque nelas para ver o horário exato. Marque como ocupado tudo o que foi reservado
            por WhatsApp, telefone ou na hora. Pedidos pelo app aparecem em{" "}
            <Link to="/gestor/solicitacoes" className="font-semibold text-primary">
              Solicitações
            </Link>
            .
          </p>
        </>
      )}
    </div>
  );
}

function Legend({ className, children }: { className: string; children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={cn("size-3 rounded-sm", className)} />
      {children}
    </span>
  );
}
