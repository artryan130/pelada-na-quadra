import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { CalendarCheck, Clock, BellRing } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Bate-Bola · Reserve sua quadra de society sem WhatsApp" },
      { name: "description", content: "Veja os horários livres das quadras e solicite sua reserva em poucos toques. Pagamento por Pix direto com a quadra." },
      { property: "og:title", content: "Bate-Bola · Reserve sua quadra de society" },
      { property: "og:description", content: "Horários livres, reserva em poucos toques e fila de espera para a sua pelada." },
    ],
  }),
  component: Index,
});

function Index() {
  const { session, role, loading } = useAuth();
  const navigate = useNavigate();
  useEffect(() => {
    if (!loading && session && role) navigate({ to: role === "gestor" ? "/gestor" : "/buscar" });
  }, [loading, session, role, navigate]);

  return (
    <div className="min-h-screen bg-pitch-gradient text-pitch-foreground">
      <div className="pitch-lines min-h-screen">
        <div className="mx-auto flex min-h-screen max-w-md flex-col px-6 py-10">
          <div className="font-display text-xl font-black tracking-tight">
            BATE<span className="text-accent">·</span>BOLA
          </div>
          <div className="flex flex-1 flex-col justify-center">
            <h1 className="text-5xl font-black leading-[0.95]">
              Sua pelada,<br />sem mandar<br /><span className="text-accent">mensagem.</span>
            </h1>
            <p className="mt-5 text-lg opacity-80">
              Veja os horários livres das quadras de BH, solicite a reserva e pague por Pix direto com a quadra.
            </p>
            <ul className="mt-8 space-y-3 text-sm">
              <li className="flex items-center gap-3"><CalendarCheck className="size-5 text-accent" /> Agenda sempre atualizada pelo dono</li>
              <li className="flex items-center gap-3"><Clock className="size-5 text-accent" /> Horário segurado enquanto você paga</li>
              <li className="flex items-center gap-3"><BellRing className="size-5 text-accent" /> Fila de espera avisa quando vagar</li>
            </ul>
          </div>
          <div className="space-y-3">
            <Button asChild size="lg" variant="accent" className="w-full">
              <Link to="/auth" search={{ mode: "signup" }}>Criar conta grátis</Link>
            </Button>
            <Button asChild size="lg" variant="ghostLight" className="w-full">
              <Link to="/auth" search={{ mode: "login" }}>Já tenho conta</Link>
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
