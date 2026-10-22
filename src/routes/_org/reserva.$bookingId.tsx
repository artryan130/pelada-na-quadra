import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Copy, Loader2, MessageCircle } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { STATUS_CLASS, STATUS_LABEL, fmtCountdown, useNow, whatsappLink } from "@/lib/booking";
import { brl, errMsg, fmtDateLong, fmtTime } from "@/lib/time";
import { EmptyState, StatusPill } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

export const Route = createFileRoute("/_org/reserva/$bookingId")({
  head: () => ({ meta: [{ title: "Sua reserva · Bate-Bola" }] }),
  component: BookingPage,
});

const HOUR = 3600 * 1000;

function BookingPage() {
  const { bookingId } = Route.useParams();
  const qc = useQueryClient();
  const now = useNow();

  const { data: b, isLoading } = useQuery({
    queryKey: ["booking", bookingId],
    queryFn: async () => {
      await supabase.rpc("expire_bookings");
      const { data, error } = await supabase
        .from("bookings")
        .select(
          "id, status, created_at, expires_at, slots(starts_at, duration_min, courts(name, surface, price_per_hour, venues(name, address, pix_key, whatsapp, cancel_limit_hours)))",
        )
        .eq("id", bookingId)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const expiresIn = b ? new Date(b.expires_at).getTime() - now : 0;
  const pendingExpired = b?.status === "pendente" && expiresIn <= 0;
  useEffect(() => {
    if (pendingExpired) qc.invalidateQueries({ queryKey: ["booking", bookingId] });
  }, [pendingExpired, qc, bookingId]);

  const cancel = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc("cancel_booking", { _booking: bookingId });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Reserva cancelada.");
      qc.invalidateQueries();
    },
    onError: (e) => toast.error(errMsg(e)),
  });

  if (isLoading) return <Loader2 className="mx-auto size-6 animate-spin text-muted-foreground" />;
  const slot = b?.slots;
  const court = slot?.courts;
  const venue = court?.venues;
  if (!b || !slot || !court) return <EmptyState title="Reserva não encontrada" />;

  const startsIn = new Date(slot.starts_at).getTime() - now;
  const active = b.status === "pendente" || b.status === "confirmada";
  const canSelfCancel =
    b.status === "pendente" ||
    (b.status === "confirmada" && startsIn >= (venue?.cancel_limit_hours ?? 24) * HOUR);
  const label = `${court.name}, ${fmtDateLong(slot.starts_at)} às ${fmtTime(slot.starts_at)}`;
  const wa = venue?.whatsapp
    ? whatsappLink(venue.whatsapp, `Olá! Sobre minha reserva no Bate-Bola: ${label}.`)
    : null;

  return (
    <div>
      <Link
        to="/minhas-reservas"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground"
      >
        <ArrowLeft className="size-4" /> Minhas reservas
      </Link>

      <div className="mt-3 flex items-center justify-between gap-3">
        <h1 className="text-2xl font-black">
          {b.status === "pendente" ? "Pagamento pendente" : "Sua reserva"}
        </h1>
        <StatusPill className={STATUS_CLASS[b.status]}>{STATUS_LABEL[b.status]}</StatusPill>
      </div>

      <div className="mt-4 rounded-2xl bg-card p-5 shadow-card">
        <p className="font-display text-lg font-bold">{court.name}</p>
        <p className="text-sm capitalize text-muted-foreground">
          {fmtDateLong(slot.starts_at)} · {fmtTime(slot.starts_at)}
        </p>
        <p className="mt-2 text-sm">
          Valor: <strong>{brl(Number(court.price_per_hour))}</strong>
        </p>
      </div>

      {b.status === "pendente" && venue && (
        <div className="mt-4 rounded-2xl bg-pitch-gradient p-5 text-pitch-foreground">
          <p className="text-sm opacity-80">Pague em até</p>
          <p className="font-display text-5xl font-black tabular-nums text-accent">
            {fmtCountdown(expiresIn)}
          </p>
          <p className="mt-1 text-xs opacity-70">
            Depois disso a solicitação expira e o horário volta para a agenda.
          </p>
          <div className="mt-5 rounded-xl bg-pitch-foreground/10 p-4">
            <p className="text-xs uppercase tracking-wide opacity-70">Chave Pix · {venue.name}</p>
            <div className="mt-1 flex items-center justify-between gap-2">
              <p className="break-all font-mono text-base font-semibold">{venue.pix_key}</p>
              <Button
                size="sm"
                variant="accent"
                onClick={() =>
                  navigator.clipboard
                    .writeText(venue.pix_key)
                    .then(() => toast.success("Chave Pix copiada"))
                }
              >
                <Copy /> Copiar
              </Button>
            </div>
            <p className="mt-3 text-sm">
              Valor: <strong>{brl(Number(court.price_per_hour))}</strong>
            </p>
          </div>
          <p className="mt-4 text-sm opacity-90">
            Assim que a quadra marcar o pagamento como recebido, você recebe um aviso e a reserva
            fica confirmada.
          </p>
        </div>
      )}

      {b.status === "confirmada" && (
        <p className="mt-4 rounded-xl bg-success/10 p-4 text-sm">
          Pagamento recebido. É só aparecer na quadra no horário. ⚽
        </p>
      )}
      {b.status === "expirada" && (
        <p className="mt-4 rounded-xl bg-muted p-4 text-sm">
          O prazo de pagamento acabou e o horário voltou para a agenda. Se já pagou, fale com a
          quadra.
        </p>
      )}
      {b.status === "recusada" && (
        <p className="mt-4 rounded-xl bg-muted p-4 text-sm">
          A quadra recusou essa solicitação. Fale com ela se tiver dúvidas.
        </p>
      )}

      <div className="mt-6 space-y-3">
        {wa && (
          <Button asChild variant="outline" size="lg" className="w-full">
            <a href={wa} target="_blank" rel="noreferrer">
              <MessageCircle /> Falar com a quadra no WhatsApp
            </a>
          </Button>
        )}
        {active &&
          (canSelfCancel ? (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="ghost"
                  size="lg"
                  className="w-full text-destructive hover:bg-destructive/10 hover:text-destructive"
                >
                  Cancelar reserva
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Cancelar essa reserva?</AlertDialogTitle>
                  <AlertDialogDescription>
                    O horário volta para a agenda e quem estiver na fila é avisado.
                    {b.status === "confirmada" && " Reembolso é combinado direto com a quadra."}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Voltar</AlertDialogCancel>
                  <AlertDialogAction onClick={() => cancel.mutate()}>
                    Cancelar reserva
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : (
            <p className="text-center text-xs text-muted-foreground">
              Faltam menos de {venue?.cancel_limit_hours}h para o jogo. Para cancelar, fale com a
              quadra.
            </p>
          ))}
      </div>
    </div>
  );
}
