import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/privacidade")({
  head: () => ({ meta: [{ title: "Aviso de privacidade · Bate-Bola" }] }),
  component: Privacy,
});

function Privacy() {
  return (
    <div className="mx-auto max-w-2xl px-5 py-10">
      <Link to="/" className="font-display text-lg font-black tracking-tight">
        BATE<span className="text-primary">·</span>BOLA
      </Link>
      <h1 className="mt-8 text-3xl font-black">Aviso de privacidade</h1>
      <div className="mt-6 space-y-4 text-sm leading-relaxed text-foreground/85">
        <p>
          O Bate-Bola é um piloto para reservar quadras de society sem precisar trocar mensagens.
          Para isso, tratamos alguns dados pessoais, de acordo com a Lei Geral de Proteção de Dados
          (LGPD, Lei 13.709/2018).
        </p>
        <h2 className="pt-2 text-lg font-bold">Quais dados coletamos</h2>
        <p>
          Nome, telefone e e-mail informados no cadastro, e o histórico das suas reservas e filas de
          espera.
        </p>
        <h2 className="pt-2 text-lg font-bold">Para que usamos</h2>
        <p>
          Para identificar quem fez cada reserva, permitir que a quadra confirme o pagamento e entre
          em contato com você, e para enviar avisos sobre suas reservas e horários que vagaram.
        </p>
        <h2 className="pt-2 text-lg font-bold">Com quem compartilhamos</h2>
        <p>
          Apenas com a equipe da quadra onde você reserva. Não vendemos nem compartilhamos seus
          dados com terceiros para publicidade. O pagamento é feito direto com a quadra, fora do
          app.
        </p>
        <h2 className="pt-2 text-lg font-bold">Seus direitos</h2>
        <p>
          Você pode pedir a qualquer momento acesso, correção ou exclusão dos seus dados falando com
          a quadra. Ao fim do piloto, os dados podem ser apagados ou anonimizados.
        </p>
      </div>
    </div>
  );
}
