import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Eye, EyeOff, Lock, Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useCourts, useMyVenue } from "@/lib/booking";
import {
  addDays,
  dayOfBRT,
  errMsg,
  fmtDay,
  hourOfBRT,
  mondayOf,
  startOfDayISO,
  todayBRT,
} from "@/lib/time";
import { EmptyState } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/gestor/")({
  head: () => ({ meta: [{ title: "Agenda da semana · Gestor" }] }),
  component: WeekAgenda,
});

type CellState = "livre" | "bloqueado" | "pendente" | "confirmada";
type WeekSlot = {
  id: string;
  court_id: string;
  starts_at: string;
  published: boolean;
  blocked: boolean;
  block_note: string | null;
  bookings: { status: string }[];
  waitlist: { id: string }[];
};

function cellState(s: WeekSlot): CellState {
  if (s.bookings.some((b) => b.status === "confirmada")) return "confirmada";
  if (s.bookings.some((b) => b.status === "pendente")) return "pendente";
  return s.blocked ? "bloqueado" : "livre";
}

const CELL_CLASS: Record<CellState, string> = {
  livre: "bg-card border-border hover:border-primary",
  bloqueado: "bg-pitch text-pitch-foreground border-pitch",
  pendente: "bg-warning text-warning-foreground border-warning",
  confirmada: "bg-success text-success-foreground border-success",
};
const CELL_TEXT: Record<CellState, string> = {
  livre: "",
  bloqueado: "Ocup.",
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
  const { data: courts = [] } = useCourts(venueId ? { venueId } : {});
  const qc = useQueryClient();
  const navigate = useNavigate();
  const key = ["week", venueId, monday];

  const { data: slots, isLoading } = useQuery({
    queryKey: key,
    enabled: !!venueId,
    queryFn: async () => {
      await supabase.rpc("expire_bookings");
      // Published slots of other venues are readable too, so scope to this venue.
      const { data, error } = await supabase
        .from("slots")
        .select(
          "id, court_id, starts_at, published, blocked, block_note, bookings(status), waitlist(id), courts!inner(venue_id)",
        )
        .eq("courts.venue_id", venueId!)
        .gte("starts_at", startOfDayISO(monday))
        .lt("starts_at", startOfDayISO(addDays(monday, 7)))
        .in("bookings.status", ["pendente", "confirmada"])
        .order("starts_at")
        .limit(5000);
      if (error) throw error;
      return data as WeekSlot[];
    },
  });

  const activeCourt = courtId ?? courts[0]?.id;
  const all = slots ?? [];
  const courtSlots = all.filter((s) => s.court_id === activeCourt);
  const published = all.filter((s) => s.published).length;
  const isPublished = all.length > 0 && published === all.length;

  const hours = useMemo(() => {
    const hs = new Set(courtSlots.map((s) => hourOfBRT(s.starts_at)));
    if (venue) for (let h = venue.open_hour; h < venue.close_hour; h++) hs.add(h);
    return [...hs].sort((a, b) => a - b);
  }, [courtSlots, venue]);
  const grid = new Map(
    courtSlots.map((s) => [`${dayOfBRT(s.starts_at)}|${hourOfBRT(s.starts_at)}`, s]),
  );

  const occupancy = (cid: string) => {
    const list = all.filter((s) => s.court_id === cid);
    if (!list.length) return null;
    return Math.round((list.filter((s) => cellState(s) !== "livre").length / list.length) * 100);
  };

  const generate = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc("generate_week", {
        _monday: monday,
        _venue: venueId!,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (n) => {
      toast.success(n ? `${n} horários criados.` : "Todos os horários já existiam.");
      qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => toast.error(errMsg(e)),
  });

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
    mutationFn: async (s: WeekSlot) => {
      const { error } = await supabase.rpc("set_slot_blocked", {
        _slot: s.id,
        _blocked: !s.blocked,
      });
      if (error) throw error;
    },
    onMutate: async (s) => {
      await qc.cancelQueries({ queryKey: key });
      qc.setQueryData<WeekSlot[]>(key, (old) =>
        old?.map((x) => (x.id === s.id ? { ...x, blocked: !s.blocked } : x)),
      );
    },
    onError: (e) => {
      toast.error(errMsg(e));
      qc.invalidateQueries({ queryKey: key });
    },
  });

  const onCell = (s: WeekSlot) => {
    const st = cellState(s);
    if (mode === "detail" || st === "pendente" || st === "confirmada") {
      navigate({ to: "/gestor/horario/$slotId", params: { slotId: s.id } });
    } else if (new Date(s.starts_at).getTime() > Date.now()) {
      toggleBlock.mutate(s);
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

  if (venueLoading)
    return <Loader2 className="mx-auto size-6 animate-spin text-muted-foreground" />;
  if (!venue)
    return (
      <EmptyState title="Cadastre seu local primeiro">
        <Link to="/gestor/configuracao" className="font-semibold text-primary">
          Ir para Configuração
        </Link>
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
          <EmptyState title="Essa semana ainda não tem horários">
            <p>
              Vamos criar os horários das {courts.length} quadras
              {venue && ` das ${venue.open_hour}h às ${venue.close_hour}h`}, todos livres. Depois é
              só marcar o que já está ocupado e publicar.
            </p>
            <Button
              className="mt-4"
              onClick={() => generate.mutate()}
              disabled={generate.isPending}
            >
              {generate.isPending ? <Loader2 className="animate-spin" /> : <Sparkles />} Gerar
              horários da semana
            </Button>
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
                ? "Publicada: organizadores veem essa semana."
                : published
                  ? `Parcialmente publicada (${published} de ${all.length}).`
                  : "Rascunho: só você vê essa semana."}
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

          <div className="mt-3 flex items-center justify-between gap-2">
            <div className="flex rounded-lg border bg-card p-0.5 text-xs">
              <button
                className={cn(
                  "flex items-center gap-1 rounded-md px-2.5 py-1 font-medium",
                  mode === "block" && "bg-secondary",
                )}
                onClick={() => setMode("block")}
              >
                <Lock className="size-3" /> Tocar bloqueia
              </button>
              <button
                className={cn(
                  "flex items-center gap-1 rounded-md px-2.5 py-1 font-medium",
                  mode === "detail" && "bg-secondary",
                )}
                onClick={() => setMode("detail")}
              >
                <Eye className="size-3" /> Tocar abre detalhe
              </button>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => generate.mutate()}
              disabled={generate.isPending}
            >
              Completar horários
            </Button>
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
                      const s = grid.get(`${d}|${h}`);
                      if (!s) return <td key={d} className="h-9 rounded-md bg-muted/40" />;
                      const st = cellState(s);
                      const past = new Date(s.starts_at).getTime() <= Date.now();
                      return (
                        <td key={d} className="p-0">
                          <button
                            onClick={() => onCell(s)}
                            title={s.block_note ?? undefined}
                            className={cn(
                              "relative flex h-9 w-full items-center justify-center rounded-md border text-[10px] font-semibold transition-colors",
                              CELL_CLASS[st],
                              !s.published && "border-dashed",
                              past && "opacity-40",
                            )}
                          >
                            {CELL_TEXT[st]}
                            {s.waitlist.length > 0 && (
                              <span className="absolute right-0.5 top-0.5 flex size-3.5 items-center justify-center rounded-full bg-accent text-[9px] text-accent-foreground">
                                {s.waitlist.length}
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
            <Legend className="bg-warning">Aguardando Pix</Legend>
            <Legend className="bg-success">Pago</Legend>
            <Legend className="bg-accent rounded-full">Fila de espera</Legend>
            <Legend className="border border-dashed bg-card">Não publicado</Legend>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Marque como ocupado tudo o que foi reservado por WhatsApp, telefone ou na hora. Pedidos
            pelo app aparecem em{" "}
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
