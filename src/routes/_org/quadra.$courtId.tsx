import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  BellOff,
  BellPlus,
  CalendarDays,
  Clock,
  Loader2,
  MapPin,
  MessageCircle,
} from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { DURACOES } from "@/lib/busca";
import { useFila, whatsappLink } from "@/lib/booking";
import { brl, dayOfBRT, errMsg, fmtDateLong, fmtTime } from "@/lib/time";
import { EmptyState } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Params = { inicio?: string; duracao?: number };

export const Route = createFileRoute("/_org/quadra/$courtId")({
  validateSearch: (s: Record<string, unknown>): Params => {
    const out: Params = {};
    const inicio = s["inicio"];
    if (typeof inicio === "string" && !Number.isNaN(Date.parse(inicio))) out.inicio = inicio;
    const d = Number(s["duracao"]);
    if (DURACOES.some((x) => x.min === d)) out.duracao = d;
    return out;
  },
  head: () => ({ meta: [{ title: "Solicitar reserva · Bate-Bola" }] }),
  component: QuadraPage,
});

// Taken but may free up: offer the waitlist.
const PODE_ESPERAR = new Set(["bloqueado", "reservado", "mensalista"]);

const MOTIVO: Record<string, string> = {
  passado: "Esse horário já passou.",
  antecedencia: "Esse horário está perto demais: a quadra pede mais antecedência para reservar.",
  nao_publicado: "A quadra ainda não abriu a agenda dessa semana.",
  fechado: "A quadra está fechada em parte desse horário.",
  mensalista: "Esse horário é de um mensalista.",
  sem_preco: "A quadra ainda não cadastrou o preço desse horário.",
  bloqueado: "A quadra marcou esse horário como ocupado.",
  reservado: "Alguém já pediu esse horário.",
  quadra_indisponivel: "Essa quadra não está recebendo reservas.",
  horario_invalido: "Horário inválido.",
};

