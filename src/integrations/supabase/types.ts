export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.18"
  }
  public: {
    Tables: {
      bookings: {
        Row: {
          created_at: string
          expires_at: string
          from_waitlist: boolean
          id: string
          organizer_id: string
          slot_id: string
          status: Database["public"]["Enums"]["booking_status"]
          updated_at: string
        }
        Insert: {
          created_at?: string
          expires_at: string
          from_waitlist?: boolean
          id?: string
          organizer_id: string
          slot_id: string
          status?: Database["public"]["Enums"]["booking_status"]
          updated_at?: string
        }
        Update: {
          created_at?: string
          expires_at?: string
          from_waitlist?: boolean
          id?: string
          organizer_id?: string
          slot_id?: string
          status?: Database["public"]["Enums"]["booking_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "bookings_slot_id_fkey"
            columns: ["slot_id"]
            isOneToOne: false
            referencedRelation: "slots"
            referencedColumns: ["id"]
          },
        ]
      }
      courts: {
        Row: {
          active: boolean
          created_at: string
          id: string
          name: string
          photo_url: string | null
          price_per_hour: number
          surface: string
          venue_id: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          id?: string
          name: string
          photo_url?: string | null
          price_per_hour?: number
          surface?: string
          venue_id: string
        }
        Update: {
          active?: boolean
          created_at?: string
          id?: string
          name?: string
          photo_url?: string | null
          price_per_hour?: number
          surface?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "courts_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      notifications: {
        Row: {
          created_at: string
          id: string
          link: string | null
          message: string
          read: boolean
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          link?: string | null
          message: string
          read?: boolean
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          link?: string | null
          message?: string
          read?: boolean
          user_id?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          created_at: string
          email: string
          id: string
          name: string
          phone: string
          privacy_accepted_at: string | null
        }
        Insert: {
          created_at?: string
          email?: string
          id: string
          name?: string
          phone?: string
          privacy_accepted_at?: string | null
        }
        Update: {
          created_at?: string
          email?: string
          id?: string
          name?: string
          phone?: string
          privacy_accepted_at?: string | null
        }
        Relationships: []
      }
      slots: {
        Row: {
          block_note: string | null
          blocked: boolean
          court_id: string
          created_at: string
          duration_min: number
          id: string
          published: boolean
          starts_at: string
        }
        Insert: {
          block_note?: string | null
          blocked?: boolean
          court_id: string
          created_at?: string
          duration_min?: number
          id?: string
          published?: boolean
          starts_at: string
        }
        Update: {
          block_note?: string | null
          blocked?: boolean
          court_id?: string
          created_at?: string
          duration_min?: number
          id?: string
          published?: boolean
          starts_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "slots_court_id_fkey"
            columns: ["court_id"]
            isOneToOne: false
            referencedRelation: "courts"
            referencedColumns: ["id"]
          },
        ]
      }
      user_roles: {
        Row: {
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      venues: {
        Row: {
          address: string
          cancel_limit_hours: number
          close_hour: number
          created_at: string
          id: string
          name: string
          open_hour: number
          payment_deadline_hours: number
          pix_key: string
          whatsapp: string
        }
        Insert: {
          address?: string
          cancel_limit_hours?: number
          close_hour?: number
          created_at?: string
          id?: string
          name?: string
          open_hour?: number
          payment_deadline_hours?: number
          pix_key?: string
          whatsapp?: string
        }
        Update: {
          address?: string
          cancel_limit_hours?: number
          close_hour?: number
          created_at?: string
          id?: string
          name?: string
          open_hour?: number
          payment_deadline_hours?: number
          pix_key?: string
          whatsapp?: string
        }
        Relationships: []
      }
      waitlist: {
        Row: {
          created_at: string
          id: string
          notified_at: string | null
          organizer_id: string
          slot_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          notified_at?: string | null
          organizer_id: string
          slot_id: string
        }
        Update: {
          created_at?: string
          id?: string
          notified_at?: string | null
          organizer_id?: string
          slot_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "waitlist_slot_id_fkey"
            columns: ["slot_id"]
            isOneToOne: false
            referencedRelation: "slots"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      cancel_booking: { Args: { _booking: string }; Returns: undefined }
      confirm_booking: { Args: { _booking: string }; Returns: undefined }
      expire_bookings: { Args: never; Returns: number }
      generate_week: { Args: { _monday: string }; Returns: number }
      get_agenda: {
        Args: { _day: string }
        Returns: {
          court_id: string
          court_name: string
          in_waitlist: boolean
          my_booking_id: string
          my_booking_status: Database["public"]["Enums"]["booking_status"]
          photo_url: string
          price: number
          slot_id: string
          starts_at: string
          state: string
          surface: string
        }[]
      }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      notify_waitlist: { Args: { _slot: string }; Returns: undefined }
      publish_week: {
        Args: { _monday: string; _publish?: boolean }
        Returns: undefined
      }
      reject_booking: { Args: { _booking: string }; Returns: undefined }
      request_booking: { Args: { _slot: string }; Returns: string }
      set_slot_blocked: {
        Args: { _blocked: boolean; _note?: string; _slot: string }
        Returns: undefined
      }
      slot_label: { Args: { _slot: string }; Returns: string }
    }
    Enums: {
      app_role: "gestor" | "organizador"
      booking_status:
        | "pendente"
        | "confirmada"
        | "recusada"
        | "expirada"
        | "cancelada"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["gestor", "organizador"],
      booking_status: [
        "pendente",
        "confirmada",
        "recusada",
        "expirada",
        "cancelada",
      ],
    },
  },
} as const
