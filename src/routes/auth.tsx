import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { errMsg } from "@/lib/time";
import { formatCnpj, isValidCnpj, normalizeCnpj } from "@/lib/cnpj";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

type Mode = "login" | "signup";

export const Route = createFileRoute("/auth")({
  validateSearch: (s: Record<string, unknown>): { mode: Mode } => ({
    mode: s["mode"] === "signup" ? "signup" : "login",
  }),
  head: () => ({ meta: [{ title: "Entrar · Bate-Bola" }] }),
  component: AuthPage,
});

const AUTH_ERRORS: Record<string, string> = {
  "Invalid login credentials": "E-mail ou senha incorretos.",
  "User already registered": "Esse e-mail já tem conta. Entre com sua senha.",
  "Email not confirmed": "Confirme seu e-mail pelo link que enviamos antes de entrar.",
  // The signup trigger rejects an invalid or duplicate CNPJ, and Supabase reports it generically.
  "Database error saving new user":
    "Não foi possível criar a conta. Confira o CNPJ: ele precisa ser válido e não pode já ter um local cadastrado.",
};

function AuthPage() {
  const { mode } = Route.useSearch();
  const navigate = useNavigate();
  const { session, role, profile, loading, signOut } = useAuth();
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [form, setForm] = useState({
    role: "organizador" as "organizador" | "gestor",
    venueName: "",
    cnpj: "",
    name: "",
    phone: "",
    email: "",
    password: "",
    privacy: false,
  });
  const set =
    (k: "venueName" | "name" | "phone" | "email" | "password") =>
    (e: { target: { value: string } }) =>
      setForm({ ...form, [k]: e.target.value });
  const cnpjComplete = normalizeCnpj(form.cnpj).length === 14;
  const cnpjOk = isValidCnpj(form.cnpj);

  // On the signup screen a signed-in user is offered to sign out instead, so a second
  // account (e.g. an organizer to test with) can be created from the same browser.
  const signedInElsewhere = mode === "signup" && !!session && !sent;
  useEffect(() => {
    if (mode === "login" && !loading && session && role)
      navigate({ to: role === "gestor" ? "/gestor" : "/buscar" });
  }, [mode, loading, session, role, navigate]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (mode === "login") {
        const { error } = await supabase.auth.signInWithPassword({
          email: form.email.trim(),
          password: form.password,
        });
        if (error) throw error;
      } else {
        if (!form.privacy) throw new Error("Aceite o aviso de privacidade para continuar.");
        if (form.phone.replace(/\D/g, "").length < 10)
          throw new Error("Informe o telefone com DDD.");
        if (form.role === "gestor") {
          if (!isValidCnpj(form.cnpj)) throw new Error("CNPJ inválido. Confira os números.");
          const { data: inUse, error: cnpjError } = await supabase.rpc("cnpj_in_use", {
            _cnpj: form.cnpj,
          });
          if (cnpjError) throw cnpjError;
          if (inUse) throw new Error("Esse CNPJ já tem um local cadastrado.");
        }
        const { data, error } = await supabase.auth.signUp({
          email: form.email.trim(),
          password: form.password,
          options: {
            emailRedirectTo: window.location.origin + "/auth",
            data: {
              name: form.name.trim(),
              phone: form.phone.trim(),
              privacy: "true",
              role: form.role,
              ...(form.role === "gestor"
                ? { venue_name: form.venueName.trim(), cnpj: normalizeCnpj(form.cnpj) }
                : {}),
            },
          },
        });
        if (error) throw error;
        if (!data.session) setSent(true);
      }
    } catch (err) {
      const m = errMsg(err);
      toast.error(AUTH_ERRORS[m] ?? m);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-pitch-gradient text-pitch-foreground">
      <div className="pitch-lines min-h-screen">
        <div className="mx-auto flex min-h-screen max-w-md flex-col px-6 py-8">
          <Link to="/" className="font-display text-xl font-black tracking-tight">
            BATE<span className="text-accent">·</span>BOLA
          </Link>
          <div className="mt-10 rounded-2xl bg-card p-6 text-card-foreground shadow-card">
            {sent ? (
              <div className="space-y-3 text-center">
                <h1 className="text-2xl font-black">Confira seu e-mail</h1>
                <p className="text-sm text-muted-foreground">
                  Enviamos um link para <strong>{form.email}</strong>. Toque nele para ativar a
                  conta e voltar aqui.
                </p>
              </div>
            ) : signedInElsewhere ? (
              <div className="space-y-4">
                <h1 className="text-2xl font-black">Você já está conectado</h1>
                <p className="text-sm text-muted-foreground">
                  Entrou como <strong>{profile?.name || profile?.email}</strong>
                  {role === "gestor" ? " (gestor de quadra)" : " (organizador)"}. Para criar outra
                  conta, saia desta primeiro.
                </p>
                <div className="grid gap-2">
                  <Button size="lg" onClick={() => signOut()}>
                    Sair e criar nova conta
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => navigate({ to: role === "gestor" ? "/gestor" : "/buscar" })}
                  >
                    Continuar com esta conta
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <h1 className="text-2xl font-black">
                  {mode === "login" ? "Entrar" : "Criar conta"}
                </h1>
                <p className="mt-1 text-sm text-muted-foreground">
                  {mode === "login"
                    ? "Organizadores e gestores da quadra entram por aqui."
                    : "Leva menos de um minuto. Usamos seu telefone só para a quadra falar com você."}
                </p>
                <form onSubmit={submit} className="mt-6 space-y-4">
                  {mode === "signup" && (
                    <>
                      <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Perfil">
                        {(
                          [
                            ["organizador", "Organizo pelada", "Quero reservar horários"],
                            ["gestor", "Tenho quadra", "Quero gerenciar minha agenda"],
                          ] as const
                        ).map(([value, title, hint]) => (
                          <button
                            key={value}
                            type="button"
                            role="radio"
                            aria-checked={form.role === value}
                            onClick={() => setForm({ ...form, role: value })}
                            className={cn(
                              "rounded-xl border p-3 text-left transition-colors",
                              form.role === value &&
                                "border-primary bg-primary/5 ring-1 ring-primary",
                            )}
                          >
                            <div className="text-sm font-bold">{title}</div>
                            <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>
                          </button>
                        ))}
                      </div>
                      {form.role === "gestor" && (
                        <Field id="venue" label="Nome do local">
                          <Input
                            id="venue"
                            required
                            placeholder="Ex.: Arena Pampulha"
                            value={form.venueName}
                            onChange={set("venueName")}
                          />
                        </Field>
                      )}
                      {form.role === "gestor" && (
                        <Field id="cnpj" label="CNPJ do local">
                          <Input
                            id="cnpj"
                            required
                            autoCapitalize="characters"
                            placeholder="00.000.000/0000-00"
                            value={form.cnpj}
                            onChange={(e) => setForm({ ...form, cnpj: formatCnpj(e.target.value) })}
                            aria-invalid={cnpjComplete && !cnpjOk}
                          />
                          {cnpjComplete && (
                            <p
                              className={cn(
                                "text-xs",
                                cnpjOk ? "text-success" : "text-destructive",
                              )}
                            >
                              {cnpjOk ? "CNPJ válido" : "CNPJ inválido. Confira os números."}
                            </p>
                          )}
                        </Field>
                      )}
                      <Field id="name" label="Seu nome">
                        <Input
                          id="name"
                          required
                          autoComplete="name"
                          value={form.name}
                          onChange={set("name")}
                        />
                      </Field>
                      <Field id="phone" label="Telefone (WhatsApp)">
                        <Input
                          id="phone"
                          required
                          type="tel"
                          inputMode="tel"
                          autoComplete="tel"
                          placeholder="(31) 91234-5678"
                          value={form.phone}
                          onChange={set("phone")}
                        />
                      </Field>
                    </>
                  )}
                  <Field id="email" label="E-mail">
                    <Input
                      id="email"
                      required
                      type="email"
                      autoComplete="email"
                      value={form.email}
                      onChange={set("email")}
                    />
                  </Field>
                  <Field id="password" label="Senha">
                    <Input
                      id="password"
                      required
                      type="password"
                      minLength={6}
                      autoComplete={mode === "login" ? "current-password" : "new-password"}
                      value={form.password}
                      onChange={set("password")}
                    />
                  </Field>
                  {mode === "signup" && (
                    <label className="flex items-start gap-3 text-sm">
                      <Checkbox
                        className="mt-0.5"
                        checked={form.privacy}
                        onCheckedChange={(v) => setForm({ ...form, privacy: v === true })}
                      />
                      <span>
                        Li e aceito o{" "}
                        <Link
                          to="/privacidade"
                          target="_blank"
                          className="font-semibold text-primary underline"
                        >
                          aviso de privacidade
                        </Link>
                        .
                      </span>
                    </label>
                  )}
                  <Button type="submit" size="lg" className="w-full" disabled={busy}>
                    {busy && <Loader2 className="animate-spin" />}
                    {mode === "login" ? "Entrar" : "Criar conta"}
                  </Button>
                </form>
                <p className="mt-5 text-center text-sm text-muted-foreground">
                  {mode === "login" ? "Ainda não tem conta? " : "Já tem conta? "}
                  <Link
                    to="/auth"
                    search={{ mode: mode === "login" ? "signup" : "login" }}
                    className="font-semibold text-primary"
                  >
                    {mode === "login" ? "Cadastre-se" : "Entrar"}
                  </Link>
                </p>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}
