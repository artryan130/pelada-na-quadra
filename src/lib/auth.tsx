import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

type Role = "gestor" | "organizador";
type Profile = { id: string; name: string; phone: string; email: string };
type AuthState = {
  session: Session | null;
  role: Role | null;
  profile: Profile | null;
  loading: boolean;
  signOut: () => Promise<void>;
};

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [role, setRole] = useState<Role | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async (s: Session | null) => {
      setSession(s);
      if (!s) {
        setRole(null);
        setProfile(null);
        setLoading(false);
        return;
      }
      const [{ data: roles }, { data: prof }] = await Promise.all([
        supabase.from("user_roles").select("role").eq("user_id", s.user.id),
        supabase.from("profiles").select("id,name,phone,email").eq("id", s.user.id).maybeSingle(),
      ]);
      const rs = (roles ?? []).map((r) => r.role);
      setRole(rs.includes("gestor") ? "gestor" : rs.length ? "organizador" : null);
      setProfile(prof ?? null);
      setLoading(false);
    };
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      setTimeout(() => load(s), 0);
    });
    supabase.auth.getSession().then(({ data }) => load(data.session));
    return () => sub.subscription.unsubscribe();
  }, []);

  return (
    <Ctx.Provider value={{ session, role, profile, loading, signOut: async () => void (await supabase.auth.signOut()) }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAuth() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useAuth outside AuthProvider");
  return c;
}
