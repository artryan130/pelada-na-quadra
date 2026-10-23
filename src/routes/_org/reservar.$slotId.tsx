import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CalendarDays, Clock, Loader2, MapPin, Wallet } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { brl, errMsg, fmtDateLong, fmtTime } from "@/lib/time";
import { EmptyState } from "@/components/app-shell";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/_org/reservar/$slotId")({
  head: () => ({ meta: [{ title: "Confirmar solicitação · Bate-Bola" }] }),
  component: ConfirmRequest,
});

function ConfirmRequest() {
  const { slotId } = Route.useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const { data: slot, isLoading } = useQuery({
    queryKey: ["slot", slotId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("slots")
        .select(
          "id, court_id, starts_at, duration_min, courts(name, surface, photo_url, price_per_hour, venues(name, address, neighborhood, payment_deadline_hours, cancel_limit_hours))",
        )
        .eq("id", slotId)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      // Same price request_booking will store: the price table, falling back to the old hourly price.
      const { data: preco } = await supabase.rpc("preco_intervalo", {
        _court: data.court_id,
        _inicio: data.starts_at,
        _fim: new Date(
          new Date(data.starts_at).getTime() + data.duration_min * 60_000,
        ).toISOString(),
      });
      return { ...data, preco: preco ?? data.courts?.price_per_hour ?? 0 };
    },
  });

  const request = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc("request_booking", { _slot: slotId });
      if (error) throw error;
      return data;
    },
    onSuccess: (bookingId) => {
      qc.invalidateQueries();
      navigate({ to: "/reserva/$bookingId", params: { bookingId }, replace: true });
    },
    onError: (e) => {
      toast.error(errMsg(e));
      qc.invalidateQueries({ queryKey: ["agenda"] });
    },
  });

  if (isLoading) return <Loader2 className="mx-auto size-6 animate-spin text-muted-foreground" />;
  if (!slot?.courts) return <EmptyState title="Horário não encontrado" />;
  const court = slot.courts;
  const venue = court.venues;

  return (
    <div>
      <Link to="/agenda" className="inline-flex items-center gap-1 text-sm text-muted-foreground">
        <ArrowLeft className="size-4" /> Agenda
      </Link>
      <h1 className="mt-3 text-2xl font-black">Confirmar solicitação</h1>

      <div className="mt-5 overflow-hidden rounded-2xl bg-card shadow-card">
        {court.photo_url && (
          <img src={court.photo_url} alt={court.name} className="h-40 w-full object-cover" />
        )}
        <div className="space-y-3 p-5">
          <div>
            <p className="font-display text-xl font-bold">{court.name}</p>
            <p className="text-sm text-muted-foreground">{court.surface}</p>
          </div>
          <Row icon={CalendarDays}>
            <span className="capitalize">{fmtDateLong(slot.starts_at)}</span>
          </Row>
          <Row icon={Clock}>
            {fmtTime(slot.starts_at)} –{" "}
            {fmtTime(
              new Date(
                new Date(slot.starts_at).getTime() + slot.duration_min * 60000,
              ).toISOString(),
            )}
          </Row>
          {venue && (
            <Row icon={MapPin}>
              {venue.name}
              {venue.address && ` · ${venue.address}`}
              {venue.neighborhood && ` · ${venue.neighborhood}`}
            </Row>
          )}
          <Row icon={Wallet}>
            <strong>{brl(Number(slot.preco))}</strong> por Pix, direto para a quadra
          </Row>
        </div>
      </div>

      {venue && (
        <ul className="mt-5 space-y-2 text-sm text-muted-foreground">
          <li>
            • O horário fica guardado para você por <strong>{venue.payment_deadline_hours}h</strong>{" "}
            enquanto você paga.
          </li>
          <li>• A reserva só é confirmada quando a quadra recebe o pagamento.</li>
          <li>
            • Você pode cancelar pelo app até <strong>{venue.cancel_limit_hours}h</strong> antes do
            jogo.
          </li>
        </ul>
      )}

      <Button
        size="lg"
        className="mt-6 w-full"
        disabled={request.isPending}
        onClick={() => request.mutate()}
      >
        {request.isPending && <Loader2 className="animate-spin" />}
        Solicitar reserva
      </Button>
    </div>
  );
}

function Row({ icon: Icon, children }: { icon: typeof Clock; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 text-sm">
      <Icon className="size-4 shrink-0 text-primary" />
      <span>{children}</span>
    </div>
  );
}
