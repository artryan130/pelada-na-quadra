import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BellPlus, BellOff, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useCourts, useFila, useVenues } from "@/lib/booking";
import type { Database } from "@/integrations/supabase/types";
import { addDays, brl, fmtDay, fmtTime, hourOfBRT, todayBRT } from "@/lib/time";
import { EmptyState } from "@/components/app-shell";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_org/agenda")({
  head: () => ({ meta: [{ title: "Agenda · Bate-Bola" }] }),
  component: Agenda,
});

const DAYS_AHEAD = 14;
const PERIODS = [
  { id: "all", label: "Todos", from: 0, to: 24 },
  { id: "manha", label: "Manhã", from: 0, to: 12 },
  { id: "tarde", label: "Tarde", from: 12, to: 18 },
  { id: "noite", label: "Noite", from: 18, to: 24 },
] as const;

type AgendaSlot = Database["public"]["Functions"]["agenda_dia"]["Returns"][number];
const HORA = 3600_000;
const fimDe = (s: AgendaSlot) => new Date(new Date(s.inicio).getTime() + HORA).toISOString();

// Other organizers' bookings don't reach this client in realtime (RLS), so the agenda polls.
const REFRESH_MS = 15_000;

function Agenda() {
  const today = todayBRT();
  const days = useMemo(
    () => Array.from({ length: DAYS_AHEAD }, (_, i) => addDays(today, i)),
    [today],
  );
  const [day, setDay] = useState(today);
  const [venue, setVenue] = useState("all");
  const [court, setCourt] = useState("all");
  const [period, setPeriod] = useState<(typeof PERIODS)[number]["id"]>("all");
  const [queueSlot, setQueueSlot] = useState<AgendaSlot | null>(null);
  const { data: venues = [] } = useVenues();
  const { data: courts = [] } = useCourts(venue === "all" ? {} : { venueId: venue });
  const navigate = useNavigate();

  const {
    data: slots,
    isLoading,
    dataUpdatedAt,
  } = useQuery({
    queryKey: ["agenda", day, venue],
    refetchInterval: REFRESH_MS,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("agenda_dia", {
        _day: day,
        ...(venue === "all" ? {} : { _venue: venue }),
      });
      if (error) throw error;
      return data;
    },
  });

  const p = PERIODS.find((x) => x.id === period)!;
  const visible = (slots ?? []).filter(
    (s) =>
      s.state !== "passado" &&
      (venue === "all" || s.venue_id === venue) &&
      (court === "all" || s.court_id === court) &&
      hourOfBRT(s.inicio) >= p.from &&
      hourOfBRT(s.inicio) < p.to,
  );
  const byTime = new Map<string, AgendaSlot[]>();
  for (const s of visible) byTime.set(s.inicio, [...(byTime.get(s.inicio) ?? []), s]);
  const freeCount = visible.filter((s) => s.state === "livre").length;

  const onTap = (s: AgendaSlot) => {
    if (s.my_booking_id)
      navigate({ to: "/reserva/$bookingId", params: { bookingId: s.my_booking_id } });
    else if (s.state === "livre")
      navigate({
        to: "/quadra/$courtId",
        params: { courtId: s.court_id },
        search: { inicio: s.inicio, duracao: 60 },
      });
    else setQueueSlot(s);
  };

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <h1 className="text-2xl font-black">Horários livres em BH</h1>
        {dataUpdatedAt > 0 && (
          <span className="text-xs text-muted-foreground">
            atualizado {fmtTime(new Date(dataUpdatedAt).toISOString())}
          </span>
        )}
      </div>

      <div className="-mx-4 mt-4 flex gap-2 overflow-x-auto px-4 pb-1">
        {days.map((d) => (
          <button
            key={d}
            onClick={() => setDay(d)}
            className={cn(
              "flex min-w-14 flex-col items-center rounded-xl border bg-card px-2 py-2 text-xs transition-colors",
              d === day && "border-primary bg-primary text-primary-foreground",
            )}
          >
            <span className="capitalize opacity-80">
              {d === today ? "hoje" : fmtDay(d, { weekday: "short" }).replace(".", "")}
            </span>
            <span className="font-display text-lg font-bold">{fmtDay(d, { day: "2-digit" })}</span>
          </button>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {venues.length > 1 && (
          <Select
            value={venue}
            onValueChange={(v) => {
              setVenue(v);
              setCourt("all");
            }}
          >
            <SelectTrigger className="h-9 w-44 bg-card">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos os locais</SelectItem>
              {venues.map((v) => (
                <SelectItem key={v.id} value={v.id}>
                  {v.name}
                  {v.neighborhood && ` · ${v.neighborhood}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {/* Court names repeat across venues ("Quadra 1"), so pick a venue first. */}
        {(venues.length <= 1 || venue !== "all") && (
          <Select value={court} onValueChange={setCourt}>
            <SelectTrigger className="h-9 w-40 bg-card">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todas as quadras</SelectItem>
              {courts.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <div className="flex rounded-lg border bg-card p-0.5">
          {PERIODS.map((x) => (
            <button
              key={x.id}
              onClick={() => setPeriod(x.id)}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-medium",
                period === x.id && "bg-secondary text-secondary-foreground",
              )}
            >
              {x.label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-5">
        {isLoading ? (
          <Loader2 className="mx-auto size-6 animate-spin text-muted-foreground" />
        ) : !slots?.length ? (
          <EmptyState title="Nenhum horário aberto nesse dia">
            As quadras liberam a agenda semana a semana. Tente outro dia ou volte mais tarde.
          </EmptyState>
        ) : !visible.length ? (
          <EmptyState title="Nenhum horário com esses filtros" />
        ) : (
          <>
            <p className="mb-3 text-sm text-muted-foreground">
              {freeCount
                ? `${freeCount} horário${freeCount > 1 ? "s" : ""} livre${freeCount > 1 ? "s" : ""}`
                : "Tudo ocupado — entre na fila para ser avisado se vagar."}
            </p>
            <ul className="space-y-3">
              {[...byTime.entries()].map(([t, list]) => (
                <li key={t} className="flex gap-3">
                  <div className="w-12 shrink-0 pt-2.5 font-display text-sm font-bold">
                    {fmtTime(t)}
                  </div>
                  <div className="grid flex-1 grid-cols-2 gap-2 sm:grid-cols-4">
                    {list.map((s) => (
                      <SlotChip
                        key={s.court_id + s.inicio}
                        s={s}
                        showVenue={venues.length > 1 && venue === "all"}
                        onClick={() => onTap(s)}
                      />
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <QueueDialog slot={queueSlot} onClose={() => setQueueSlot(null)} />
    </div>
  );
}

function SlotChip({
  s,
  showVenue,
  onClick,
}: {
  s: AgendaSlot;
  showVenue: boolean;
  onClick: () => void;
}) {
  const mine = !!s.my_booking_id;
  const free = s.state === "livre";
  return (
    <button
      onClick={onClick}
      className={cn(
        "rounded-lg border px-3 py-2 text-left text-sm transition-colors",
        free && "border-primary/30 bg-card shadow-card hover:border-primary",
        !free && !mine && "border-transparent bg-muted text-muted-foreground",
        mine && "border-success bg-success/10",
      )}
    >
      <div className="font-semibold">{s.court_name}</div>
      {showVenue && (
        <div className="truncate text-xs opacity-80">
          {s.venue_name}
          {s.neighborhood && ` · ${s.neighborhood}`}
        </div>
      )}
      <div className="text-xs">
        {mine
          ? s.my_booking_status === "confirmada"
            ? "Sua reserva ✓"
            : "Sua solicitação"
          : free
            ? brl(Number(s.price))
            : s.in_waitlist
              ? "Você está na fila"
              : s.state === "aguardando"
                ? "Aguardando pagamento"
                : "Ocupado · entrar na fila"}
      </div>
    </button>
  );
}

function QueueDialog({ slot, onClose }: { slot: AgendaSlot | null; onClose: () => void }) {
  const fila = useFila();

  return (
    <Dialog open={!!slot} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        {slot && (
          <>
            <DialogHeader>
              <DialogTitle>
                {slot.court_name} · {fmtTime(slot.inicio)}
              </DialogTitle>
              <DialogDescription>
                {slot.in_waitlist
                  ? "Você já está na fila desse horário. Se ele vagar, todos da fila recebem um aviso e leva quem solicitar primeiro."
                  : "Esse horário está ocupado. Entre na fila: se ele vagar, todos da fila recebem um aviso e leva quem solicitar primeiro."}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant={slot.in_waitlist ? "outline" : "default"}
                disabled={fila.isPending}
                onClick={() =>
                  fila.mutate(
                    {
                      courtId: slot.court_id,
                      inicio: slot.inicio,
                      fim: fimDe(slot),
                      sair: slot.in_waitlist,
                    },
                    { onSuccess: onClose },
                  )
                }
              >
                {slot.in_waitlist ? <BellOff /> : <BellPlus />}
                {slot.in_waitlist ? "Sair da fila" : "Entrar na fila"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