function QuadraPage() {
  const { courtId } = Route.useParams();
  const { inicio, duracao = 60 } = Route.useSearch();
  const navigate = useNavigate({ from: "/quadra/$courtId" });
  const { session } = useAuth();
  const qc = useQueryClient();
  const fila = useFila();
  const fim = inicio
    ? new Date(new Date(inicio).getTime() + duracao * 60_000).toISOString()
    : undefined;

  const { data: quadra, isLoading } = useQuery({
    queryKey: ["quadra", courtId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("courts")
        .select(
          "id, name, surface, modalidade, photo_url, venues(name, address, neighborhood, whatsapp, payment_deadline_hours, cancel_limit_hours)",
        )
        .eq("id", courtId)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  // Checks again: the search result may be a few minutes old.
  const { data: disp, isFetching: checando } = useQuery({
    queryKey: ["disponibilidade", courtId, inicio, duracao],
    enabled: !!inicio,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("disponibilidade_quadra", {
        _court: courtId,
        _inicio: inicio!,
        _fim: fim!,
      });
      if (error) throw error;
      return data[0] ?? null;
    },
  });

  const podeEsperar = !!disp && !disp.livre && PODE_ESPERAR.has(disp.motivo ?? "");
  const { data: naFila } = useQuery({
    queryKey: ["minha-fila", courtId, inicio, duracao],
    enabled: podeEsperar && !!session,
    queryFn: async () => {
      const { count, error } = await supabase
        .from("waitlist")
        .select("id", { count: "exact", head: true })
        .eq("court_id", courtId)
        .eq("organizer_id", session!.user.id)
        .lt("starts_at", fim!)
        .gt("ends_at", inicio!);
      if (error) throw error;
      return (count ?? 0) > 0;
    },
  });

  const solicitar = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc("request_booking", {
        _court: courtId,
        _inicio: inicio!,
        _fim: fim!,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (bookingId) => {
      qc.invalidateQueries();
      navigate({ to: "/reserva/$bookingId", params: { bookingId }, replace: true });
    },
    onError: (e) => {
      toast.error(errMsg(e));
      qc.invalidateQueries({ queryKey: ["disponibilidade", courtId] });
    },
  });

  if (isLoading) return <Loader2 className="mx-auto size-6 animate-spin text-muted-foreground" />;
  if (!quadra) return <EmptyState title="Quadra não encontrada" />;
  const v = quadra.venues;
  const horario = inicio && fim ? `${fmtTime(inicio)}–${fmtTime(fim)}` : null;
  const wa = v?.whatsapp
    ? whatsappLink(
        v.whatsapp,
        `Olá! Vi no Bate-Bola e queria reservar a ${quadra.name}` +
          (inicio && horario
            ? ` em ${fmtDateLong(inicio)}, das ${horario.replace("–", " às ")}.`
            : "."),
      )
    : null;

  return (
    <div>
      <Link
        to="/buscar"
        search={inicio ? { data: dayOfBRT(inicio), hora: fmtTime(inicio), duracao } : {}}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground"
      >
        <ArrowLeft className="size-4" /> Busca
      </Link>

      <div className="mt-3 overflow-hidden rounded-2xl bg-card shadow-card">
        {quadra.photo_url ? (
          <img src={quadra.photo_url} alt={quadra.name} className="h-44 w-full object-cover" />
        ) : (
          <div className="flex h-28 items-end bg-pitch-gradient p-4 font-display text-xs font-bold uppercase tracking-wide text-pitch-foreground/80">
            {quadra.modalidade}
          </div>
        )}
        <div className="space-y-2 p-5">
          <div>
            <p className="font-display text-xl font-black">{v?.name}</p>
            <p className="text-sm">
              {quadra.name} · <span className="capitalize">{quadra.modalidade}</span> ·{" "}
              {quadra.surface}
            </p>
          </div>
          {v && (v.address || v.neighborhood) && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <MapPin className="size-4 shrink-0" />
              {[v.address, v.neighborhood].filter(Boolean).join(" · ")}
            </p>
          )}
        </div>
      </div>

      {inicio && horario ? (
        <div className="mt-4 rounded-2xl bg-card p-5 shadow-card">
          <p className="flex items-center gap-2 text-sm capitalize">
            <CalendarDays className="size-4 text-primary" /> {fmtDateLong(inicio)}
          </p>
          <p className="mt-1 flex items-center gap-2 font-display text-2xl font-black tabular-nums">
            <Clock className="size-5 text-primary" /> {horario}
          </p>
          <div className="mt-3 flex gap-2">
            {DURACOES.map((d) => (
              <button
                key={d.min}
                onClick={() =>
                  navigate({ search: (p: Params) => ({ ...p, duracao: d.min }), replace: true })
                }
                className={cn(
                  "rounded-lg border px-3 py-1 text-xs font-medium",
                  d.min === duracao && "border-primary bg-primary text-primary-foreground",
                )}
              >
                {d.label}
              </button>
            ))}
          </div>

          <div className="mt-4 border-t pt-4">
            {checando && !disp ? (
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            ) : disp?.livre ? (
              <div className="flex items-baseline justify-between">
                <span className="text-sm text-success">Livre</span>
                <span className="font-display text-2xl font-black text-primary">
                  {brl(Number(disp.preco_total))}
                </span>
              </div>
            ) : (
              <p className="text-sm text-destructive">
                {MOTIVO[disp?.motivo ?? ""] ?? "Esse horário não está mais livre."}
              </p>
            )}
          </div>
        </div>
      ) : (
        <p className="mt-4 text-sm text-muted-foreground">
          Escolha um horário na{" "}
          <Link to="/buscar" className="font-semibold text-primary">
            busca
          </Link>
          .
        </p>
      )}

      {disp?.livre && v && (
        <ul className="mt-4 space-y-1.5 text-sm text-muted-foreground">
          <li>
            • O horário fica guardado para você por <strong>{v.payment_deadline_hours}h</strong>{" "}
            enquanto você paga por Pix.
          </li>
          <li>• A reserva só é confirmada quando a quadra recebe o pagamento.</li>
          <li>
            • Você pode cancelar pelo app até <strong>{v.cancel_limit_hours}h</strong> antes do
            jogo.
          </li>
        </ul>
      )}

      <div className="mt-5 space-y-3">
        {disp?.livre && (
          <Button
            size="lg"
            className="w-full"
            disabled={solicitar.isPending}
            onClick={() => solicitar.mutate()}
          >
            {solicitar.isPending && <Loader2 className="animate-spin" />}
            Solicitar reserva · {brl(Number(disp.preco_total))}
          </Button>
        )}
        {podeEsperar && inicio && fim && (
          <Button
            size="lg"
            variant={naFila ? "outline" : "default"}
            className="w-full"
            disabled={fila.isPending}
            onClick={() => fila.mutate({ courtId, inicio, fim, sair: !!naFila })}
          >
            {naFila ? <BellOff /> : <BellPlus />}
            {naFila ? "Sair da fila" : "Entrar na fila e ser avisado se vagar"}
          </Button>
        )}
        {wa && (
          <Button asChild variant="outline" size="lg" className="w-full">
            <a href={wa} target="_blank" rel="noreferrer">
              <MessageCircle /> Falar com a quadra no WhatsApp
            </a>
          </Button>
        )}
      </div>
    </div>
  );
}
