// ParkNear configuration — Live Mode (Supabase).
// The anon key is safe to publish in frontend code; row-level policies in
// supabase-schema.sql control access. Project: parknear (us-east-1, Free).
window.PARK_CONFIG = {
  supabaseUrl: "https://wqihvxzmpmxbzkopjkzl.supabase.co",
  supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndxaWh2eHptcG14Ynprb3Bqa3psIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI1MDk4OTQsImV4cCI6MjEwODA4NTg5NH0.I9Qnpo4bmlhdjpaLBZ3zom0G-T8yNbKZdUDZCgr6jTA",
  // Automatic detail emails via EmailJS — filled in when the free EmailJS
  // account is connected. Until then, confirmations offer a one-tap
  // "email it to myself" button and every email address is stored.
  emailjs: { publicKey: "", serviceId: "", templateId: "" }
};
